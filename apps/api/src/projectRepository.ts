/**
 * 项目存储接口 + 内存实现
 * P0 范围：项目列表 / 创建 / 快照加载（节点 + 边）
 * Supabase 实现见 supabaseProjectRepository.ts
 */
import { randomUUID } from 'node:crypto';

import {
  type CreateProjectRequest,
  type Project,
  type ProjectSnapshotResponse,
  type Uuid,
} from '@tapflow/contracts';

export type NodeSnapshotInput = ProjectSnapshotResponse['nodes'][number];
export type EdgeSnapshotInput = ProjectSnapshotResponse['edges'][number];

export interface ProjectRepository {
  list(authorization?: string): Promise<Project[]>;
  create(request: CreateProjectRequest, authorization?: string): Promise<Project>;
  getSnapshot(projectId: string, authorization?: string): Promise<ProjectSnapshotResponse>;
  saveSnapshot(projectId: string, snapshot: { nodes: NodeSnapshotInput[]; edges: EdgeSnapshotInput[] }): Promise<void>;
}

type ProjectRow = Project & { nodes: NodeSnapshotInput[]; edges: EdgeSnapshotInput[] };

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, ProjectRow>();

  async list(): Promise<Project[]> {
    return [...this.projects.values()]
      .map(({ nodes: _n, edges: _e, ...project }) => project)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(request: CreateProjectRequest): Promise<Project> {
    const project: ProjectRow = {
      id: randomUUID() as Uuid,
      name: request.name,
      canvasVersion: 0,
      createdAt: new Date().toISOString(),
      nodes: [],
      edges: [],
    };
    this.projects.set(project.id, project);
    return { id: project.id, name: project.name, canvasVersion: project.canvasVersion, createdAt: project.createdAt };
  }

  async getSnapshot(projectId: string): Promise<ProjectSnapshotResponse> {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }
    return {
      project: { id: project.id, name: project.name, canvasVersion: project.canvasVersion, createdAt: project.createdAt },
      nodes: project.nodes,
      edges: project.edges,
    };
  }

  async saveSnapshot(projectId: string, snapshot: { nodes: NodeSnapshotInput[]; edges: EdgeSnapshotInput[] }): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }
    project.nodes = snapshot.nodes;
    project.edges = snapshot.edges;
  }

  /**
   * 原子提交：节点/边与画布版本在同一个同步块内更新（内存模式无 I/O，无 await 间隙，
   * JS 事件循环内不可能被读取/写入穿插），保证快照内容与版本永远一致。
   * operations 提交路径必须走此方法，禁止拆成 saveSnapshot + bumpCanvasVersion 两次调用。
   */
  async commitSnapshot(
    projectId: string,
    snapshot: { nodes: NodeSnapshotInput[]; edges: EdgeSnapshotInput[] },
    canvasVersion: number,
  ): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }
    project.nodes = snapshot.nodes;
    project.edges = snapshot.edges;
    project.canvasVersion = canvasVersion;
  }

  /** 仅内存模式联调用：operations 提交成功后同步推进画布版本，保证快照读路径一致。 */
  async bumpCanvasVersion(projectId: string, canvasVersion: number): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }
    project.canvasVersion = canvasVersion;
  }
}

export class ProjectNotFoundError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`Project ${projectId} was not found`);
    this.name = 'ProjectNotFoundError';
    this.projectId = projectId;
  }
}
