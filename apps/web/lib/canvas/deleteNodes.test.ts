/**
 * 节点删除行为测试（单选 / 多选）。
 *
 * 用真实 nodesStore 验证：删除必须真正入持久化队列（delete_node 是服务端支持的操作），
 * 且多选删除要为每个节点各生成一条操作、operationId 不得复用。
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useNodesStore } from '../stores/nodesStore.ts';
import { buildDeleteOperations, deleteSelectedNodes } from './deleteNodes.ts';
import type { ClientOperation, Uuid } from '@tapflow/contracts';

const NODE_A = '11111111-1111-4111-8111-111111111111' as Uuid;
const NODE_B = '22222222-2222-4222-8222-222222222222' as Uuid;
const NODE_C = '33333333-3333-4333-8333-333333333333' as Uuid;
const EDGE_1 = '44444444-4444-4444-8444-444444444444' as Uuid;

function op(type: string, payload: unknown, id: string): ClientOperation {
  return { type, operationId: id as Uuid, payload } as ClientOperation;
}

function seedNode(id: Uuid) {
  useNodesStore.getState().applyLocal(
    op('create_node', { nodeType: 'image', position: { x: 0, y: 0 } }, id),
  );
}

describe('buildDeleteOperations', () => {
  test('单选生成一条 delete_node', () => {
    const ops = buildDeleteOperations([NODE_A]);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].type, 'delete_node');
    assert.deepEqual(ops[0].payload, { nodeId: NODE_A });
  });

  test('多选为每个节点各生成一条，operationId 唯一', () => {
    const ops = buildDeleteOperations([NODE_A, NODE_B, NODE_C]);
    assert.equal(ops.length, 3, '三个节点应产生三条操作');
    const ids = new Set(ops.map((o) => o.operationId));
    assert.equal(ids.size, 3, 'operationId 不得复用（服务端按 operationId 去重会吞掉后续删除）');
    assert.deepEqual(
      ops.map((o) => (o.payload as { nodeId: Uuid }).nodeId),
      [NODE_A, NODE_B, NODE_C],
      '应覆盖全部选中节点',
    );
  });

  test('空选中不产生任何操作', () => {
    assert.deepEqual(buildDeleteOperations([]), []);
  });
});

describe('deleteSelectedNodes 真实 store 行为', () => {
  beforeEach(() => {
    useNodesStore.getState().replaceSnapshot([], [], 0);
  });

  test('单选删除：节点消失且操作入队', () => {
    seedNode(NODE_A);
    useNodesStore.getState().commitApplied(
      useNodesStore.getState().pendingOperations.map((o) => o.operationId),
      1,
    );

    deleteSelectedNodes([NODE_A]);

    const s = useNodesStore.getState();
    assert.equal(s.nodes[NODE_A], undefined, '节点应被移除');
    assert.equal(s.pendingOperations.length, 1, 'delete_node 必须入队持久化');
    assert.equal(s.pendingOperations[0].type, 'delete_node');
  });

  test('多选删除：全部节点消失且入队三条', () => {
    seedNode(NODE_A);
    seedNode(NODE_B);
    seedNode(NODE_C);
    useNodesStore.getState().commitApplied(
      useNodesStore.getState().pendingOperations.map((o) => o.operationId),
      1,
    );

    deleteSelectedNodes([NODE_A, NODE_B, NODE_C]);

    const s = useNodesStore.getState();
    assert.deepEqual(Object.keys(s.nodes), [], '全部选中节点应被移除');
    assert.equal(s.pendingOperations.length, 3, '每个节点各一条 delete_node');
  });

  test('多选删除保留未选中节点', () => {
    seedNode(NODE_A);
    seedNode(NODE_B);
    seedNode(NODE_C);

    deleteSelectedNodes([NODE_A, NODE_B]);

    const s = useNodesStore.getState();
    assert.ok(s.nodes[NODE_C], '未选中的节点不应被删除');
    assert.equal(s.nodes[NODE_A], undefined);
    assert.equal(s.nodes[NODE_B], undefined);
  });

  test('删除节点时连带移除其关联边', () => {
    seedNode(NODE_A);
    seedNode(NODE_B);
    useNodesStore.getState().applyLocal(
      op(
        'create_edge',
        {
          edgeType: 'input',
          source: { nodeId: NODE_A },
          target: { nodeId: NODE_B },
        },
        EDGE_1,
      ),
    );
    assert.ok(useNodesStore.getState().edges[EDGE_1], '前置：边应存在');

    deleteSelectedNodes([NODE_A]);

    assert.equal(
      useNodesStore.getState().edges[EDGE_1],
      undefined,
      '删除端点节点后悬空边必须清除',
    );
  });
});
