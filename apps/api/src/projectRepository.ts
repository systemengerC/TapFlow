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
}

export class ProjectNotFoundError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`Project ${projectId} was not found`);
    this.name = 'ProjectNotFoundError';
    this.projectId = projectId;
  }
}
