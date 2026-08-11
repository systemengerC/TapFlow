import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  ApplyOperationsRequestSchema,
  ApplyOperationsResponseSchema,
  CancelJobResponseSchema,
  CreateJobRequestSchema,
  CreateJobResponseSchema,
  CreateProjectRequestSchema,
  ErrorResponseSchema,
  GetJobResponseSchema,
  ListJobsResponseSchema,
  ListProjectsResponseSchema,
  PresignUploadRequestSchema,
  ProjectSnapshotResponseSchema,
  UuidSchema,
  type ApplyOperationsRequest,
  type ApplyOperationsResponse,
  type PresignUploadRequest,
  type ProjectSnapshotResponse,
} from '@tapflow/contracts';

import { InMemoryProjectRepository, ProjectNotFoundError, type ProjectRepository } from './projectRepository.ts';
import { JobNotFoundError, JobStateTransitionError, JobValidationError, type JobRepository } from './jobRepository.ts';
import {
  UploadNotFoundError,
  UploadValidationError,
  type UploadRepository,
} from './uploadRepository.ts';

const MAX_REQUEST_BYTES = 256 * 1024;
const OPERATIONS_ROUTE = /^\/api\/projects\/([^/]+)\/operations$/;
const PROJECT_ROUTE = /^\/api\/projects$/;
const PROJECT_SNAPSHOT_ROUTE = /^\/api\/projects\/([^/]+)$/;
const PRESIGN_UPLOAD_ROUTE = /^\/api\/assets\/presign-upload$/;
const COMPLETE_UPLOAD_ROUTE = /^\/api\/assets\/([^/]+)\/complete$/;
const JOBS_ROUTE = /^\/api\/jobs$/;
const JOB_DETAIL_ROUTE = /^\/api\/jobs\/([^/]+)$/;
const JOB_CANCEL_ROUTE = /^\/api\/jobs\/([^/]+)\/cancel$/;
const PROJECT_JOBS_ROUTE = /^\/api\/projects\/([^/]+)\/jobs$/;

export interface OperationsRepository {
  apply(
    projectId: string,
    request: ApplyOperationsRequest,
    authorization?: string,
  ): Promise<ApplyOperationsResponse>;
}

export class VersionConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super('Canvas version does not match baseVersion');
    this.name = 'VersionConflictError';
    this.currentVersion = currentVersion;
  }
}

/** 操作语义校验失败（非并发冲突）：nodeType 非法 / 引用不存在 / 重复 id / 快照无法持久化的操作类型。 */
export class OperationValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OperationValidationError';
    this.code = code;
  }
}

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** 快照模型可忠实持久化的操作；其余（rotate/reorder/lock/group/ungroup/set_viewport/create_job）
 *  快照 schema 无对应字段，客户端提交路径明确拒绝（422），禁止"假成功"。
 *  create_job 请走 POST /api/jobs（真正的 job 实体创建），不经过 applyOperations。 */
const SNAPSHOT_PERSISTENT_OPERATIONS = new Set<string>([
  'create_node',
  'update_node',
  'delete_node',
  'move_nodes',
  'resize_nodes',
  'create_edge',
  'delete_edge',
  'attach_asset',
  'replace_node_asset',
]);

/** 与 ProjectNodeSnapshotSchema.nodeType 枚举一致；非法 nodeType 会污染快照导致 GET 500。 */
const SNAPSHOT_NODE_TYPES = ['text', 'image', 'video', 'audio', 'generation_job', 'group', 'document'] as const;
type SnapshotNodeType = (typeof SNAPSHOT_NODE_TYPES)[number];

export class InMemoryOperationsRepository implements OperationsRepository {
  private readonly versions = new Map<string, number>();
  private readonly projectRepository: InMemoryProjectRepository | null;
  /** 每个 projectId 一条 promise 链：同一画布的 apply 串行执行，杜绝并发读-改-写丢失更新。 */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(projectRepository?: InMemoryProjectRepository) {
    this.projectRepository = projectRepository ?? null;
  }

  seed(projectId: string, canvasVersion: number): void {
    this.versions.set(projectId, canvasVersion);
  }

