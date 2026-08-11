/**
 * nodesStore 队列语义测试。
 *
 * 覆盖核心约束：本地瞬时操作（locked/rotation/zIndex —— 快照 schema 里不存在的字段）
 * 必须只更新本地状态、不进 pendingOperations，否则 API 返回 422 会把保存队列永久卡死。
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useNodesStore } from './nodesStore.ts';
import type { ClientOperation, Uuid } from '@tapflow/contracts';

const NODE_A = '11111111-1111-4111-8111-111111111111' as Uuid;
const NODE_B = '22222222-2222-4222-8222-222222222222' as Uuid;

function op(type: string, payload: unknown, id: string): ClientOperation {
  return { type, operationId: id as Uuid, payload } as ClientOperation;
}

function seedNode(id: Uuid) {
  useNodesStore.getState().applyLocal(
    op('create_node', { nodeType: 'image', position: { x: 0, y: 0 } }, id),
  );
}

describe('nodesStore 持久化队列', () => {
  beforeEach(() => {
    useNodesStore.getState().replaceSnapshot([], [], 0);
  });

  test('set_nodes_locked 更新本地状态但不入队', () => {
    seedNode(NODE_A);
    const afterCreate = useNodesStore.getState().pendingOperations.length;
    assert.equal(afterCreate, 1, 'create_node 应入队');

    useNodesStore.getState().applyLocal(
      op('set_nodes_locked', { nodeIds: [NODE_A], locked: true }, '33333333-3333-4333-8333-333333333333'),
    );

    const s = useNodesStore.getState();
    assert.equal(s.nodes[NODE_A].locked, true, 'locked 应本地生效');
    assert.equal(s.pendingOperations.length, afterCreate, 'set_nodes_locked 不应入队');
    assert.ok(
      !s.pendingOperations.some((o) => o.type === 'set_nodes_locked'),
      '队列里不应出现 set_nodes_locked',
    );
  });

  test('rotate_nodes / reorder_nodes 同样不入队', () => {
    seedNode(NODE_A);
    const base = useNodesStore.getState().pendingOperations.length;

    useNodesStore.getState().applyLocal(
      op('rotate_nodes', { nodeIds: [NODE_A], rotation: 90 }, '44444444-4444-4444-8444-444444444444'),
    );
    useNodesStore.getState().applyLocal(
      op('reorder_nodes', { nodeIds: [NODE_A], zIndex: 7 }, '55555555-5555-4555-8555-555555555555'),
    );

    const s = useNodesStore.getState();
    assert.equal(s.nodes[NODE_A].rotation, 90, 'rotation 应本地生效');
    assert.equal(s.nodes[NODE_A].zIndex, 7, 'zIndex 应本地生效');
    assert.equal(s.pendingOperations.length, base, '本地瞬时操作均不入队');
  });

  test('锁定后后续合法操作仍能正常入队', () => {
    seedNode(NODE_A);
    useNodesStore.getState().applyLocal(
      op('set_nodes_locked', { nodeIds: [NODE_A], locked: true }, '66666666-6666-4666-8666-666666666666'),
    );

    // 锁定不该污染队列，后续 create_node 必须照常入队
    seedNode(NODE_B);

    const s = useNodesStore.getState();
    const types = s.pendingOperations.map((o) => o.type);
    assert.deepEqual(types, ['create_node', 'create_node'], '队列应只含两次 create_node');
    assert.ok(s.nodes[NODE_B], '第二个节点应存在');
  });

  test('commitApplied 能清空队列（锁定操作不会残留卡住）', () => {
    seedNode(NODE_A);
    useNodesStore.getState().applyLocal(
      op('set_nodes_locked', { nodeIds: [NODE_A], locked: true }, '77777777-7777-4777-8777-777777777777'),
    );

    const pending = useNodesStore.getState().pendingOperations;
    useNodesStore.getState().commitApplied(pending.map((o) => o.operationId), 1);

    const s = useNodesStore.getState();
    assert.equal(s.pendingOperations.length, 0, '服务端确认后队列应清空');
    assert.equal(s.canvasVersion, 1, '版本应推进');
    assert.equal(s.nodes[NODE_A].locked, true, 'locked 本地状态应保留');
  });

  test('locked 节点不响应 move/resize', () => {
    seedNode(NODE_A);
    useNodesStore.getState().applyLocal(
      op('set_nodes_locked', { nodeIds: [NODE_A], locked: true }, '88888888-8888-4888-8888-888888888888'),
    );
    useNodesStore.getState().applyLocal(
      op('move_nodes', { nodeIds: [NODE_A], delta: { x: 50, y: 50 } }, '99999999-9999-4999-8999-999999999999'),
    );

    const n = useNodesStore.getState().nodes[NODE_A];
    assert.deepEqual(n.position, { x: 0, y: 0 }, 'locked 节点不应被移动');
  });
});
