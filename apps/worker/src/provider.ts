/**
 * TapFlow Worker — Provider Adapter 接口（SOP 04 §3.3）
 * 每个 Adapter 只负责鉴权、请求/响应转换和供应商状态映射；
 * 素材角色、默认值、参数范围及 UI 展示来自 Capability/Template，不硬编码进 Adapter。
 */
import type { Job, JobType } from '@tapflow/contracts';

/** 供应商提交结果 */
export type ProviderSubmission = {
  providerJobId: string;
  status: 'pending' | 'succeeded' | 'failed';
};

/** 供应商输出资产（结果转存前描述） */
export type ProviderOutput = {
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
};

/** 供应商任务状态（03 契约 §5 错误分类） */
export type ProviderStatus = {
  status: 'pending' | 'succeeded' | 'failed';
  outputs?: ProviderOutput[];
  error?: {
    code: string;
    message: string;
    category: 'retryable' | 'fatal' | 'user_error' | 'quota_error';
  };
};

export interface GenerationProvider {
  readonly name: string;
  /** 该供应商支持的 Job 类型 */
  readonly jobTypes: JobType[];
  /** 是否支持取消 */
  readonly supportsCancel: boolean;

  submit(job: Job): Promise<ProviderSubmission>;
  getStatus(providerJobId: string): Promise<ProviderStatus>;
  cancel?(providerJobId: string): Promise<void>;
}

/** 按 Job 类型注册的 Provider 注册表 */
export type ProviderRegistry = Map<JobType, GenerationProvider>;

// ---------------------------------------------------------------------------
// FakeProvider — AI-M3-01：可控延迟、成功、失败和多结果输出
// 通过 job.params.fake 控制行为：
//   { delayMs?: number; outcome?: 'success'|'fatal'|'retryable'|'quota';
//     retryCount?: number; outputCount?: number; cancelDelayMs?: number }
// ---------------------------------------------------------------------------
export type FakeParams = {
  delayMs?: number;
  outcome?: 'success' | 'fatal' | 'retryable' | 'quota';
  /** retryable 失败在第 N 次轮询后转为 success（验证指数退避重试） */
  retryCount?: number;
  outputCount?: number;
  cancelDelayMs?: number;
};

export class FakeProvider implements GenerationProvider {
  readonly name = 'fake';
  readonly jobTypes: JobType[] = ['text_to_image', 'image_to_video', 'text_to_video', 'tts', 'edit_image'];
  readonly supportsCancel = true;

  private readonly submissions = new Map<
    string,
    { attempts: number; cancelled: boolean; params: FakeParams }
  >();

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async submit(job: Job): Promise<ProviderSubmission> {
    const params = (job.params ?? {}) as Record<string, unknown>;
    const fake = (params.fake ?? {}) as FakeParams;
    if (fake.delayMs) {
      await this.sleep(fake.delayMs);
    }
    const providerJobId = `fake-${job.id}`;
    this.submissions.set(providerJobId, { attempts: 0, cancelled: false, params: fake });
    return { providerJobId, status: 'pending' };
  }

  async getStatus(providerJobId: string): Promise<ProviderStatus> {
    const state = this.submissions.get(providerJobId);
    if (!state) {
      return {
        status: 'failed',
        error: { code: 'PROVIDER_UNAVAILABLE', message: `unknown provider job ${providerJobId}`, category: 'retryable' },
      };
    }
    // 取消请求已提交：模拟供应商异步确认
    if (state.cancelled) {
      return { status: 'failed', error: { code: 'CANCELLED', message: 'cancelled by provider', category: 'fatal' } };
    }

    const { params: fake, attempts } = state;
    const outcome = fake.outcome ?? 'success';
    const retryCount = fake.retryCount ?? 0;
    state.attempts += 1;

    if (outcome === 'retryable' && state.attempts <= retryCount) {
      return {
        status: 'failed',
        error: { code: 'PROVIDER_TIMEOUT', message: `transient failure attempt ${state.attempts}`, category: 'retryable' },
      };
    }
    if (outcome === 'fatal') {
      return {
        status: 'failed',
        error: { code: 'PROVIDER_AUTH_FAILED', message: 'provider rejected the request', category: 'fatal' },
      };
    }
    if (outcome === 'quota') {
      return {
        status: 'failed',
        error: { code: 'PROVIDER_QUOTA_EXCEEDED', message: 'quota exhausted', category: 'quota_error' },
      };
    }
    const outputCount = fake.outputCount ?? 1;
    return {
      status: 'succeeded',
      outputs: Array.from({ length: outputCount }, (_, i) => ({
        url: `https://fake.local/outputs/${providerJobId}-${i}.png`,
        mimeType: 'image/png',
        width: 1024,
        height: 1024,
      })),
    };
  }

  async cancel(providerJobId: string): Promise<void> {
    const state = this.submissions.get(providerJobId);
    if (state) {
      state.cancelled = true;
    }
  }
}
