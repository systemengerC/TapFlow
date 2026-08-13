/**
 * TapFlow API — Embedded Worker（dev/内存模式联调专用）
 * 内存模式下 API 与 Worker 各自持有独立 InMemory store，任务无法互通。
 * 本模块把 API 创建的 Job seed 进 Worker 的 InMemoryWorkerStore（共享同一对象引用），
 * 并在 API 进程内启动 Runner + FakeProvider，让 queued→running→succeeded 全链路
 * 在单进程内可见。
 * 仅内存模式（未配 SUPABASE_URL）启用；Supabase 模式走独立 worker 进程 + 共享数据库。
 */
import { FakeProvider, type ProviderRegistry } from '../../worker/src/provider.ts';
import { Runner } from '../../worker/src/runner.ts';
import { InMemoryWorkerStore, type WorkerStore } from '../../worker/src/workerStore.ts';
import type { CancelJobResponse, CreateJobRequest, CreateJobResponse, Job, ListJobsResponse } from '@tapflow/contracts';

import type { JobRepository } from './jobRepository.ts';

/** 包装 JobRepository：create 时把新 Job seed 进 worker store（共享对象引用） */
export class EmbeddedWorkerJobRepository implements JobRepository {
  private readonly inner: JobRepository;
  private readonly workerStore: InMemoryWorkerStore;

  constructor(inner: JobRepository, workerStore: InMemoryWorkerStore) {
    this.inner = inner;
    this.workerStore = workerStore;
  }

  async create(request: CreateJobRequest, authorization?: string): Promise<CreateJobResponse> {
    const result = await this.inner.create(request, authorization);
    // 幂等重放不重复 seed（同一对象，已 seed）
    if (!result.idempotentReplay) {
      this.workerStore.seed(result.job);
    }
    return result;
  }

  listByProject(projectId: string, authorization?: string): Promise<ListJobsResponse> {
    return this.inner.listByProject(projectId, authorization);
  }

  get(jobId: string, authorization?: string): Promise<Job> {
    return this.inner.get(jobId, authorization);
  }

  getOutputs(jobId: string, authorization?: string): Promise<import('./jobRepository.ts').JobOutput[]> {
    return this.inner.getOutputs(jobId, authorization);
  }

  cancel(jobId: string, authorization?: string): Promise<CancelJobResponse> {
    // cancel 修改的是 InMemoryJobRepository 内的 job 对象；seed 共享同一引用，
    // workerStore 自动可见 cancel_requested 状态，Runner 的取消确认流程可继续。
    return this.inner.cancel(jobId, authorization);
  }
}

/** 启动内嵌 worker（返回 Runner 供关闭）；store 为 WorkerStore 接口，内存/Supabase 均可驱动 */
export function startEmbeddedWorker(store: WorkerStore): Runner {
  const providers: ProviderRegistry = new Map();
  const fake = new FakeProvider();
  for (const jobType of fake.jobTypes) {
    providers.set(jobType, fake);
  }

  const runner = new Runner(
    store,
    providers,
    {
      emit(event) {
        const extra = 'assetIds' in event ? ` assetIds=${JSON.stringify(event.assetIds)}` : '';
        console.log(`[embedded-worker] ${event.type} job=${event.jobId}${extra}`);
      },
    },
    { pollIntervalMs: 500, statusIntervalMs: 300 },
  );
  runner.start();
  return runner;
}
