/**
 * 工具栏：工具切换 + 项目标题 + 保存状态。
 */
'use client';

import { useCanvasStore, type CanvasTool } from '@/lib/stores/canvasStore';
import { useNodesStore } from '@/lib/stores/nodesStore';
import type { Project } from '@tapflow/contracts';

interface ToolbarProps {
  project: Project | null;
  saving?: boolean;
  saveError?: string | null;
  onSave?: () => void;
  children?: React.ReactNode;
}

export default function Toolbar({ project, saving, saveError, onSave, children }: ToolbarProps) {
  const { tool, setTool } = useCanvasStore();
  const pendingCount = useNodesStore((s) => s.pendingOperations.length);

  const tools: { id: CanvasTool; label: string; icon: string }[] = [
    { id: 'select', label: '选择', icon: '⌖' },
    { id: 'pan', label: '平移', icon: '✋' },
    { id: 'create', label: '创建', icon: '➕' },
  ];

  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        left: 16,
        zIndex: 10,
        display: 'flex',
        gap: 12,
        alignItems: 'center',
      }}
    >
      {/* 工具按钮组 */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          background: '#1e1e28',
          padding: 4,
          borderRadius: 8,
        }}
      >
        {tools.map((t) => (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            style={{
              padding: '8px 12px',
              background: tool === t.id ? '#3a3a4a' : 'transparent',
              color: tool === t.id ? '#e0e0ea' : '#8a8a9a',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 500,
              transition: 'all 0.15s',
            }}
            title={t.label}
          >
            {t.icon}
          </button>
        ))}
      </div>

      {/* 项目标题 */}
      {project && (
        <div
          style={{
            padding: '8px 16px',
            background: '#1e1e28',
            color: '#e0e0ea',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          {project.name}
        </div>
      )}

      {/* 额外插槽（如上传按钮） */}
      {children}

      {/* 保存状态 */}
      {(pendingCount > 0 || saving || saveError) && (
        <div
          style={{
            padding: '8px 16px',
            background: saveError ? '#3a2028' : '#1e1e28',
            color: saveError ? '#e08090' : '#8a8a9a',
            borderRadius: 8,
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {saving ? (
            <>⏳ 保存中...</>
          ) : saveError ? (
            <>⚠️ {saveError}</>
          ) : (
            <>📝 {pendingCount} 项待保存</>
          )}
          {onSave && pendingCount > 0 && !saving && (
            <button
              onClick={onSave}
              style={{
                padding: '4px 8px',
                background: '#3a3a4a',
                color: '#e0e0ea',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              保存
            </button>
          )}
        </div>
      )}
    </div>
  );
}
