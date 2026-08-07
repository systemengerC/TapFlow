/**
 * Leafer 画布容器。
 *
 * 职责边界：
 *   - 只负责「几何渲染」——把 nodesStore 的节点画成 Leafer 图形并同步 viewport。
 *   - 媒体内容（图片/视频）走 DOM Overlay（<img>/<video>），不在 Leafer 里解码，
 *     符合「客户端渲染、服务端只存文件」的产品约束。
 *   - Leafer 只能在浏览器实例化，故本组件必须由 next/dynamic ssr:false 挂载。
 *   - 选择/创建交互回传给上层（workspace page），本组件不持有业务逻辑。
 */
'use client';

import { useEffect, useRef } from 'react';
import { Leafer, Rect, Text } from 'leafer-ui';
import { useNodesStore } from '../../lib/stores/nodesStore';
import { useCanvasStore } from '../../lib/stores/canvasStore';

interface LeaferCanvasProps {
  /** create 工具模式下点击空白处 → 传回画布坐标以创建节点 */
  onCanvasClick?: (x: number, y: number) => void;
  /** select 模式下点击空白处 → 清除选择 */
  onCanvasEmpty?: () => void;
}

export default function LeaferCanvas({ onCanvasClick, onCanvasEmpty }: LeaferCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const leaferRef = useRef<Leafer | null>(null);
  // 最新的回调用 ref 持有，避免频繁重建 Leafer 实例
  const cbRef = useRef({ onCanvasClick, onCanvasEmpty });
  useEffect(() => {
    cbRef.current = { onCanvasClick, onCanvasEmpty };
  });

  // 挂载：创建 Leafer 实例
  useEffect(() => {
    if (!containerRef.current) return;
    const leafer = new Leafer({ view: containerRef.current });
    leaferRef.current = leafer;

    // 视口变化回写 store
    leafer.on('move', () => {
      useCanvasStore.getState().setViewport({
        x: leafer.x ?? 0,
        y: leafer.y ?? 0,
        scale: typeof leafer.scale === 'number' ? leafer.scale : 1,
      });
    });

    // 画布点击：命中空白处 → 依当前工具分发
    leafer.on('tap', (e: { x?: number; y?: number; target?: unknown }) => {
      // 命中节点由节点自身的 tap 处理（见重绘逻辑），这里只处理空白
      if (e.target !== leafer) return;
      const tool = useCanvasStore.getState().tool;
      const px = e.x ?? 0;
      const py = e.y ?? 0;
      if (tool === 'create') {
        cbRef.current.onCanvasClick?.(px, py);
      } else {
        cbRef.current.onCanvasEmpty?.();
      }
    });

    return () => {
      leafer.destroy();
      leaferRef.current = null;
    };
  }, []);

  // 节点 / 选择变化 → 重绘。最小实现：全量清空重建；后续按 diff 优化。
  useEffect(() => {
    const render = (state: {
      nodes: Record<string, import('../../lib/stores/nodesStore').CanvasNode>;
    }) => {
      const leafer = leaferRef.current;
      if (!leafer) return;
      const selected = new Set(useCanvasStore.getState().selectedNodeIds);
      leafer.clear();

      for (const node of Object.values(state.nodes)) {
        const isSelected = selected.has(node.id);
        const rect = new Rect({
          x: node.position.x,
          y: node.position.y,
          width: node.size.x,
          height: node.size.y,
          rotation: node.rotation,
          fill: '#1e1e28',
          stroke: isSelected ? '#5a7fff' : '#3a3a4a',
          strokeWidth: isSelected ? 2 : 1,
          cornerRadius: 8,
        });
        rect.on('tap', () => {
          const tool = useCanvasStore.getState().tool;
          if (tool === 'select') {
            useCanvasStore.getState().setSelection([node.id]);
          }
        });
        leafer.add(rect);

        const label = new Text({
          x: node.position.x + 12,
          y: node.position.y + 12,
          text: node.nodeType,
          fill: '#8a8a9a',
          fontSize: 12,
        });
        leafer.add(label);
      }
    };

    // 首帧
    render(useNodesStore.getState());
    // 节点变化订阅
    const unsubNodes = useNodesStore.subscribe(render);
    // 选择变化也要重绘
    const unsubSel = useCanvasStore.subscribe(() => render(useNodesStore.getState()));
    return () => {
      unsubNodes();
      unsubSel();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, background: '#0f0f14' }}
    />
  );
}
