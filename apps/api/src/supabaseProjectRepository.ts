/**
 * Supabase 项目存储实现
 * - list: 查询 projects 表（RLS 按 auth.uid() 过滤）
 * - create: 调用 create_project RPC（自动写入 projects + 返回行）
 * - getSnapshot: 查询 projects + canvas_nodes + canvas_edges
 */
import {
  type CreateProjectRequest,
  type Project,
  type ProjectSnapshotResponse,
  type Uuid,
} from '@tapflow/contracts';

import { ProjectNotFoundError, type ProjectRepository } from './projectRepository.ts';
import { UnauthorizedError } from './app.ts';

type Options = {
  supabaseUrl: string;
  anonKey: string;
  fetcher?: typeof fetch;
};

type ProjectRow = {
  id: string;
  name: string;
  canvas_version: number;
  created_at: string;
};

type NodeRow = {
  id: string;
  node_type: 'text' | 'image' | 'video' | 'audio' | 'generation_job' | 'group' | 'document';
  parent_node_id: string | null;
  position: { x: number; y: number } | null;
  size: { width: number; height: number } | null;
  data: unknown;
  job_id: string | null;
};

type EdgeRow = {
  id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: 'reference' | 'input' | 'derived_from';
};

export class SupabaseProjectRepository implements ProjectRepository {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly fetcher: typeof fetch;

  constructor({ supabaseUrl, anonKey, fetcher = fetch }: Options) {
    this.baseUrl = supabaseUrl.replace(/\/$/, '');
    this.anonKey = anonKey;
    this.fetcher = fetcher;
  }

  async list(authorization?: string): Promise<Project[]> {
    const rows = await this.get<ProjectRow[]>('/rest/v1/projects?select=id,name,canvas_version,created_at&order=created_at.desc', authorization);
    return rows.map((row) => this.toProject(row));
  }

  async create(request: CreateProjectRequest, authorization?: string): Promise<Project> {
    const response = await this.fetchRpc('create_project', { p_name: request.name }, authorization);
    if (!response.ok) {
      throw await this.toError(response, 'create_project');
    }
    const row = await response.json() as ProjectRow;
    return this.toProject(row);
  }

  async getSnapshot(projectId: string, authorization?: string): Promise<ProjectSnapshotResponse> {
    const projectRows = await this.get<ProjectRow[]>(
      `/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=id,name,canvas_version,created_at`,
      authorization,
    );
    if (projectRows.length !== 1) {
      throw new ProjectNotFoundError(projectId);
    }
    const [nodes, edges] = await Promise.all([
      this.get<NodeRow[]>(
        `/rest/v1/canvas_nodes?project_id=eq.${encodeURIComponent(projectId)}&select=id,node_type,parent_node_id,position,size,data,job_id&order=created_at.asc`,
        authorization,
      ),
      this.get<EdgeRow[]>(
        `/rest/v1/canvas_edges?project_id=eq.${encodeURIComponent(projectId)}&select=id,source_node_id,target_node_id,edge_type`,
        authorization,
      ),
    ]);

    return {
      project: this.toProject(projectRows[0]),
      nodes: nodes.map((row) => ({
        id: row.id as Uuid,
        nodeType: row.node_type,
        parentNodeId: row.parent_node_id as Uuid | null,
        position: row.position,
        size: row.size,
        data: row.data,
        jobId: row.job_id as Uuid | null,
      })),
      edges: edges.map((row) => ({
        id: row.id as Uuid,
        sourceNodeId: row.source_node_id as Uuid,
        targetNodeId: row.target_node_id as Uuid,
        edgeType: row.edge_type,
      })),
    };
  }

  async saveSnapshot(): Promise<void> {
    // 快照写入由 apply_project_operations 事务完成；此处仅为接口完整性
    throw new Error('saveSnapshot is not supported on Supabase — use apply_project_operations');
  }

  private toProject(row: ProjectRow): Project {
    return {
      id: row.id as Uuid,
      name: row.name,
      canvasVersion: row.canvas_version,
      createdAt: row.created_at,
    };
  }

  private async get<T>(path: string, authorization?: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: this.headers(authorization),
    });
    if (!response.ok) {
      throw await this.toError(response, path);
    }
    return response.json() as Promise<T>;
  }

  private fetchRpc(rpcName: string, body: Record<string, unknown>, authorization?: string): Promise<Response> {
    return this.fetcher(`${this.baseUrl}/rest/v1/rpc/${rpcName}`, {
      method: 'POST',
      headers: this.headers(authorization),
      body: JSON.stringify(body),
    });
  }

  private async toError(response: Response, context: string): Promise<Error> {
    if (response.status === 401) {
      return new UnauthorizedError('Authorization is required for Supabase access');
    }
    const error = await response.json().catch(() => ({})) as { message?: string; code?: string };
    if (response.status === 404) {
      return new ProjectNotFoundError(context);
    }
    return new Error(error.message ?? `Supabase request failed: ${context} (HTTP ${response.status})`);
  }

  private headers(authorization?: string): HeadersInit {
    const headers: HeadersInit = {
      apikey: this.anonKey,
      'content-type': 'application/json',
    };
    if (authorization) {
      (headers as Record<string, string>).authorization = authorization;
    }
    return headers;
  }
}
