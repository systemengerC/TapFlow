/**
 * TapFlow Worker — Supabase WorkerStore 实现
 * 依赖 migration 005 提供的 Worker 生命周期 RPC：
 *   claim_next_generation_job / set_generation_job_provider_id /
 *   complete_generation_job / fail_generation_job /
 *   resolve_cancel_generation_job / rollback_cancel_generation_job
 * 凭证：worker 进程应使用 service_role key（写 storage、跨 RLS 领取任务）；
 *       缺省回退 anonKey 仅用于未配置场景（联调）。
 */
import type { Job, JobStatus, Uuid } from '@tapflow/contracts';

import type { ProviderOutput } from './provider.ts';
import type { JobOutput, WorkerStore } from './workerStore.ts';
import { JobNotFoundError, JobStateTransitionError } from './workerStore.ts';

type Options = {
  supabaseUrl: string;
  anonKey: string;
  serviceKey?: string;
  fetcher?: typeof fetch;
};

type SupabaseError = {
  code?: string;
  message?: string;
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

type OutputRow = {
  id: string;
  asset_id: string;
  ordinal: number;
};

const JOB_SELECT =
  'id,project_id,parent_job_id,attempt,job_type,provider,model,params,input_node_ids,status,provider_job_id,error_code,error_message,idempotency_key,cancel_requested_at,finished_at,created_at,updated_at';

/** 转存到 generated bucket 时的对象扩展名 */
const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
};

/** 转存失败：runner 捕获后以 ASSET_TRANSFER_FAILED 终结 Job（03 契约 §5） */
export class AssetTransferError extends Error {
  constructor(message: string) {
    super(`asset transfer failed: ${message}`);
    this.name = 'AssetTransferError';
  }
}

export class SupabaseWorkerStore implements WorkerStore {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly serviceKey: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor({ supabaseUrl, anonKey, serviceKey, fetcher = fetch }: Options) {
    this.baseUrl = supabaseUrl.replace(/\/$/, '');
    this.anonKey = anonKey;
    this.serviceKey = serviceKey;
    this.fetcher = fetcher;
  }

  async claimNext(): Promise<Job | null> {
    const rows = await this.fetchRpc<Array<{ job: JobRow }>>('claim_next_generation_job', {});
    return rows[0] ? this.toJob(rows[0].job) : null;
  }

  async setProviderJobId(jobId: string, providerJobId: string): Promise<void> {
    await this.fetchRpc<Array<{ job: JobRow }>>('set_generation_job_provider_id', {
      p_job_id: jobId,
      p_provider_job_id: providerJobId,
    });
  }

  async complete(jobId: string, outputs: ProviderOutput[]): Promise<{ job: Job; outputs: JobOutput[] }> {
    // 生产模式（serviceKey）：先把 provider 输出真实转存到 generated bucket，
    // 再以转存后的对象路径完成 Job（阻断项 6：不允许把 provider URL 当 storage_path 落库）。
    // 联调模式（无 serviceKey）：透传原样（FakeProvider 输出仅供单测/内存模式）。
    const persisted = this.serviceKey ? await this.transferOutputs(jobId, outputs) : outputs;

    const rows = await this.fetchRpc<Array<{ job: JobRow }>>('complete_generation_job', {
      p_job_id: jobId,
      p_outputs: persisted.map((output) => ({
        url: output.url,
        mimeType: output.mimeType,
        width: output.width ?? null,
        height: output.height ?? null,
      })),
    });
    const row = rows[0];
    if (!row) {
      throw new JobNotFoundError(jobId);
    }
    const job = this.toJob(row.job);

    // 读取落库输出（assetId/ordinal），url/mimeType 以转存后的结果为准
    const outputRows = await this.fetchGet<OutputRow[]>(
      `/rest/v1/generation_job_outputs?job_id=eq.${encodeURIComponent(jobId)}&select=id,asset_id,ordinal&order=ordinal.asc`,
    );
    const written: JobOutput[] = persisted.map((output, index) => {
      const rowOut = outputRows[index];
      return {
        id: (rowOut?.id ?? jobId) as Uuid,
        assetId: (rowOut?.asset_id ?? jobId) as Uuid,
        ordinal: index,
        url: output.url,
        mimeType: output.mimeType,
        width: output.width ?? null,
        height: output.height ?? null,
      };
    });
    return { job, outputs: written };
  }

