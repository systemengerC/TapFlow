/**
 * 节点删除：构建操作 + 应用到 store。
 *
 * 抽成独立模块的原因：删除是持久化操作（delete_node 进 pendingOperations），
 * 多选时必须每个节点各一条、operationId 唯一，这个语义需要可测。
 */
import { useNodesStore } from '../stores/nodesStore.ts';
import type { ClientOperation, Uuid } from '@tapflow/contracts';

/** 为每个选中节点各生成一条 delete_node，operationId 独立 */
export function buildDeleteOperations(nodeIds: readonly Uuid[]): ClientOperation[] {
  return nodeIds.map(
    (nodeId) =>
      ({
        type: 'delete_node',
        operationId: crypto.randomUUID() as Uuid,
        payload: { nodeId },
      }) as ClientOperation,
  );
}

/** 删除选中节点（本地乐观应用 + 入持久化队列） */
export function deleteSelectedNodes(nodeIds: readonly Uuid[]): void {
  const { applyLocal } = useNodesStore.getState();
  for (const op of buildDeleteOperations(nodeIds)) {
    applyLocal(op);
  }
}
