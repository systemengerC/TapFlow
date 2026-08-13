/**
 * 节点覆盖层：在 Leafer 画布上方叠加 React 组件渲染节点内容。
 * 用于显示图片、视频等媒体预览。
 */
'use client';

import { useNodesStore } from '@/lib/stores/nodesStore';
import AssetPreview from '@/components/ui/AssetPreview';
import type { Uuid } from '@tapflow/contracts';

export default function NodesOverlay() {
  const nodes = useNodesStore((state) => Object.values(state.nodes));

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
              left: node.position.x,
              top: node.position.y,
              width: node.size.x,
              height: node.size.y,
              padding: 8,
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