  async apply(
    projectId: string,
    request: ApplyOperationsRequest,
  ): Promise<ApplyOperationsResponse> {
    if (this.projectRepository) {
      // 内存模式联调：同一项目串行化（并发安全），真正应用操作到画布快照。
      return this.serialize(projectId, () => this.applyWithProject(projectId, request));
    }
    const currentVersion = this.versions.get(projectId) ?? 0;
    if (currentVersion !== request.baseVersion) {
      throw new VersionConflictError(currentVersion);
    }
    this.validateBatch(request.operations);
    const canvasVersion = currentVersion + 1;
    this.versions.set(projectId, canvasVersion);
    return ApplyOperationsResponseSchema.parse({
      appliedOperationIds: request.operations.map(({ operationId }) => operationId),
      canvasVersion,
    });
  }

  /** promise 链互斥：前一个任务完成后才执行下一个；失败不影响后续任务。 */
  private async serialize<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const result = await task();
      return result;
    });
    this.locks.set(projectId, run.catch(() => undefined));
    return run;
  }

  /** 批次级校验（不依赖画布状态）：重复 operationId + 快照可持久化类型白名单。 */
  private validateBatch(operations: ApplyOperationsRequest['operations']): void {
    const seen = new Set<string>();
    for (const op of operations) {
      if (seen.has(op.operationId)) {
        throw new OperationValidationError(
          'DUPLICATE_OPERATION_ID',
          `operationId ${op.operationId} appears more than once in the batch`,
        );
      }
      seen.add(op.operationId);
      if (!SNAPSHOT_PERSISTENT_OPERATIONS.has(op.type)) {
        throw new OperationValidationError(
          'UNSUPPORTED_OPERATION',
          `operation type '${op.type}' cannot be persisted by the canvas snapshot; use the dedicated API (e.g. POST /api/jobs for create_job)`,
        );
      }
    }
  }

  private requireNode(nodeIds: Set<string>, nodeId: string): void {
    if (!nodeIds.has(nodeId)) {
      throw new OperationValidationError('INVALID_REFERENCE', `node ${nodeId} does not exist`);
    }
  }

  /** 在内存副本上应用操作（含引用完整性校验）；任何失败抛 OperationValidationError，
   *  副本被丢弃，快照不变——批次全有或全无（回滚语义）。 */
  private applyOperationsToCanvas(
    nodes: ProjectSnapshotResponse['nodes'],
    edges: ProjectSnapshotResponse['edges'],
    operations: ApplyOperationsRequest['operations'],
  ): void {
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edgeIds = new Set(edges.map((e) => e.id));

    for (const op of operations) {
      switch (op.type) {
        case 'create_node': {
          if (!(SNAPSHOT_NODE_TYPES as readonly string[]).includes(op.payload.nodeType)) {
            throw new OperationValidationError(
              'INVALID_NODE_TYPE',
              `nodeType '${op.payload.nodeType}' is not a valid canvas node type`,
            );
          }
          if (nodeIds.has(op.operationId)) {
            throw new OperationValidationError('DUPLICATE_NODE_ID', `node id ${op.operationId} already exists`);
          }
          const node: ProjectSnapshotResponse['nodes'][number] = {
            id: op.operationId,
            nodeType: op.payload.nodeType as SnapshotNodeType,
            parentNodeId: op.payload.parentNodeId ?? null,
            position: op.payload.position ?? { x: 0, y: 0 },
            size: op.payload.size
              ? { width: op.payload.size.x, height: op.payload.size.y }
              : null,
            data: op.payload.data ?? null,
            jobId: null,
          };
          nodes.push(node);
          nodeIds.add(op.operationId);
          break;
        }
        case 'update_node': {
          this.requireNode(nodeIds, op.payload.nodeId);
          const node = nodes.find((n) => n.id === op.payload.nodeId);
          if (node) {
            const patch = op.payload.patch;
            node.data =
              patch && typeof patch === 'object' && !Array.isArray(patch)
                ? { ...(node.data as object | null), ...(patch as object) }
                : patch;
          }
          break;
        }
        case 'delete_node': {
          this.requireNode(nodeIds, op.payload.nodeId);
          // 子节点解除挂载（保留数据），父节点删除不级联销毁内容节点
          for (const n of nodes) {
            if (n.parentNodeId === op.payload.nodeId) n.parentNodeId = null;
          }
          for (let i = nodes.length - 1; i >= 0; i -= 1) {
            if (nodes[i].id === op.payload.nodeId) nodes.splice(i, 1);
          }
          nodeIds.delete(op.payload.nodeId);
          // 连带删除关联边
          for (let i = edges.length - 1; i >= 0; i -= 1) {
            const e = edges[i];
            if (e.sourceNodeId === op.payload.nodeId || e.targetNodeId === op.payload.nodeId) {
              edges.splice(i, 1);
              edgeIds.delete(e.id);
            }
          }
          break;
        }
        case 'move_nodes': {
          for (const id of op.payload.nodeIds) {
            this.requireNode(nodeIds, id);
          }
          for (const id of op.payload.nodeIds) {
            const node = nodes.find((n) => n.id === id);
            if (node && node.position) {
              node.position = {
                x: node.position.x + op.payload.delta.x,
                y: node.position.y + op.payload.delta.y,
              };
            }
          }
          break;
        }
        case 'resize_nodes': {
          for (const id of op.payload.nodeIds) {
            this.requireNode(nodeIds, id);
          }
          for (const id of op.payload.nodeIds) {
            const node = nodes.find((n) => n.id === id);
            if (node) {
              node.size = { width: op.payload.size.x, height: op.payload.size.y };
            }
          }
          break;
        }
        case 'create_edge': {
          this.requireNode(nodeIds, op.payload.source.nodeId);
          this.requireNode(nodeIds, op.payload.target.nodeId);
          if (edgeIds.has(op.operationId)) {
            throw new OperationValidationError('DUPLICATE_EDGE_ID', `edge id ${op.operationId} already exists`);
          }
          edges.push({
            id: op.operationId,
            sourceNodeId: op.payload.source.nodeId,
            targetNodeId: op.payload.target.nodeId,
            edgeType: op.payload.edgeType,
          });
          edgeIds.add(op.operationId);
          break;
        }
        case 'delete_edge': {
          if (!edgeIds.has(op.payload.edgeId)) {
            throw new OperationValidationError('INVALID_REFERENCE', `edge ${op.payload.edgeId} does not exist`);
          }
          for (let i = edges.length - 1; i >= 0; i -= 1) {
            if (edges[i].id === op.payload.edgeId) edges.splice(i, 1);
          }
          edgeIds.delete(op.payload.edgeId);
          break;
        }
        case 'attach_asset':
        case 'replace_node_asset': {
          this.requireNode(nodeIds, op.payload.nodeId);
          const node = nodes.find((n) => n.id === op.payload.nodeId);
          if (node) {
            node.data = {
              ...(node.data as object | null),
              assetId: op.payload.assetId,
            };
          }
          break;
        }
      }
    }
  }

  private async applyWithProject(
    projectId: string,
    request: ApplyOperationsRequest,
  ): Promise<ApplyOperationsResponse> {
    const snapshot = await this.projectRepository!.getSnapshot(projectId);
    const currentVersion = snapshot.project.canvasVersion;
    if (currentVersion !== request.baseVersion) {
      throw new VersionConflictError(currentVersion);
    }
    this.validateBatch(request.operations);

    const nodes = [...snapshot.nodes];
    const edges = [...snapshot.edges];
    // 批次内任何操作无效：副本丢弃、快照不变、版本不推进（回滚语义）
    this.applyOperationsToCanvas(nodes, edges, request.operations);

    const canvasVersion = currentVersion + 1;
    // 原子提交：节点/边与版本同一次写入，杜绝内容与版本不一致
    await this.projectRepository!.commitSnapshot(projectId, { nodes, edges }, canvasVersion);

    return ApplyOperationsResponseSchema.parse({
      appliedOperationIds: request.operations.map(({ operationId }) => operationId),
      canvasVersion,
    });
  }
}

