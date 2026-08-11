/**
 * applyOperations 提交链路。
 *
 * 请求/响应一律用契约包的 Schema 做运行时校验：
 *   - 出站：ApplyOperationsRequestSchema.parse —— 本地就拦住非法操作，不把脏数据打到服务端
 *   - 入站：ApplyOperationsResponseSchema / ErrorResponseSchema —— 服务端返回也不盲信
 * 409 冲突时按契约取 currentVersion，回滚本地队列交由调用方重新拉快照。
 *
 * 核心流程抽成 flushOperations（纯异步函数、可注入 fetch），hook 只负责 flushing/error 状态，
 * 这样批次错误恢复语义可以被单测直接覆盖。
 */
'use client';

import { useCallback, useState } from 'react';
import {
  ApplyOperationsRequestSchema,
  ApplyOperationsResponseSchema,
  ErrorResponseSchema,
  type ApplyOperationsResponse,
} from '@tapflow/contracts';
import { useNodesStore } from '../stores/nodesStore';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

export class VersionConflictError extends Error {
  // 显式字段而非构造器参数属性：node --test 的 strip-only TS 模式不支持参数属性
  readonly currentVersion?: number;

  constructor(currentVersion?: number) {
    super('CANVAS_VERSION_CONFLICT');
    this.name = 'VersionConflictError';
    this.currentVersion = currentVersion;
  }
}

/**
 * 服务端拒绝了批次里某个不支持持久化的操作。
 *
 * 契约的错误响应是批次级的，不携带失败的 operationId，所以客户端无法知道是哪一条被拒。
 * 因此这里既不删除也不猜测任何队列项：本地瞬时操作（locked/rotation/zIndex）已经在
 * nodesStore.applyLocal 源头排除，正常情况下不该走到这里；真的走到了就是 bug，
 * 保留队列并显式抛错，让问题暴露出来，而不是静默丢掉合法操作。
 */
export class UnsupportedOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedOperationError';
  }
}

export class LocalContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalContractError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 提交一批待持久化操作。
 *
 * 返回 null 表示无事可做（没有 projectId 或队列为空）。
 * 任何失败都以抛错结束，且失败路径绝不删除队列项——只有 409 会整体回滚（由调用方重新拉快照）。
 */
export async function flushOperations(
  projectId: string | null,
  fetchImpl: FetchLike = fetch,
  apiBase: string = API_BASE,
): Promise<ApplyOperationsResponse | null> {
  const { pendingOperations, canvasVersion, commitApplied, rollbackPending } =
    useNodesStore.getState();

  if (!projectId || pendingOperations.length === 0) return null;

  // 契约限制单批 ≤200 条，超出部分留到下一次 flush
  const batch = pendingOperations.slice(0, 200);
  const parsed = ApplyOperationsRequestSchema.safeParse({
    operations: batch,
    baseVersion: canvasVersion,
  });
  if (!parsed.success) {
    throw new LocalContractError(
      `本地操作不满足契约: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }

  const res = await fetchImpl(`${apiBase}/api/projects/${projectId}/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parsed.data),
  });

  if (!res.ok) {
    const errBody = ErrorResponseSchema.safeParse(await res.json().catch(() => null));
    if (res.status === 409) {
      rollbackPending();
      throw new VersionConflictError(
        errBody.success ? errBody.data.currentVersion : undefined,
      );
    }
    if (
      res.status === 422 &&
      errBody.success &&
      errBody.data.error.code === 'UNSUPPORTED_OPERATION'
    ) {
      // 服务端原子拒绝整批且不告知具体是哪一条，任何"跳过第一项"式猜测都会丢掉合法操作。
      // 保留队列原样，显式报错。
      throw new UnsupportedOperationError(errBody.data.error.message);
    }
    throw new Error(
      errBody.success ? errBody.data.error.message : `HTTP ${res.status}`,
    );
  }

  const body = ApplyOperationsResponseSchema.parse(await res.json());
  commitApplied(body.appliedOperationIds, body.canvasVersion);
  return body;
}

export function useApplyOperations(projectId: string | null) {
  const [flushing, setFlushing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flush = useCallback(async (): Promise<ApplyOperationsResponse | null> => {
    setFlushing(true);
    setError(null);
    try {
      return await flushOperations(projectId);
    } catch (e) {
      if (e instanceof VersionConflictError) {
        setError('画布已被其他会话修改，需要重新同步');
      } else if (e instanceof UnsupportedOperationError) {
        setError(`存在不支持持久化的操作，保存已暂停: ${e.message}`);
      } else if (e instanceof LocalContractError) {
        setError(e.message);
        return null;
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      throw e;
    } finally {
      setFlushing(false);
    }
  }, [projectId]);

  return { flush, flushing, error };
}
