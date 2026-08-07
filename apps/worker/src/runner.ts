/**
 * TapFlow Worker — Runner
 * 轮询循环：
 *   1. 处理 cancel_requested（03 契约 §4.1 步骤 3：确认成功→cancelled / 失败→回退 running）
 *   2. 原子领取 queued Job → provider.submit → 指数退避轮询 getStatus → complete/fail
 * 事件：JobStatusEvent（03 契约 §8），通过 EventSink 发出。
 */
import type { Job, JobStatusEvent, JobType, Uuid } from '@tapflow/contracts';

import type { GenerationProvider, ProviderRegistry } from './provider.ts';
import type { WorkerStore } from './workerStore.ts';
import { JobNotFoundError, JobStateTransitionError } from './workerStore.ts';

export type EventSink = {
  emit(event: JobStatusEvent): void;
};

export type RunnerOptions = {
  /** 轮询间隔（ms），默认 2000 */
  pollIntervalMs?: number;
  /** provider getStatus 轮询间隔（ms），默认 500 */
  statusIntervalMs?: number;
  /** 最大轮询次数（可重试错误重试上限 03 契约 §5：3 次），默认 3 */
  maxStatusAttempts?: number;
  /** cancel_requested 确认超时（ms），默认 60_000（03 契约 §4.3 规则 2） */
  cancelConfirmTimeoutMs?: number;
};

export class Runner {
  private readonly store: WorkerStore;
  private readonly providers: ProviderRegistry;
  private readonly events: EventSink;
  private readonly opts: Required<RunnerOptions>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(store: WorkerStore, providers: ProviderRegistry, events: EventSink, opts: RunnerOptions = {}) {
    this.store = store;
    this.providers = providers;
    this.events = events;
    this.opts = {
      pollIntervalMs: opts.pollIntervalMs ?? 2_000,
      statusIntervalMs: opts.statusIntervalMs ?? 500,
      maxStatusAttempts: opts.maxStatusAttempts ?? 3,
      cancelConfirmTimeoutMs: opts.cancelConfirmTimeoutMs ?? 60_000,
    };
  }

  /** 执行一轮：返回本轮回处理过的 Job 数（含取消确认与领取执行） */
  async runOnce(): Promise<number> {
    let handled = 0;
    handled += await this.processCancellations();
    while (true) {
      const job = await this.store.claimNext();
      if (!job) {
        break;
      }
      handled += 1;
      await this.execute(job).catch((error) => {
        // 执行异常不中断循环；记录为 failed（条件更新，失败无副作用）
        const message = error instanceof Error ? error.message : String(error);
        return this.store.fail(job.id, 'INTERNAL_ERROR', `worker execution error: ${message}`).catch(() => undefined);
      });
    }
    return handled;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const tick = async () => {
      if (!this.running) {
        return;
      }
      try {
        await this.runOnce();
      } catch (error) {
        console.error('[worker] runOnce failed:', error);
      }
      this.timer = setTimeout(tick, this.opts.pollIntervalMs);
      if (this.timer.unref) {
        this.timer.unref();
      }
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // -------------------------------------------------------------------------

  private async processCancellations(): Promise<number> {
    const pending = await this.store.listCancelRequested();
    let handled = 0;
    for (const job of pending) {
      const provider = this.providerFor(job);
      const requestedAt = job.cancelRequestedAt ? Date.parse(job.cancelRequestedAt) : 0;
      const timedOut = Date.now() - requestedAt >= this.opts.cancelConfirmTimeoutMs;
      try {
        if (provider?.cancel && !timedOut) {
          // 供应商异步取消：等待确认；超时判定（请求已 2xx 提交 → 转 cancelled）
          await provider.cancel(job.providerJobId ?? '');
        }
        const result = await this.store.resolveCancel(job.id);
        this.events.emit({ type: 'job.cancelled', jobId: result.id as Uuid });
        handled += 1;
      } catch {
        // 取消失败且未超时：恢复执行
        if (!timedOut) {
          try {
            const restored = await this.store.rollbackCancel(job.id);
            this.events.emit({ type: 'job.running', jobId: restored.id as Uuid });
            handled += 1;
          } catch (error) {
            if (!(error instanceof JobStateTransitionError)) {
              throw error;
            }
          }
        }
      }
    }
    return handled;
  }

  private async execute(job: Job): Promise<void> {
    this.events.emit({ type: 'job.running', jobId: job.id as Uuid });

    const provider = this.providerFor(job);
    if (!provider) {
      await this.store.fail(job.id, 'PROVIDER_UNAVAILABLE', `no provider for job type '${job.jobType}'`);
      this.events.emit({
        type: 'job.failed',
        jobId: job.id as Uuid,
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: `no provider for job type '${job.jobType}'`,
      });
      return;
    }

    // 提交（01 契约：提交失败按错误分类处理）
    let providerJobId: string;
    try {
      const submission = await provider.submit(job);
      providerJobId = submission.providerJobId;
    } catch (error) {
      await this.failJob(job.id, 'PROVIDER_UNAVAILABLE', errorMessage(error));
      return;
    }

    // 回填 provider_job_id（running 后必填，03 契约 §7）
    await this.store.setProviderJobId(job.id, providerJobId);

    // 指数退避轮询（03 契约 §5：重试上限 3 次，封顶退避 60s）
    for (let attempt = 0; attempt <= this.opts.maxStatusAttempts; attempt += 1) {
      await sleep(this.opts.statusIntervalMs * 2 ** attempt);
      let status;
      try {
        status = await provider.getStatus(providerJobId);
      } catch (error) {
        await this.failJob(job.id, 'PROVIDER_UNAVAILABLE', errorMessage(error));
        return;
      }

      if (status.status === 'succeeded') {
        const outputs = status.outputs ?? [];
        try {
          const { job: completed, outputs: written } = await this.store.complete(job.id, outputs);
          this.events.emit({
            type: 'job.succeeded',
            jobId: completed.id as Uuid,
            assetIds: written.map((output) => output.assetId),
          });
        } catch (error) {
          if (error instanceof JobStateTransitionError) {
            // 已完成/取消抢先：忽略迟到完成（03 契约 §4.3 规则 1）
            return;
          }
          await this.failJob(job.id, 'ASSET_TRANSFER_FAILED', errorMessage(error));
        }
        return;
      }

      if (status.status === 'failed') {
        const error = status.error ?? { code: 'PROVIDER_UNAVAILABLE', message: 'provider failed', category: 'retryable' as const };
        if (error.category === 'retryable' && attempt < this.opts.maxStatusAttempts) {
          continue; // 指数退避重试
        }
        await this.failJob(job.id, error.code, error.message);
        return;
      }
    }
  }

  private async failJob(jobId: string, errorCode: string, errorMessage: string): Promise<void> {
    try {
      const failed = await this.store.fail(jobId, errorCode, errorMessage);
      this.events.emit({ type: 'job.failed', jobId: failed.id as Uuid, errorCode, errorMessage });
    } catch (error) {
      if (error instanceof JobStateTransitionError || error instanceof JobNotFoundError) {
        return; // 终态/已取消：忽略
      }
      throw error;
    }
  }

  private providerFor(job: Job): GenerationProvider | undefined {
    return this.providers.get(job.jobType as JobType);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
