/**
 * 属性面板：显示选中节点的基础属性，支持简单编辑。
 * 挂载在 DOM Overlay 层，与画布解耦。
 */
'use client';

import { useCanvasStore } from '@/lib/stores/canvasStore';
import { useNodesStore } from '@/lib/stores/nodesStore';
import type { ClientOperation, Uuid } from '@tapflow/contracts';

// projectId 预留给后续操作鉴权使用，当前面板只读本地 store
export default function PropertiesPanel() {
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const { nodes, applyLocal } = useNodesStore();

  if (selectedNodeIds.length === 0) return null;

  const firstId = selectedNodeIds[0] as Uuid;
  const node = nodes[firstId];
  if (!node) return null;

  const multiSelect = selectedNodeIds.length > 1;

  function handleMove(axis: 'x' | 'y', value: number) {
    const delta = {
      x: axis === 'x' ? value - node.position.x : 0,
      y: axis === 'y' ? value - node.position.y : 0,
    };
    const op: ClientOperation = {
      type: 'move_nodes',
      operationId: crypto.randomUUID() as Uuid,
      payload: { nodeIds: selectedNodeIds as Uuid[], delta },
    };
    applyLocal(op);
  }

  function handleSize(dim: 'x' | 'y', value: number) {
    const op: ClientOperation = {
      type: 'resize_nodes',
      operationId: crypto.randomUUID() as Uuid,
      payload: {
        nodeIds: selectedNodeIds as Uuid[],
        size: dim === 'x' ? { x: value, y: node.size.y } : { x: node.size.x, y: value },
      },
    };
    applyLocal(op);
  }

  function handleLockToggle() {
    const op: ClientOperation = {
      type: 'set_nodes_locked',
      operationId: crypto.randomUUID() as Uuid,
      payload: { nodeIds: selectedNodeIds as Uuid[], locked: !node.locked },
    };
    applyLocal(op);
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
        </>
      )}

      {multiSelect && (
        <div style={{ color: '#8a8a9a', fontSize: 12 }}>
          批量选中，支持整体移动和调整大小。
        </div>
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
