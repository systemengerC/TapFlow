/**
 * 节点覆盖层：在 Leafer 画布上方叠加 React 组件渲染节点内容。
 * 用于显示图片、视频等媒体预览。
 * 同步 Leafer viewport 的平移和缩放。
 */
'use client';

import { useNodesStore } from '@/lib/stores/nodesStore';
import { useCanvasStore } from '@/lib/stores/canvasStore';
import AssetPreview from '@/components/ui/AssetPreview';
import type { Uuid } from '@tapflow/contracts';

export default function NodesOverlay() {
  const nodes = useNodesStore((state) => Object.values(state.nodes));
  const viewport = useCanvasStore((state) => state.viewport);

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {nodes.map((node) => {
        // 只渲染有 assetIds 的 generation_job 节点
        if (node.nodeType !== 'generation_job') return null;
        const assetIds = (node.data as { assetIds?: Uuid[] })?.assetIds;
        if (!assetIds || assetIds.length === 0) return null;

        return (
          <div
            key={node.id}
            style={{
              position: 'absolute',
              left: node.position.x * viewport.scale + viewport.x,
              top: node.position.y * viewport.scale + viewport.y,
              width: node.size.x * viewport.scale,
              height: node.size.y * viewport.scale,
              padding: 8 * viewport.scale,
              pointerEvents: 'auto',
              overflow: 'hidden',
            }}
          >
            <AssetPreview assetId={assetIds[0]} />
          </div>
        );
      })}
    </div>
  );
}
