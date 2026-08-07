/**
 * TapFlow Worker — WorkerStore 存储接口 + 内存实现
 * 职责：Job 原子领取 / 完成（running→succeeded + 输出资产）/ 失败 / 取消终态
 * 状态转换遵循 03 契约 §2 合法转换表（全部为条件更新，胜者判定）。
 * Supabase 实现见 supabaseWorkerStore.ts。
 */
import { randomUUID } from 'node:crypto';

import type { Job, Uuid } from '@tapflow/contracts';

import type { ProviderOutput } from './provider.ts';

/** 完成 Job 时写入的输出资产（对应 generation_job_outputs 行） */
export type JobOutput = {
  id: Uuid;
  assetId: Uuid;
  ordinal: number;
  url: string;
  mimeType: string;
  width: number | null;
  height: number | null;
};

export interface WorkerStore {
  /** 原子领取下一个 queued Job（03 契约 §2：queued→running，仅一个 Worker 胜出） */
  claimNext(): Promise<Job | null>;
  /** 领取后回填 provider_job_id（03 契约 §7：running 后必填） */
  setProviderJobId(jobId: string, providerJobId: string): Promise<void>;
  /** running→succeeded + 写输出资产（同一事务；ordinal 唯一约束防重复 Asset） */
  complete(jobId: string, outputs: ProviderOutput[]): Promise<{ job: Job; outputs: JobOutput[] }>;
  /** running→failed（不可重试/重试耗尽），写入脱敏错误 */
  fail(jobId: string, errorCode: string, errorMessage: string): Promise<Job>;
  /** 列出所有 cancel_requested Job（供取消确认/超时判定） */
  listCancelRequested(): Promise<Job[]>;
  /** cancel_requested→cancelled（取消确认成功或超时判定） */
  resolveCancel(jobId: string): Promise<Job>;
  /** cancel_requested→running（取消失败，任务恢复执行） */
  rollbackCancel(jobId: string): Promise<Job>;
  get(jobId: string): Promise<Job>;
}

export class JobNotFoundError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Job ${jobId} was not found`);
    this.name = 'JobNotFoundError';
    this.jobId = jobId;
  }
}

export class JobStateTransitionError extends Error {
  readonly jobId: string;
  readonly from: string;

  constructor(jobId: string, from: string) {
    super(`Invalid state transition for job ${jobId} from '${from}'`);
    this.name = 'JobStateTransitionError';
    this.jobId = jobId;
    this.from = from;
  }
}

type JobRow = { job: Job };

export class InMemoryWorkerStore implements WorkerStore {
  private readonly jobs = new Map<string, JobRow>();
  private readonly outputs = new Map<string, JobOutput[]>();
  private readonly claimLock = new Set<string>();

  seed(job: Job): void {
    this.jobs.set(job.id, { job });
  }

  async claimNext(): Promise<Job | null> {
    // 模拟原子领取：单线程环境下 claimLock 防重复领取同一 job
    const candidate = [...this.jobs.values()]
      .map((row) => row.job)
      .filter((job) => job.status === 'queued' && !this.claimLock.has(job.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!candidate) {
      return null;
    }
    this.claimLock.add(candidate.id);
    candidate.status = 'running';
    candidate.providerJobId = null; // provider submit 后由 runner 回填
    candidate.updatedAt = new Date().toISOString();
    return candidate;
  }

  /** 领取后由 runner 回填 provider_job_id（InMemory 无独立事务边界，直接更新） */
  async setProviderJobId(jobId: string, providerJobId: string): Promise<void> {
    const row = this.jobs.get(jobId);
    if (row) {
      row.job.providerJobId = providerJobId;
      row.job.updatedAt = new Date().toISOString();
    }
  }

  async complete(jobId: string, outputs: ProviderOutput[]): Promise<{ job: Job; outputs: JobOutput[] }> {
    const row = this.jobs.get(jobId);
    if (!row) {
      throw new JobNotFoundError(jobId);
    }
    if (row.job.status !== 'running') {
      throw new JobStateTransitionError(jobId, row.job.status);
    }
    const now = new Date().toISOString();
    row.job.status = 'succeeded';
    row.job.finishedAt = now;
    row.job.updatedAt = now;
    const written: JobOutput[] = outputs.map((output, index) => ({
      id: randomUUID() as Uuid,
      assetId: randomUUID() as Uuid,
      ordinal: index,
      url: output.url,
      mimeType: output.mimeType,
      width: output.width ?? null,
      height: output.height ?? null,
    }));
    this.outputs.set(jobId, written);
    this.claimLock.delete(jobId);
    return { job: row.job, outputs: written };
  }

  async fail(jobId: string, errorCode: string, errorMessage: string): Promise<Job> {
    const row = this.jobs.get(jobId);
    if (!row) {
      throw new JobNotFoundError(jobId);
    }
    if (row.job.status !== 'running') {
      throw new JobStateTransitionError(jobId, row.job.status);
    }
    const now = new Date().toISOString();
    row.job.status = 'failed';
    row.job.errorCode = errorCode;
    row.job.errorMessage = errorMessage;
    row.job.finishedAt = now;
    row.job.updatedAt = now;
    this.claimLock.delete(jobId);
    return row.job;
  }

  async listCancelRequested(): Promise<Job[]> {
    return [...this.jobs.values()]
      .map((row) => row.job)
      .filter((job) => job.status === 'cancel_requested')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async resolveCancel(jobId: string): Promise<Job> {
    const row = this.jobs.get(jobId);
    if (!row) {
      throw new JobNotFoundError(jobId);
    }
    if (row.job.status !== 'cancel_requested') {
      throw new JobStateTransitionError(jobId, row.job.status);
    }
    const now = new Date().toISOString();
    row.job.status = 'cancelled';
    row.job.errorCode = 'CANCELLED';
    row.job.errorMessage = 'cancelled by user';
    row.job.finishedAt = now;
    row.job.updatedAt = now;
    return row.job;
  }

  async rollbackCancel(jobId: string): Promise<Job> {
    const row = this.jobs.get(jobId);
    if (!row) {
      throw new JobNotFoundError(jobId);
    }
    if (row.job.status !== 'cancel_requested') {
      throw new JobStateTransitionError(jobId, row.job.status);
    }
    row.job.status = 'running';
    row.job.cancelRequestedAt = null;
    row.job.updatedAt = new Date().toISOString();
    return row.job;
  }

  async get(jobId: string): Promise<Job> {
    const row = this.jobs.get(jobId);
    if (!row) {
      throw new JobNotFoundError(jobId);
    }
    return row.job;
  }

  getOutputs(jobId: string): JobOutput[] {
    return this.outputs.get(jobId) ?? [];
  }
}
