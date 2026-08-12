/**
 * 属性面板：显示选中节点的基础属性，支持简单编辑。
 * 挂载在 DOM Overlay 层，与画布解耦。
 */
'use client';

import { useCanvasStore } from '@/lib/stores/canvasStore';
import { useNodesStore } from '@/lib/stores/nodesStore';
import { deleteSelectedNodes } from '@/lib/canvas/deleteNodes';
import type { ClientOperation, Uuid } from '@tapflow/contracts';

/** 节点几何/状态：View 层只依赖这些字段，不依赖完整 Node 类型 */
export interface PanelNode {
  nodeType: string;
  position: { x: number; y: number };
  size: { x: number; y: number };
  locked?: boolean;
}

export interface PropertiesPanelViewProps {
  selectedNodeIds: Uuid[];
  /** 首个选中节点，缺失（脏选中）时不渲染 */
  node: PanelNode | undefined;
  onApply: (op: ClientOperation) => void;
  onDelete: (ids: Uuid[]) => void;
}

/**
 * store 连接层。
 *
 * 与 View 分离的原因：zustand v5 的 useStore 在服务端渲染时走 getServerSnapshot
 * → getInitialState()，renderToStaticMarkup 永远只能看到初始空状态，无法对
 * store 驱动的分支做渲染断言。把纯展示逻辑收进 View（props 驱动）后即可测试。
 */
// projectId 预留给后续操作鉴权使用，当前面板只读本地 store
export default function PropertiesPanel() {
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const { nodes, applyLocal } = useNodesStore();

  return (
    <PropertiesPanelView
      selectedNodeIds={selectedNodeIds as Uuid[]}
      node={nodes[selectedNodeIds[0] as Uuid]}
      onApply={applyLocal}
      onDelete={deleteSelectedNodes}
    />
  );
}

/** 纯展示层：不读 store，可用 renderToStaticMarkup 直接断言 */
export function PropertiesPanelView({ selectedNodeIds, node, onApply, onDelete }: PropertiesPanelViewProps) {
  if (selectedNodeIds.length === 0) return null;
  if (!node) return null;

  // const 别名：参数绑定的收窄不会传递进下面的闭包（TS18048）
  const n = node;
  const multiSelect = selectedNodeIds.length > 1;

  function handleMove(axis: 'x' | 'y', value: number) {
    const delta = {
      x: axis === 'x' ? value - n.position.x : 0,
      y: axis === 'y' ? value - n.position.y : 0,
    };
    const op: ClientOperation = {
      type: 'move_nodes',
      operationId: crypto.randomUUID() as Uuid,
      payload: { nodeIds: selectedNodeIds as Uuid[], delta },
    };
    onApply(op);
  }

  function handleSize(dim: 'x' | 'y', value: number) {
    const op: ClientOperation = {
      type: 'resize_nodes',
      operationId: crypto.randomUUID() as Uuid,
      payload: {
        nodeIds: selectedNodeIds as Uuid[],
        size: dim === 'x' ? { x: value, y: n.size.y } : { x: n.size.x, y: value },
      },
    };
    onApply(op);
  }

  function handleLockToggle() {
    const op: ClientOperation = {
      type: 'set_nodes_locked',
      operationId: crypto.randomUUID() as Uuid,
      payload: { nodeIds: selectedNodeIds as Uuid[], locked: !n.locked },
    };
    onApply(op);
  }

  function handleDelete() {
    onDelete(selectedNodeIds as Uuid[]);
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        zIndex: 10,
        width: 220,
        background: '#1e1e28',
        borderRadius: 10,
        padding: 16,
        color: '#e0e0ea',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div style={{ color: '#8a8a9a', fontSize: 11, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
        {multiSelect ? `${selectedNodeIds.length} 个节点` : node.nodeType}
      </div>

      {!multiSelect && (
        <>
          {/* 位置 */}
          <Row label="X">
            <NumInput value={Math.round(node.position.x)} onChange={(v) => handleMove('x', v)} />
          </Row>
          <Row label="Y">
            <NumInput value={Math.round(node.position.y)} onChange={(v) => handleMove('y', v)} />
          </Row>

          <Divider />

          {/* 尺寸 */}
          <Row label="宽">
            <NumInput value={Math.round(node.size.x)} onChange={(v) => handleSize('x', v)} />
          </Row>
          <Row label="高">
            <NumInput value={Math.round(node.size.y)} onChange={(v) => handleSize('y', v)} />
          </Row>

          <Divider />

          {/* 锁定 */}
          <Row label="锁定">
            <button
              onClick={handleLockToggle}
              style={{
                padding: '4px 10px',
                background: node.locked ? '#3a3a4a' : 'transparent',
                color: node.locked ? '#e0e0ea' : '#8a8a9a',
                border: '1px solid #3a3a4a',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {node.locked ? '🔒 已锁' : '🔓 未锁'}
            </button>
          </Row>

          <Divider />

          {/* 删除 */}
          <button
            onClick={handleDelete}
            style={{
              padding: '8px 12px',
              background: '#3a2028',
              color: '#e08090',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
              width: '100%',
            }}
          >
            🗑️ 删除节点
          </button>
        </>
      )}

      {multiSelect && (
        <>
          <div style={{ color: '#8a8a9a', fontSize: 12, marginBottom: 12 }}>
            批量选中，支持整体移动和调整大小。
          </div>
          <button
            onClick={handleDelete}
            style={{
              padding: '8px 12px',
              background: '#3a2028',
              color: '#e08090',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
              width: '100%',
            }}
          >
            🗑️ 删除 {selectedNodeIds.length} 个节点
          </button>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
      <span style={{ color: '#8a8a9a', fontSize: 12 }}>{label}</span>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: '1px solid #2a2a3a', margin: '10px 0' }} />;
}

function NumInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      defaultValue={value}
      key={value} // 当外部值变化时重置输入框
      onBlur={(e) => {
        const n = parseInt(e.target.value, 10);
        if (!isNaN(n)) onChange(n);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const n = parseInt((e.target as HTMLInputElement).value, 10);
          if (!isNaN(n)) onChange(n);
        }
      }}
      style={{
        width: 70,
        padding: '4px 8px',
        background: '#2a2a3a',
        color: '#e0e0ea',
        border: '1px solid #3a3a4a',
        borderRadius: 4,
        fontSize: 12,
        textAlign: 'right',
      }}
    />
  );
}
