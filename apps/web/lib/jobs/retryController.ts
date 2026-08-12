/**
 * 重试控制器：纯函数/类，不依赖 React hooks。
 *
 * 职责：
 *   1. buildRetryRequest — 从失败 Job 构建新的提交请求（剔除旧幂等键和结果字段）。
 *   2. createRetryController — 防止连续点击创建重复 job；捕获提交失败供 UI 渲染。
 */
import type { Job, JobType, Uuid } from '@tapflow/contracts';

// ---------- 请求构建 ----------

export interface RetryRequest {
  jobType: JobType;
  model: string;
  params: Record<string, unknown>;
  inputNodeIds: string[];
}

/**
 * 从失败 Job 构建重试请求。
 * - 不透传 `idempotencyKey`（服务端需要生成新键，否则幂等去重会返回旧失败 job）。
 * - 不透传任何结果字段（status / errorCode / errorMessage 等）。
 */
export function buildRetryRequest(job: Job): RetryRequest {
  return {
    jobType: job.jobType,
    model: job.model,
    params: job.params as Record<string, unknown>,
    inputNodeIds: job.inputNodeIds,
  };
}

// ---------- 防重复控制器 ----------

export type SubmitFn = (req: RetryRequest, jobId: Uuid) => Promise<Uuid | null>;
type Listener = () => void;

export interface RetryController {
  /** 发起重试（在途时自动去重）。返回 promise，调用方无需处理 rejection。 */
  retry(job: Job): Promise<void>;
  /** 该 job 是否正在提交中（用于按钮禁用） */
  isSubmitting(jobId: Uuid): boolean;
  /** 最近一次提交的错误信息，成功或未提交时为 null */
  errorFor(jobId: Uuid): string | null;
  /** 订阅状态变化（开始/完成/失败），返回取消订阅函数 */
  subscribe(listener: Listener): () => void;
}

export function createRetryController(submitFn: SubmitFn): RetryController {
  const submitting = new Set<Uuid>();
  const errors = new Map<Uuid, string>();
  const listeners = new Set<Listener>();

  function notify() {
    for (const l of listeners) l();
  }

  return {
    async retry(job: Job) {
      if (submitting.has(job.id)) return; // 在途：静默丢弃

      submitting.add(job.id);
      errors.delete(job.id);
      notify();

      try {
        const result = await submitFn(buildRetryRequest(job), job.id);
        if (result === null) {
          errors.set(job.id, '提交失败，请稍后重试');
        }
      } catch (e) {
        errors.set(job.id, e instanceof Error ? e.message : String(e));
      } finally {
        submitting.delete(job.id);
        notify();
      }
    },

    isSubmitting(jobId: Uuid) {
      return submitting.has(jobId);
    },

    errorFor(jobId: Uuid) {
      return errors.get(jobId) ?? null;
    },

    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
