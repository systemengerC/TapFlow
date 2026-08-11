/**
 * applyOperations 提交链路。
 *
 * 请求/响应一律用契约包的 Schema 做运行时校验：
 *   - 出站：ApplyOperationsRequestSchema.parse —— 本地就拦住非法操作，不把脏数据打到服务端
 *   - 入站：ApplyOperationsResponseSchema / ErrorResponseSchema —— 服务端返回也不盲信
 * 409 冲突时按契约取 currentVersion，回滚本地队列交由调用方重新拉快照。
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
  constructor(readonly currentVersion?: number) {
    super('CANVAS_VERSION_CONFLICT');
    this.name = 'VersionConflictError';
  }
}

export function useApplyOperations(projectId: string | null) {
  const [flushing, setFlushing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flush = useCallback(async (): Promise<ApplyOperationsResponse | null> => {
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
      setError(`本地操作不满足契约: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      return null;
    }

    setFlushing(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/operations`, {
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
        // 422 UNSUPPORTED_OPERATION：本地瞬时操作误入队列，跳过而不卡死
        if (res.status === 422 && errBody.success && errBody.data.error.code === 'UNSUPPORTED_OPERATION') {
          // 从队列中移除该操作，让后续合法操作能继续 flush
          const { pendingOperations } = useNodesStore.getState();
          const failedOpId = batch[0]?.operationId; // 单批失败时第一个 op 就是问题操作
          if (failedOpId) {
            useNodesStore.setState({
              pendingOperations: pendingOperations.filter(op => op.operationId !== failedOpId),
            });
          }
          setError('部分操作不支持持久化，已跳过');
          return null; // 不抛错，让调用方继续正常流程
        }
        throw new Error(
          errBody.success ? errBody.data.error.message : `HTTP ${res.status}`,
        );
      }

      const body = ApplyOperationsResponseSchema.parse(await res.json());
      commitApplied(body.appliedOperationIds, body.canvasVersion);
      return body;
    } catch (e) {
      if (e instanceof VersionConflictError) {
        setError('画布已被其他会话修改，需要重新同步');
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
