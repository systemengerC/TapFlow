import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  ApplyOperationsRequestSchema,
  ApplyOperationsResponseSchema,
  CreateProjectRequestSchema,
  ErrorResponseSchema,
  ListProjectsResponseSchema,
  PresignUploadRequestSchema,
  ProjectSnapshotResponseSchema,
  UuidSchema,
  type ApplyOperationsRequest,
  type ApplyOperationsResponse,
  type PresignUploadRequest,
} from '@tapflow/contracts';

import { ProjectNotFoundError, type ProjectRepository } from './projectRepository.ts';
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

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class InMemoryOperationsRepository implements OperationsRepository {
  private readonly versions = new Map<string, number>();

  seed(projectId: string, canvasVersion: number): void {
    this.versions.set(projectId, canvasVersion);
  }

  async apply(
    projectId: string,
    request: ApplyOperationsRequest,
  ): Promise<ApplyOperationsResponse> {
    const currentVersion = this.versions.get(projectId) ?? 0;
    if (currentVersion !== request.baseVersion) {
      throw new VersionConflictError(currentVersion);
    }

    const canvasVersion = currentVersion + 1;
    this.versions.set(projectId, canvasVersion);
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
  if (error instanceof UnauthorizedError) {
    sendError(response, 401, 'UNAUTHORIZED', error.message);
    return;
  }
  if (error instanceof VersionConflictError) {
    sendError(response, 409, 'CANVAS_VERSION_CONFLICT', error.message, error.currentVersion);
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

export function createApp({ repository, projectRepository, uploadRepository }: AppOptions) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok', service: 'tapflow-api' });
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