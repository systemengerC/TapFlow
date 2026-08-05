/**
 * /workspace — 工作台主页面。
 * 画布 + DOM Overlay 层叠容器。
 */
'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { useNodesStore, type CanvasNode } from '@/lib/stores/nodesStore';

// Leafer 只能客户端实例化
const LeaferCanvas = dynamic(() => import('@/components/canvas/LeaferCanvas'), {
  ssr: false,
});

export default function WorkspacePage() {
  // 首次加载：填充一个示例节点（后续改为从 API 拉快照）
  useEffect(() => {
    const { nodes, replaceSnapshot } = useNodesStore.getState();
    if (Object.keys(nodes).length === 0) {
      const demoNode: CanvasNode = {
        id: crypto.randomUUID(),
        nodeType: 'text',
        position: { x: 100, y: 100 },
        size: { x: 320, y: 240 },
        rotation: 0,
        zIndex: 0,
        locked: false,
        data: { content: '欢迎使用 TapFlow' },
        parentNodeId: null,
      };
      replaceSnapshot([demoNode], [], 0);
    }
  }, []);

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      {/* 画布层 */}
      <LeaferCanvas />
      
      {/* DOM Overlay 层（工具栏 + 属性面板，后续实现） */}
      <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10 }}>
        <div style={{ 
          padding: '8px 16px', 
          background: '#1e1e28', 
          color: '#8a8a9a',
          borderRadius: 8,
          fontSize: 14,
        }}>
          TapFlow Workspace
        </div>
      </div>
    </div>
  );
}
