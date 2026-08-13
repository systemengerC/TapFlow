/**
 * Supabase Generation Job 存储实现
 * - create: 调用 create_generation_job RPC（幂等键 + 归属校验在 DB 内完成）
 * - listByProject: 查询 generation_jobs 表（RLS 按 auth.uid() 过滤）
 * - get: 按 id 查询单条
 * - cancel: 调用 cancel_generation_job RPC（03 契约 §4.1 状态机）
 */
import {
  type CancelJobResponse,
  type CreateJobRequest,
  type CreateJobResponse,
  type Job,
  type JobStatus,
  type ListJobsResponse,
  type Uuid,
} from '@tapflow/contracts';

import { UnauthorizedError } from './app.ts';
import {
  JobNotFoundError,
  JobStateTransitionError,
  JobValidationError,
  type JobOutput,
  type JobRepository,
} from './jobRepository.ts';

type Options = {
  supabaseUrl: string;
  anonKey: string;
  fetcher?: typeof fetch;
};

type JobRow = {
  id: string;
  project_id: string;
  parent_job_id: string | null;
  attempt: number;
  job_type: 'text_to_image' | 'image_to_video' | 'text_to_video' | 'tts' | 'edit_image';
  provider: string | null;
  model: string;
  params: unknown;
  input_node_ids: string[];
  status: JobStatus;
  provider_job_id: string | null;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string;
  cancel_requested_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export class SupabaseJobRepository implements JobRepository {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly fetcher: typeof fetch;

  constructor({ supabaseUrl, anonKey, fetcher = fetch }: Options) {
    this.baseUrl = supabaseUrl.replace(/\/$/, '');
    this.anonKey = anonKey;
    this.fetcher = fetcher;
  }

  async create(request: CreateJobRequest, authorization?: string): Promise<CreateJobResponse> {
    const response = await this.fetchRpc('create_generation_job', {
      p_project_id: request.projectId,
      p_job_type: request.jobType,
      p_model: request.model,
      p_params: request.params,
      p_input_node_ids: request.inputNodeIds,
      ...(request.idempotencyKey ? { p_idempotency_key: request.idempotencyKey } : {}),
    }, authorization);
    if (!response.ok) {
      throw await this.toError(response, 'create_generation_job');
    }
    const rows = await response.json() as Array<{ job: JobRow; is_replay: boolean }>;
    const first = rows[0];
    if (!first) {
      throw new JobValidationError('JOB_CREATE_FAILED', 'create_generation_job returned no row');
    }
    return {
      job: this.toJob(first.job),
      idempotentReplay: first.is_replay,
    };
  }

  async listByProject(projectId: string, authorization?: string): Promise<ListJobsResponse> {
    const rows = await this.fetchGet<JobRow[]>(
      `/rest/v1/generation_jobs?project_id=eq.${encodeURIComponent(projectId)}&select=id,project_id,parent_job_id,attempt,job_type,provider,model,params,input_node_ids,status,provider_job_id,error_code,error_message,idempotency_key,cancel_requested_at,finished_at,created_at,updated_at&order=created_at.desc`,
      authorization,
    );
    return { jobs: rows.map((row) => this.toJob(row)) };
  }

  async get(jobId: string, authorization?: string): Promise<Job> {
    const rows = await this.fetchGet<JobRow[]>(
      `/rest/v1/generation_jobs?id=eq.${encodeURIComponent(jobId)}&select=id,project_id,parent_job_id,attempt,job_type,provider,model,params,input_node_ids,status,provider_job_id,error_code,error_message,idempotency_key,cancel_requested_at,finished_at,created_at,updated_at`,
      authorization,
    );
    if (rows.length !== 1) {
      throw new JobNotFoundError(jobId);
    }
    return this.toJob(rows[0]);
  }

  async getOutputs(jobId: string, authorization?: string): Promise<JobOutput[]> {
    const rows = await this.fetchGet<Array<{ asset_id: string; ordinal: number }>>(
      `/rest/v1/generation_job_outputs?job_id=eq.${encodeURIComponent(jobId)}&select=asset_id,ordinal&order=ordinal.asc`,
      authorization,
    );
    return rows.map((row) => ({
      assetId: row.asset_id as Uuid,
      ordinal: row.ordinal,
    }));
  }

  async cancel(jobId: string, authorization?: string): Promise<CancelJobResponse> {
    const response = await this.fetchRpc('cancel_generation_job', { p_job_id: jobId }, authorization);
    if (!response.ok) {
      throw await this.toError(response, 'cancel_generation_job');
    }
    const rows = await response.json() as Array<{ job: JobRow }>;
    const first = rows[0];
    if (!first) {
      throw new JobNotFoundError(jobId);
    }
    const job = this.toJob(first.job);
    // 03 契约 §4.1：非 queued/running 状态 → 409（RPC 原样返回当前状态）
    if (job.status !== 'cancelled' && job.status !== 'cancel_requested') {
      throw new JobStateTransitionError(jobId, job.status);
    }
    return { job };
  }

  private toJob(row: JobRow): Job {
    return {
      id: row.id as Uuid,
      projectId: row.project_id as Uuid,
      parentJobId: row.parent_job_id as Uuid | null,
      attempt: row.attempt,
      jobType: row.job_type,
      provider: row.provider,
      model: row.model,
      params: row.params,
      inputNodeIds: row.input_node_ids as Uuid[],
      status: row.status,
      providerJobId: row.provider_job_id,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      idempotencyKey: row.idempotency_key as Uuid,
      cancelRequestedAt: row.cancel_requested_at,
      finishedAt: row.finished_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async fetchGet<T>(path: string, authorization?: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: this.headers(authorization),
    });
    if (!response.ok) {
      throw await this.toError(response, path);
    }
    return response.json() as Promise<T>;
  }

  private fetchRpc(rpcName: string, body: Record<string, unknown>, authorization?: string): Promise<Response> {
    return this.fetcher(`${this.baseUrl}/rest/v1/rpc/${rpcName}`, {
      method: 'POST',
      headers: this.headers(authorization),
      body: JSON.stringify(body),
    });
  }

  private async toError(response: Response, context: string): Promise<Error> {
    if (response.status === 401) {
      return new UnauthorizedError('Authorization is required for Supabase access');
    }
    const error = await response.json().catch(() => ({})) as { message?: string; code?: string };
    const message = error.message ?? `Supabase request failed: ${context} (HTTP ${response.status})`;
    if (response.status === 404) {
      return new JobNotFoundError(context);
    }
    if (response.status === 409) {
      // 从错误消息提取实际状态（如 "cannot cancel job X in status 'failed'"），
      // 不再硬编码 'succeeded'（P2-G）
      const match = /status '([^']+)'/.exec(message);
      return new JobStateTransitionError(context, (match?.[1] as Job['status']) ?? 'unknown');
    }
    return new Error(message);
  }

  private headers(authorization?: string): HeadersInit {
    const headers: HeadersInit = {
      apikey: this.anonKey,
      'content-type': 'application/json',
    };
    if (authorization) {
      (headers as Record<string, string>).authorization = authorization;
    }
    return headers;
  }
}
