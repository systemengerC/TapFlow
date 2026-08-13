/**
 * 项目加载 / 创建 hook。
 *
 * 职责：
 *   - GET /api/projects/:id/snapshot → 解析契约 → replaceSnapshot 注入 nodesStore
 *   - GET /api/projects → 项目列表
 *   - POST /api/projects → 创建项目
 * 不持有渲染逻辑；错误和 loading 状态通过返回值暴露给 UI。
 */
'use client';

import { useCallback, useState } from 'react';
import {
  ProjectSnapshotResponseSchema,
  ListProjectsResponseSchema,
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  GetJobResponseSchema,
  ErrorResponseSchema,
  type Project,
} from '@tapflow/contracts';
import { useNodesStore, type CanvasNode, type CanvasEdge } from '../stores/nodesStore';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

async function parseError(res: Response): Promise<string> {
  const body = ErrorResponseSchema.safeParse(await res.json().catch(() => null));
  return body.success ? body.data.error.message : `HTTP ${res.status}`;
}

export function useProject() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  /** 加载项目快照并注入 nodesStore */
  const loadSnapshot = useCallback(async (projectId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}`);
      if (!res.ok) throw new Error(await parseError(res));
      const parsed = ProjectSnapshotResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error(`契约解析失败: ${parsed.error.issues[0]?.message}`);

      const { project: proj, nodes: rawNodes, edges: rawEdges } = parsed.data;

      // 快照节点字段 → 本地 CanvasNode（size: width/height → x/y）
      const nodes: CanvasNode[] = rawNodes.map((n) => ({
        id: n.id,
        nodeType: n.nodeType,
        position: n.position ?? { x: 0, y: 0 },
        size: n.size ? { x: n.size.width, y: n.size.height } : { x: 320, y: 320 },
        rotation: 0,
        zIndex: 0,
        locked: false,
        data: n.data,
        parentNodeId: n.parentNodeId,
      }));

      const edges: CanvasEdge[] = rawEdges.map((e) => ({
        id: e.id,
        edgeType: e.edgeType,
        sourceNodeId: e.sourceNodeId,
        targetNodeId: e.targetNodeId,
      }));

      useNodesStore.getState().replaceSnapshot(nodes, edges, proj.canvasVersion);
      setProject(proj);

      // 刷新恢复：对只有 jobId 没有 assetIds 的 generation_job 节点，调 getJob 回填 outputs
      await Promise.all(
        nodes
          .filter(
            (n) =>
              n.nodeType === 'generation_job' &&
              typeof (n.data as { jobId?: string })?.jobId === 'string' &&
              ((n.data as { assetIds?: string[] })?.assetIds?.length ?? 0) === 0
          )
          .map(async (node) => {
            try {
              const jobId = (node.data as { jobId: string }).jobId;
              const res = await fetch(`${API_BASE}/api/jobs/${jobId}`);
              if (!res.ok) return;
              const parsedJob = GetJobResponseSchema.safeParse(await res.json());
              if (!parsedJob.success || parsedJob.data.outputs.length === 0) return;
              const outputs = parsedJob.data.outputs;
              if (outputs.length > 0) {
                // 更新节点 data，补上 assetIds
                useNodesStore.getState().applyLocal({
                  type: 'update_node',
                  operationId: crypto.randomUUID() as import('@tapflow/contracts').Uuid,
                  payload: {
                    nodeId: node.id,
                    patch: { assetIds: outputs.map((o) => o.assetId) },
                  },
                });
              }
            } catch {
              // 忽略单个节点恢复失败
            }
          })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 获取项目列表 */
  const listProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects`);
      if (!res.ok) throw new Error(await parseError(res));
      const parsed = ListProjectsResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error(`契约解析失败: ${parsed.error.issues[0]?.message}`);
      setProjects(parsed.data.projects);
      return parsed.data.projects;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  /** 创建新项目 */
  const createProject = useCallback(async (name: string): Promise<Project | null> => {
    const reqParsed = CreateProjectRequestSchema.safeParse({ name });
    if (!reqParsed.success) {
      setError(`项目名无效: ${reqParsed.error.issues[0]?.message}`);
      return null;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reqParsed.data),
      });
      if (!res.ok) throw new Error(await parseError(res));
      const parsed = CreateProjectResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error(`契约解析失败: ${parsed.error.issues[0]?.message}`);
      const created = parsed.data;
      setProject(created);
      setProjects((prev) => [created, ...prev]);
      return created;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { project, projects, loading, error, loadSnapshot, listProjects, createProject };
}
