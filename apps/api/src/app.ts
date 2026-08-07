import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  ApplyOperationsRequestSchema,
  ApplyOperationsResponseSchema,
  ErrorResponseSchema,
  UuidSchema,
  type ApplyOperationsRequest,
  type ApplyOperationsResponse,
} from '@tapflow/contracts';

const MAX_REQUEST_BYTES = 256 * 1024;
const OPERATIONS_ROUTE = /^\/api\/projects\/([^/]+)\/operations$/;

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

export function createApp({ repository }: AppOptions) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok', service: 'tapflow-api' });
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
      if (error instanceof VersionConflictError) {
        sendError(
          response,
          409,
          'CANVAS_VERSION_CONFLICT',
          error.message,
          error.currentVersion,
        );
        return;
      }
      if (error instanceof UnauthorizedError) {
        sendError(response, 401, 'UNAUTHORIZED', error.message);
        return;
      }
      sendError(response, 500, 'INTERNAL_ERROR', 'Unexpected server error');
    }
  });
}