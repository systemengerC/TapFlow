/**
 * Leafer 画布容器。
 *
 * 职责边界：
 *   - 只负责「几何渲染」——把 nodesStore 的节点画成 Leafer 图形并同步 viewport。
 *   - 媒体内容（图片/视频）走 DOM Overlay（<img>/<video>），不在 Leafer 里解码，
 *     符合「客户端渲染、服务端只存文件」的产品约束。
 *   - Leafer 只能在浏览器实例化，故本组件必须由 next/dynamic ssr:false 挂载。
 */
'use client';

import { useEffect, useRef } from 'react';
import { Leafer, Rect, Text } from 'leafer-ui';
import { useNodesStore } from '../../lib/stores/nodesStore';
import { useCanvasStore } from '../../lib/stores/canvasStore';

export default function LeaferCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const leaferRef = useRef<Leafer | null>(null);

  // 挂载：创建 Leafer 实例
  useEffect(() => {
    if (!containerRef.current) return;
    const leafer = new Leafer({ view: containerRef.current });
    leaferRef.current = leafer;

    // 视口变化回写 store（滚轮缩放 / 拖拽平移由 Leafer 内建 move 事件驱动）
    leafer.on('move', () => {
      useCanvasStore.getState().setViewport({
        x: leafer.x ?? 0,
        y: leafer.y ?? 0,
        scale: typeof leafer.scale === 'number' ? leafer.scale : 1,
      });
    });

    return () => {
      leafer.destroy();
      leaferRef.current = null;
    };
  }, []);

  // 节点变化 → 重绘。最小实现：全量清空重建；后续按 diff 优化。
  useEffect(() => {
    const unsub = useNodesStore.subscribe((state) => {
      const leafer = leaferRef.current;
      if (!leafer) return;
      leafer.clear();

      for (const node of Object.values(state.nodes)) {
        const rect = new Rect({
          x: node.position.x,
          y: node.position.y,
          width: node.size.x,
          height: node.size.y,
          rotation: node.rotation,
          fill: '#1e1e28',
          stroke: '#3a3a4a',
          strokeWidth: 1,
          cornerRadius: 8,
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
    });
    return unsub;
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, background: '#0f0f14' }}
    />
  );
}
