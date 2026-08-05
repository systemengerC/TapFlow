/**
 * 画布实体 store：节点 / 边 / 待提交操作队列 / 乐观锁版本。
 *
 * 类型边界说明：
 *   - 传输层类型（ClientOperation 等）一律从 @tapflow/contracts import，禁止本地重复定义。
 *   - CanvasNode / CanvasEdge 是纯前端渲染态（Leafer 绘制所需的几何+数据快照），
 *     契约包不提供实体读模型，故在此定义；字段命名与 create_node payload 保持一致。
 */
'use client';

import { create } from 'zustand';
import type { ClientOperation, Uuid } from '@tapflow/contracts';

export interface CanvasNode {
  id: Uuid;
  nodeType: string;
  position: { x: number; y: number };
  size: { x: number; y: number };
  rotation: number;
  zIndex: number;
  locked: boolean;
  data: unknown;
  parentNodeId: Uuid | null;
}

export interface CanvasEdge {
  id: Uuid;
  edgeType: 'reference' | 'input' | 'derived_from';
  sourceNodeId: Uuid;
  targetNodeId: Uuid;
}

interface NodesState {
  nodes: Record<Uuid, CanvasNode>;
  edges: Record<Uuid, CanvasEdge>;
  /** 服务端确认的画布版本，applyOperations 的 baseVersion */
  canvasVersion: number;
  /** 已本地应用、等待 flush 到服务端的操作 */
  pendingOperations: ClientOperation[];

  nodeList: () => CanvasNode[];
  edgeList: () => CanvasEdge[];

  /** 本地乐观应用一个操作并入队（真实提交由 useApplyOperations 负责） */
  applyLocal: (op: ClientOperation) => void;
  /** 服务端确认后清队列并推进版本 */
  commitApplied: (appliedIds: Uuid[], canvasVersion: number) => void;
  /** 冲突回滚：丢弃本地队列，由调用方重新拉取快照 */
  rollbackPending: () => void;
  replaceSnapshot: (
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    canvasVersion: number,
  ) => void;
}

const DEFAULT_SIZE = { x: 320, y: 320 };

export const useNodesStore = create<NodesState>((set, get) => ({
  nodes: {},
  edges: {},
  canvasVersion: 0,
  pendingOperations: [],

  nodeList: () =>
    Object.values(get().nodes).sort((a, b) => a.zIndex - b.zIndex),
  edgeList: () => Object.values(get().edges),

  applyLocal: (op) =>
    set((s) => {
      const nodes = { ...s.nodes };
      const edges = { ...s.edges };

      switch (op.type) {
        case 'create_node': {
          // operationId 复用为本地节点 id：服务端以同一 id 落库，避免二次映射
          const id = op.operationId;
          nodes[id] = {
            id,
            nodeType: op.payload.nodeType,
            position: op.payload.position ?? { x: 0, y: 0 },
            size: op.payload.size ?? DEFAULT_SIZE,
            rotation: 0,
            zIndex: Object.keys(nodes).length,
            locked: false,
            data: op.payload.data ?? null,
            parentNodeId: op.payload.parentNodeId ?? null,
          };
          break;
        }
        case 'update_node': {
          const n = nodes[op.payload.nodeId];
          if (n) {
            const patch = op.payload.patch;
            nodes[n.id] = {
              ...n,
              data:
                patch && typeof patch === 'object' && !Array.isArray(patch)
                  ? { ...(n.data as object | null), ...(patch as object) }
                  : patch,
            };
          }
          break;
        }
        case 'delete_node': {
          delete nodes[op.payload.nodeId];
          for (const e of Object.values(edges)) {
            if (
              e.sourceNodeId === op.payload.nodeId ||
              e.targetNodeId === op.payload.nodeId
            ) {
              delete edges[e.id];
            }
          }
          break;
        }
        case 'move_nodes': {
          for (const id of op.payload.nodeIds) {
            const n = nodes[id];
            if (n && !n.locked) {
              nodes[id] = {
                ...n,
                position: {
                  x: n.position.x + op.payload.delta.x,
                  y: n.position.y + op.payload.delta.y,
                },
              };
            }
          }
          break;
        }
        case 'resize_nodes': {
          for (const id of op.payload.nodeIds) {
            const n = nodes[id];
            if (n && !n.locked) nodes[id] = { ...n, size: op.payload.size };
          }
          break;
        }
        case 'rotate_nodes': {
          for (const id of op.payload.nodeIds) {
            const n = nodes[id];
            if (n && !n.locked)
              nodes[id] = { ...n, rotation: op.payload.rotation };
          }
          break;
        }
        case 'reorder_nodes': {
          for (const id of op.payload.nodeIds) {
            const n = nodes[id];
            if (n) nodes[id] = { ...n, zIndex: op.payload.zIndex };
          }
          break;
        }
        case 'set_nodes_locked': {
          for (const id of op.payload.nodeIds) {
            const n = nodes[id];
            if (n) nodes[id] = { ...n, locked: op.payload.locked };
          }
          break;
        }
        case 'create_edge': {
          const id = op.operationId;
          edges[id] = {
            id,
            edgeType: op.payload.edgeType,
            sourceNodeId: op.payload.source.nodeId,
            targetNodeId: op.payload.target.nodeId,
          };
          break;
        }
        case 'delete_edge': {
          delete edges[op.payload.edgeId];
          break;
        }
        default:
          // attach_asset / replace_node_asset / create_job / group / ungroup /
          // set_viewport 由服务端结果驱动，本地不做乐观投影，仅入队。
          break;
      }

      return {
        nodes,
        edges,
        pendingOperations: [...s.pendingOperations, op],
      };
    }),

  commitApplied: (appliedIds, canvasVersion) =>
    set((s) => {
      const applied = new Set(appliedIds);
      return {
        canvasVersion,
        pendingOperations: s.pendingOperations.filter(
          (op) => !applied.has(op.operationId),
        ),
      };
    }),

  rollbackPending: () => set({ pendingOperations: [] }),

  replaceSnapshot: (nodes, edges, canvasVersion) =>
    set({
      nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
      edges: Object.fromEntries(edges.map((e) => [e.id, e])),
      canvasVersion,
      pendingOperations: [],
    }),
}));