type AppOptions = {
  repository: OperationsRepository;
  projectRepository: ProjectRepository;
  uploadRepository: UploadRepository;
  jobRepository: JobRepository;
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  currentVersion?: number,
): void {
  sendJson(response, status, ErrorResponseSchema.parse({
    error: { code, message, details: null },
    ...(currentVersion === undefined ? {} : { currentVersion }),
  }));
}

function handleRepositoryError(response: ServerResponse, error: unknown): void {
  if (error instanceof ProjectNotFoundError) {
    sendError(response, 404, 'PROJECT_NOT_FOUND', error.message);
    return;
  }
  if (error instanceof UploadNotFoundError) {
    sendError(response, 404, 'UPLOAD_NOT_FOUND', error.message);
    return;
  }
  if (error instanceof UploadValidationError) {
    const status = error.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415
      : error.code === 'UPLOAD_EXPIRED' ? 422
      : error.code === 'UPLOAD_INCOMPLETE' ? 422
      : 400;
    sendError(response, status, error.code, error.message);
    return;
  }
  if (error instanceof JobNotFoundError) {
    sendError(response, 404, 'JOB_NOT_FOUND', error.message);
    return;
  }
  if (error instanceof JobStateTransitionError) {
    sendError(response, 409, 'INVALID_STATE_TRANSITION', error.message);
    return;
  }
  if (error instanceof JobValidationError) {
    sendError(response, 400, error.code, error.message);
    return;
  }
  if (error instanceof UnauthorizedError) {
    sendError(response, 401, 'UNAUTHORIZED', error.message);
    return;
  }
  if (error instanceof VersionConflictError) {
    sendError(response, 409, 'CANVAS_VERSION_CONFLICT', error.message, error.currentVersion);
    return;
  }
  if (error instanceof OperationValidationError) {
    sendError(response, 422, error.code, error.message);
    return;
  }
  sendError(response, 500, 'INTERNAL_ERROR', 'Unexpected server error');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > MAX_REQUEST_BYTES) {
      throw new Error('REQUEST_TOO_LARGE');
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createApp({ repository, projectRepository, uploadRepository, jobRepository }: AppOptions) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok', service: 'tapflow-api' });
      return;
    }

    // ---------- Job 路由（03 契约） ----------
    if (JOBS_ROUTE.test(url.pathname) && request.method === 'POST') {
      let body: unknown;
      try {
        body = await readJson(request);
      } catch (error) {
        if (error instanceof Error && error.message === 'REQUEST_TOO_LARGE') {
          sendError(response, 413, 'REQUEST_TOO_LARGE', 'Request body exceeds 256KB');
        } else {
          sendError(response, 400, 'INVALID_JSON', 'Request body must be valid JSON');
        }
        return;
      }
      const parsed = CreateJobRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendError(response, 400, 'INVALID_REQUEST', 'Request does not match the create job contract');
        return;
      }
      try {
        const result = await jobRepository.create(parsed.data, request.headers.authorization);
        sendJson(response, 201, CreateJobResponseSchema.parse(result));
      } catch (error) {
        handleRepositoryError(response, error);
      }
      return;
    }

    const projectJobsMatch = PROJECT_JOBS_ROUTE.exec(url.pathname);
    if (projectJobsMatch && request.method === 'GET') {
      const projectId = decodeURIComponent(projectJobsMatch[1]);
      if (!UuidSchema.safeParse(projectId).success) {
        sendError(response, 400, 'INVALID_PROJECT_ID', 'projectId must be a UUID');
        return;
      }
      try {
        const result = await jobRepository.listByProject(projectId, request.headers.authorization);
        sendJson(response, 200, ListJobsResponseSchema.parse(result));
      } catch (error) {
        handleRepositoryError(response, error);
      }
      return;
    }

    const jobCancelMatch = JOB_CANCEL_ROUTE.exec(url.pathname);
    if (jobCancelMatch && request.method === 'POST') {
      const jobId = decodeURIComponent(jobCancelMatch[1]);
      if (!UuidSchema.safeParse(jobId).success) {
        sendError(response, 400, 'INVALID_JOB_ID', 'jobId must be a UUID');
        return;
      }
      try {
        const result = await jobRepository.cancel(jobId, request.headers.authorization);
        sendJson(response, 200, CancelJobResponseSchema.parse(result));
      } catch (error) {
        handleRepositoryError(response, error);
      }
      return;
    }

    const jobDetailMatch = JOB_DETAIL_ROUTE.exec(url.pathname);
    if (jobDetailMatch && request.method === 'GET') {
      const jobId = decodeURIComponent(jobDetailMatch[1]);
      if (!UuidSchema.safeParse(jobId).success) {
        sendError(response, 400, 'INVALID_JOB_ID', 'jobId must be a UUID');
        return;
      }
      try {
        const job = await jobRepository.get(jobId, request.headers.authorization);
        sendJson(response, 200, GetJobResponseSchema.parse({ job }));
      } catch (error) {
        handleRepositoryError(response, error);
      }
      return;
    }

    // ---------- 项目路由 ----------
    if (PROJECT_ROUTE.test(url.pathname)) {
      if (request.method === 'GET') {
        try {
          const projects = await projectRepository.list(request.headers.authorization);
          sendJson(response, 200, ListProjectsResponseSchema.parse({ projects }));
        } catch (error) {
          handleRepositoryError(response, error);
        }
        return;
      }
      if (request.method === 'POST') {
        let body: unknown;
        try {
          body = await readJson(request);
        } catch (error) {
          if (error instanceof Error && error.message === 'REQUEST_TOO_LARGE') {
            sendError(response, 413, 'REQUEST_TOO_LARGE', 'Request body exceeds 256KB');
          } else {
            sendError(response, 400, 'INVALID_JSON', 'Request body must be valid JSON');
          }
          return;
        }
        const parsed = CreateProjectRequestSchema.safeParse(body);
        if (!parsed.success) {
          sendError(response, 400, 'INVALID_REQUEST', 'Request does not match the create project contract');
          return;
        }
        try {
          const project = await projectRepository.create(parsed.data, request.headers.authorization);
          sendJson(response, 200, project);
        } catch (error) {
          handleRepositoryError(response, error);
        }
        return;
      }
      sendError(response, 404, 'NOT_FOUND', 'Route not found');
      return;
    }

    const projectMatch = PROJECT_SNAPSHOT_ROUTE.exec(url.pathname);
    if (projectMatch && request.method === 'GET') {
      const projectId = decodeURIComponent(projectMatch[1]);
      if (!UuidSchema.safeParse(projectId).success) {
        sendError(response, 400, 'INVALID_PROJECT_ID', 'projectId must be a UUID');
        return;
      }
      try {
        const snapshot = await projectRepository.getSnapshot(projectId, request.headers.authorization);
        sendJson(response, 200, ProjectSnapshotResponseSchema.parse(snapshot));
      } catch (error) {
        handleRepositoryError(response, error);
      }
      return;
    }

    const presignMatch = PRESIGN_UPLOAD_ROUTE.exec(url.pathname);
    if (presignMatch && request.method === 'POST') {
      let body: unknown;
      try {
        body = await readJson(request);
      } catch (error) {
        if (error instanceof Error && error.message === 'REQUEST_TOO_LARGE') {
          sendError(response, 413, 'REQUEST_TOO_LARGE', 'Request body exceeds 256KB');
        } else {
          sendError(response, 400, 'INVALID_JSON', 'Request body must be valid JSON');
        }
        return;
      }
      const parsed = PresignUploadRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendError(response, 400, 'INVALID_REQUEST', 'Request does not match the presign upload contract');
        return;
      }
      try {
        const result = await uploadRepository.presign(parsed.data, request.headers.authorization);
        sendJson(response, 200, result);
      } catch (error) {
        handleRepositoryError(response, error);
      }
      return;
    }

    const completeMatch = COMPLETE_UPLOAD_ROUTE.exec(url.pathname);
    if (completeMatch && request.method === 'POST') {
      const uploadId = decodeURIComponent(completeMatch[1]);
      if (!UuidSchema.safeParse(uploadId).success) {
        sendError(response, 400, 'INVALID_UPLOAD_ID', 'uploadId must be a UUID');
        return;
      }
      try {
        const result = await uploadRepository.complete(uploadId, request.headers.authorization);
        sendJson(response, 200, result);
      } catch (error) {
        handleRepositoryError(response, error);
      }
      return;
    }

    const match = OPERATIONS_ROUTE.exec(url.pathname);
    if (request.method !== 'POST' || !match) {
      sendError(response, 404, 'NOT_FOUND', 'Route not found');
      return;
    }

    const projectId = decodeURIComponent(match[1]);
    if (!UuidSchema.safeParse(projectId).success) {
      sendError(response, 400, 'INVALID_PROJECT_ID', 'projectId must be a UUID');
      return;
    }

    let body: unknown;
    try {
      body = await readJson(request);
    } catch (error) {
      if (error instanceof Error && error.message === 'REQUEST_TOO_LARGE') {
        sendError(response, 413, 'REQUEST_TOO_LARGE', 'Request body exceeds 256KB');
      } else {
        sendError(response, 400, 'INVALID_JSON', 'Request body must be valid JSON');
      }
      return;
    }

    const parsed = ApplyOperationsRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(response, 400, 'INVALID_REQUEST', 'Request does not match the operations contract');
      return;
    }

    try {
      sendJson(response, 200, await repository.apply(
        projectId,
        parsed.data,
        request.headers.authorization,
      ));
    } catch (error) {
      handleRepositoryError(response, error);
    }
  });
}