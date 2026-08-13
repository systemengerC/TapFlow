/**
 * Generation Job 存储接口 + 内存实现
 * P0 范围：创建（幂等键）/ 列表 / 详情 / 取消（03 契约 §4 三步流程）
 * Supabase 实现见 supabaseJobRepository.ts
 */
import { randomUUID } from 'node:crypto';

import {
  type CancelJobResponse,
  type CreateJobRequest,
  type CreateJobResponse,
  type Job,
  type JobStatus,
  type ListJobsResponse,
  type Uuid,
} from '@tapflow/contracts';

export interface JobRepository {
  create(request: CreateJobRequest, authorization?: string): Promise<CreateJobResponse>;
  listByProject(projectId: string, authorization?: string): Promise<ListJobsResponse>;
  get(jobId: string, authorization?: string): Promise<Job>;
  /** Job 输出资产链接行（generation_job_outputs，按 ordinal 升序）；无输出返回 [] */
  getOutputs(jobId: string, authorization?: string): Promise<JobOutput[]>;
  cancel(jobId: string, authorization?: string): Promise<CancelJobResponse>;
}

export type JobOutput = {
  assetId: Uuid;
  ordinal: number;
};

export class JobNotFoundError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Generation job ${jobId} was not found`);
    this.name = 'JobNotFoundError';
    this.jobId = jobId;
  }
}

export class JobStateTransitionError extends Error {
  readonly jobId: string;
  readonly from: JobStatus;

  constructor(jobId: string, from: JobStatus) {
    super(`Invalid state transition: cannot cancel job ${jobId} in status '${from}'`);
    this.name = 'JobStateTransitionError';
    this.jobId = jobId;
    this.from = from;
  }
}

export class JobValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'JobValidationError';
    this.code = code;
  }
}

type JobRow = {
  job: Job;
};

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, JobRow>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly byProject = new Map<string, string[]>();

  async create(request: CreateJobRequest): Promise<CreateJobResponse> {
    const idempotencyKey = request.idempotencyKey ?? (randomUUID() as Uuid);

    // 幂等键命中：返回已有 Job（03 契约 §4.3 规则 3）
    const existingJobId = this.byIdempotencyKey.get(idempotencyKey);
    if (existingJobId) {
      const existing = this.jobs.get(existingJobId)!.job;
      return { job: existing, idempotentReplay: true };
    }

    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID() as Uuid,
      projectId: request.projectId as Uuid,
      parentJobId: null,
      attempt: 1,
      jobType: request.jobType,
      provider: null,
      model: request.model,
      params: request.params,
      inputNodeIds: request.inputNodeIds as Uuid[],
      status: 'queued',
      providerJobId: null,
      errorCode: null,
      errorMessage: null,
      idempotencyKey,
      cancelRequestedAt: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(job.id, { job });
    this.byIdempotencyKey.set(idempotencyKey, job.id);
    const projectList = this.byProject.get(job.projectId) ?? [];
    projectList.push(job.id);
    this.byProject.set(job.projectId, projectList);

    return { job, idempotentReplay: false };
  }

  async listByProject(projectId: string): Promise<ListJobsResponse> {
    const ids = this.byProject.get(projectId) ?? [];
    const jobs = ids
      .map((id) => this.jobs.get(id)?.job)
      .filter((j): j is Job => j !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { jobs };
  }

  async get(jobId: string): Promise<Job> {
    const row = this.jobs.get(jobId);
    if (!row) {
      throw new JobNotFoundError(jobId);
    }
    return row.job;
  }

  async getOutputs(): Promise<JobOutput[]> {
    // 内存模式无持久化输出：Worker 侧 FakeProvider 产物不写回 InMemoryUploadRepository，
    // 媒体预览依赖 Supabase 模式（generation_job_outputs 表）。
    return [];
  }

  async cancel(jobId: string): Promise<CancelJobResponse> {
    const row = this.jobs.get(jobId);
    if (!row) {
      throw new JobNotFoundError(jobId);
    }

    const job = row.job;
    const now = new Date().toISOString();

    // 03 契约 §4.1：queued → cancelled（无需外部副作用）
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = now;
      job.updatedAt = now;
      return { job };
    }

    // running → cancel_requested（步骤 1 拿锁；外部副作用由 Worker/Provider 执行）
    if (job.status === 'running') {
      job.status = 'cancel_requested';
      job.cancelRequestedAt = now;
      job.updatedAt = now;
      return { job };
    }

    // 其余状态（succeeded/failed/cancelled/cancel_requested）→ 409
    throw new JobStateTransitionError(jobId, job.status);
  }
}