  /**
   * 转存 provider 输出到 generated bucket。
   * 每个输出：GET provider url → PUT storage object（generated/{jobId}/{ordinal}.{ext}）。
   * 非 http(s) 路径（已是对象路径）原样透传。任一失败抛 AssetTransferError。
   */
  private async transferOutputs(jobId: string, outputs: ProviderOutput[]): Promise<ProviderOutput[]> {
    const transferred: ProviderOutput[] = [];
    for (let index = 0; index < outputs.length; index += 1) {
      const output = outputs[index];
      if (!/^https?:\/\//i.test(output.url)) {
        transferred.push(output);
        continue;
      }
      const extension = MIME_EXTENSION[output.mimeType] ?? 'bin';
      const storagePath = `${jobId}/${index}.${extension}`;

      const source = await this.fetcher(output.url);
      if (!source.ok) {
        throw new AssetTransferError(`download ${output.url} failed (HTTP ${source.status})`);
      }
      const buffer = Buffer.from(await source.arrayBuffer());

      const upload = await this.fetcher(`${this.baseUrl}/storage/v1/object/generated/${storagePath}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${this.serviceKey}`,
          'content-type': output.mimeType,
          'x-upsert': 'false',
        },
        body: buffer,
      });
      if (!upload.ok) {
        throw new AssetTransferError(`upload generated/${storagePath} failed (HTTP ${upload.status})`);
      }

      transferred.push({ ...output, url: storagePath });
    }
    return transferred;
  }

  async fail(jobId: string, errorCode: string, errorMessage: string): Promise<Job> {
    const rows = await this.fetchRpc<Array<{ job: JobRow }>>('fail_generation_job', {
      p_job_id: jobId,
      p_error_code: errorCode,
      p_error_message: errorMessage,
    });
    const row = rows[0];
    if (!row) {
      throw new JobNotFoundError(jobId);
    }
    return this.toJob(row.job);
  }

  async listCancelRequested(): Promise<Job[]> {
    const rows = await this.fetchGet<JobRow[]>(
      `/rest/v1/generation_jobs?status=eq.cancel_requested&select=${JOB_SELECT}&order=created_at.asc`,
    );
    return rows.map((row) => this.toJob(row));
  }

  async resolveCancel(jobId: string): Promise<Job> {
    const rows = await this.fetchRpc<Array<{ job: JobRow }>>('resolve_cancel_generation_job', {
      p_job_id: jobId,
    });
    const row = rows[0];
    if (!row) {
      throw new JobNotFoundError(jobId);
    }
    return this.toJob(row.job);
  }

  async rollbackCancel(jobId: string): Promise<Job> {
    const rows = await this.fetchRpc<Array<{ job: JobRow }>>('rollback_cancel_generation_job', {
      p_job_id: jobId,
    });
    const row = rows[0];
    if (!row) {
      throw new JobNotFoundError(jobId);
    }
    return this.toJob(row.job);
  }

  async get(jobId: string): Promise<Job> {
    const rows = await this.fetchGet<JobRow[]>(
      `/rest/v1/generation_jobs?id=eq.${encodeURIComponent(jobId)}&select=${JOB_SELECT}`,
    );
    if (rows.length !== 1) {
      throw new JobNotFoundError(jobId);
    }
    return this.toJob(rows[0]);
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

  private async fetchGet<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw await this.toError(response, path);
    }
    return response.json() as Promise<T>;
  }

  private fetchRpc<T>(rpcName: string, body: Record<string, unknown>): Promise<T> {
    return this.fetcher(`${this.baseUrl}/rest/v1/rpc/${rpcName}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    }).then(async (response) => {
      if (!response.ok) {
        throw await this.toError(response, rpcName);
      }
      return response.json() as Promise<T>;
    });
  }

  private async toError(response: Response, context: string): Promise<Error> {
    if (response.status === 401) {
      return new Error(`Worker authorization failed: ${context} (HTTP 401)`);
    }
    const error = await response.json().catch(() => ({})) as SupabaseError;
    const message = error.message ?? `Supabase request failed: ${context} (HTTP ${response.status})`;
    if (message.includes('JOB_NOT_FOUND')) {
      return new JobNotFoundError(context);
    }
    if (message.includes('INVALID_STATE_TRANSITION')) {
      return new JobStateTransitionError(context, 'running');
    }
    return new Error(message);
  }

  private headers(): HeadersInit {
    return {
      apikey: this.anonKey,
      ...(this.serviceKey ? { authorization: `Bearer ${this.serviceKey}` } : {}),
      'content-type': 'application/json',
    };
  }
}
