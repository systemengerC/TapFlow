/**
 * 工作台客户端实体——包含 useSearchParams 和所有交互逻辑。
 * 由 page.tsx 用 <Suspense> 包裹后挂载。
 */
'use client';

import dynamic from 'next/dynamic';
import { useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useProject } from '@/lib/hooks/useProject';
import { useApplyOperations } from '@/lib/hooks/useApplyOperations';
import { useNodesStore } from '@/lib/stores/nodesStore';
import { useCanvasStore } from '@/lib/stores/canvasStore';
import Toolbar from '@/components/ui/Toolbar';
import PropertiesPanel from '@/components/ui/PropertiesPanel';
import UploadButton from '@/components/ui/UploadButton';
import JobsPanel from '@/components/ui/JobsPanel';
import type { ClientOperation, Uuid, AssetType, Job, JobOutputRef } from '@tapflow/contracts';

// Leafer 只能客户端实例化
const LeaferCanvas = dynamic(() => import('@/components/canvas/LeaferCanvas'), {
  ssr: false,
});
const NodesOverlay = dynamic(() => import('@/components/canvas/NodesOverlay'), {
  ssr: false,
});

export default function WorkspaceClient() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get('id');

  const { project, loading, error, loadSnapshot, createProject } = useProject();
  const { flush, flushing, error: saveError } = useApplyOperations(projectId);
  const { tool, clearSelection } = useCanvasStore();
  const { applyLocal, pendingOperations } = useNodesStore();

  // 首次加载：从 URL 读项目 ID 并加载快照；若无则创建新项目
  useEffect(() => {
    if (loading) return;
    if (projectId) {
      loadSnapshot(projectId);
    } else {
      createProject('新项目').then((proj) => {
        if (proj) {
          useNodesStore.getState().replaceSnapshot([], [], proj.canvasVersion);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 自动保存：每 3 秒 flush 一次待提交操作
  useEffect(() => {
    if (pendingOperations.length === 0 || !projectId) return;
    const timer = setTimeout(() => {
      flush().catch(() => {
        // useApplyOperations 已处理错误状态，这里只消费 promise 避免 unhandled rejection
      });
    }, 3000);
    return () => clearTimeout(timer);
  }, [pendingOperations.length, projectId, flush]);

  // create 工具模式下，在点击坐标创建节点
  const handleCanvasClick = useCallback(
    (x: number, y: number) => {
      if (tool !== 'create') return;
      const op: ClientOperation = {
        type: 'create_node',
        operationId: crypto.randomUUID() as Uuid,
        payload: {
          nodeType: 'text',
          position: { x, y },
          size: { x: 200, y: 150 },
          data: { content: '新节点' },
          parentNodeId: null,
        },
      };
      applyLocal(op);
    },
    [tool, applyLocal],
  );

  // 点击画布空白处 → 清除选择
  const handleCanvasEmpty = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  // 上传完成 → 在画布上创建对应素材节点
  const handleUploaded = useCallback(
    (assetId: string, assetType: AssetType, file: File) => {
      // 契约 nodeType 枚举不含 thumbnail，归一到 image
      const nodeType = assetType === 'thumbnail' ? 'image' : assetType;
      const op: ClientOperation = {
        type: 'create_node',
        operationId: crypto.randomUUID() as Uuid,
        payload: {
          nodeType,
          position: { x: 120, y: 120 },
          size: { x: 320, y: 240 },
          data: { assetId, fileName: file.name, mimeType: file.type },
          parentNodeId: null,
        },
      };
      applyLocal(op);
    },
    [applyLocal],
  );

  // Job 成功 → 落一个 generation_job 节点承载输出
  const handleJobSucceeded = useCallback(
    (job: Job, outputs: JobOutputRef[]) => {
      const op: ClientOperation = {
        type: 'create_node',
        operationId: crypto.randomUUID() as Uuid,
        payload: {
          nodeType: 'generation_job',
          position: { x: 480, y: 120 },
          size: { x: 320, y: 240 },
          data: {
            jobId: job.id,
            jobType: job.jobType,
            model: job.model,
            assetIds: outputs.map((o) => o.assetId),
          },
          parentNodeId: null,
        },
      };
      applyLocal(op);
    },
    [applyLocal],
  );

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: '#8a8a9a',
          background: '#0f0f14',
        }}
      >
        加载中...
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: '#e08090',
          background: '#0f0f14',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div>❌ {error}</div>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 16px',
            background: '#3a3a4a',
            color: '#e0e0ea',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          重新加载
        </button>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      {/* 画布层 */}
      <LeaferCanvas onCanvasClick={handleCanvasClick} onCanvasEmpty={handleCanvasEmpty} />

      {/* 节点覆盖层（媒体预览） */}
      <NodesOverlay />

      {/* DOM Overlay 层 */}
      <Toolbar project={project} saving={flushing} saveError={saveError} onSave={flush}>
        <UploadButton projectId={projectId} onUploaded={handleUploaded} />
      </Toolbar>
      <PropertiesPanel />
      <JobsPanel projectId={projectId} onJobSucceeded={handleJobSucceeded} />
    </div>
  );
}
