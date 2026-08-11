/**
 * useApplyOperations 混合批次错误恢复测试。
 *
 * 核心约束：服务端返回 422 UNSUPPORTED_OPERATION 时，批次整体被拒且响应不携带失败 operationId，
 * 客户端无法可靠定位是哪一条失败。因此必须保留队列原样，显式抛 UnsupportedOperationError，
 * 而不能"猜第一项并删除"——那会在"合法、合法、不支持"批次里删掉合法操作，导致数据丢失。
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useNodesStore } from '../stores/nodesStore.ts';
import {
  flushOperations,
  UnsupportedOperationError,
  VersionConflictError,
  LocalContractError,
} from './useApplyOperations.ts';
import type { ClientOperation, Uuid } from '@tapflow/contracts';

const NODE_A = '11111111-1111-4111-8111-111111111111' as Uuid;
const NODE_B = '22222222-2222-4222-8222-222222222222' as Uuid;
const NODE_C = '33333333-3333-4333-8333-333333333333' as Uuid;

function op(type: string, payload: unknown, id: string): ClientOperation {
  return { type, operationId: id as Uuid, payload } as ClientOperation;
}

function seedNode(id: Uuid) {
  useNodesStore.getState().applyLocal(
    op('create_node', { nodeType: 'image', position: { x: 0, y: 0 } }, id),
  );
}

describe('flushOperations 批次错误恢复', () => {
  beforeEach(() => {
    useNodesStore.getState().replaceSnapshot([], [], 0);
  });

  test('422 UNSUPPORTED_OPERATION 保留队列原样且抛 UnsupportedOperationError', async () => {
    // 模拟混合批次：两个合法 create_node + 一个不支持的操作（假设某个客户端 bug 让不支持的操作进了队列）
    seedNode(NODE_A);
    seedNode(NODE_B);
    // set_viewport 契约里存在（payload 为 { viewport: Json }）但 API 明确不支持持久化 → 422。
    // 这里模拟"客户端 bug 让它进了队列"的场景，且它排在队列最后一位。
    useNodesStore.setState({
      pendingOperations: [
        ...useNodesStore.getState().pendingOperations,
        op('set_viewport', { viewport: { x: 0, y: 0, zoom: 1 } }, NODE_C),
      ],
    });

    const queueBefore = useNodesStore.getState().pendingOperations;
    assert.equal(queueBefore.length, 3, '队列应有 3 项');

    const mockFetch = async (): Promise<Response> => {
      return {
        ok: false,
        status: 422,
        json: async () => ({
          error: {
            code: 'UNSUPPORTED_OPERATION',
            message: 'set_viewport is not supported',
          },
        }),
      } as Response;
    };

    await assert.rejects(
      async () => flushOperations('proj-1', mockFetch, ''),
      (err: Error) => err instanceof UnsupportedOperationError,
      '应抛 UnsupportedOperationError',
    );

    // 核心断言：队列必须保持原样，一项都不能删
    const queueAfter = useNodesStore.getState().pendingOperations;
    assert.equal(queueAfter.length, 3, '422 后队列应保持 3 项不变');
    assert.deepEqual(
      queueAfter.map((o) => o.operationId),
      queueBefore.map((o) => o.operationId),
      '队列顺序和内容应完全不变',
    );
  });

  test('409 VERSION_CONFLICT 回滚队列且抛 VersionConflictError', async () => {
    seedNode(NODE_A);
    const queueBefore = useNodesStore.getState().pendingOperations;
    assert.equal(queueBefore.length, 1);

    const mockFetch = async (): Promise<Response> => {
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: { code: 'CANVAS_VERSION_CONFLICT', message: 'conflict' },
          currentVersion: 5,
        }),
      } as Response;
    };

    await assert.rejects(
      async () => flushOperations('proj-1', mockFetch, ''),
      (err: Error) => err instanceof VersionConflictError && err.currentVersion === 5,
      '应抛 VersionConflictError 并携带 currentVersion',
    );

    // 409 应回滚队列（由调用方重新拉快照）
    const queueAfter = useNodesStore.getState().pendingOperations;
    assert.equal(queueAfter.length, 0, '409 冲突应清空队列');
  });

  test('本地契约校验失败抛 LocalContractError，不修改队列', async () => {
    // 强行塞一个格式错误的操作
    useNodesStore.setState({
      pendingOperations: [
        { type: 'invalid_op', operationId: NODE_A, payload: {} } as unknown as ClientOperation,
      ],
    });

    await assert.rejects(
      async () => flushOperations('proj-1', fetch, ''),
      (err: Error) => err instanceof LocalContractError,
      '应抛 LocalContractError',
    );

    // 队列应保持原样
    const queueAfter = useNodesStore.getState().pendingOperations;
    assert.equal(queueAfter.length, 1, '本地契约错误不应清空队列');
  });

  test('200 成功时 commitApplied 清空队列并推进版本', async () => {
    seedNode(NODE_A);
    seedNode(NODE_B);
    const queue = useNodesStore.getState().pendingOperations;

    const mockFetch = async (): Promise<Response> => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          appliedOperationIds: queue.map((o) => o.operationId),
          canvasVersion: 2,
        }),
      } as Response;
    };

    const result = await flushOperations('proj-1', mockFetch, '');
    assert.ok(result, '成功应返回 response body');
    assert.equal(result.canvasVersion, 2);

    const s = useNodesStore.getState();
    assert.equal(s.pendingOperations.length, 0, '成功后队列应清空');
    assert.equal(s.canvasVersion, 2, '版本应推进到 2');
  });

  test('空队列或无 projectId 时返回 null', async () => {
    const result1 = await flushOperations(null);
    assert.equal(result1, null, '无 projectId 应返回 null');

    const result2 = await flushOperations('proj-1');
    assert.equal(result2, null, '空队列应返回 null');
  });
});
