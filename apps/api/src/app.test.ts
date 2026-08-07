import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import {
  createApp,
  InMemoryOperationsRepository,
  UnauthorizedError,
  type OperationsRepository,
} from './app.ts';
import { InMemoryProjectRepository, type ProjectRepository } from './projectRepository.ts';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const servers: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function start(
  repository: OperationsRepository = new InMemoryOperationsRepository(),
  projectRepository: ProjectRepository = new InMemoryProjectRepository(),
) {
  const server = createApp({ repository, projectRepository });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, repository };
}

test('GET /health reports service readiness', async () => {
  const { baseUrl } = await start();
  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'tapflow-api' });
});

test('POST operations validates and applies a contract batch', async () => {
  const { baseUrl } = await start();
  const response = await fetch(`${baseUrl}/api/projects/${PROJECT_ID}/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseVersion: 0,
      operations: [{
        operationId: OPERATION_ID,
        type: 'create_node',
        payload: { nodeType: 'image', position: { x: 10, y: 20 } },
      }],
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    appliedOperationIds: [OPERATION_ID],
    canvasVersion: 1,
  });
});

test('POST operations returns the current version on optimistic lock conflict', async () => {
  const repository = new InMemoryOperationsRepository();
  repository.seed(PROJECT_ID, 3);
  const { baseUrl } = await start(repository);
  const response = await fetch(`${baseUrl}/api/projects/${PROJECT_ID}/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseVersion: 2,
      operations: [{
        operationId: OPERATION_ID,
        type: 'set_viewport',
        payload: { viewport: { x: 0, y: 0, zoom: 1 } },
      }],
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'CANVAS_VERSION_CONFLICT',
      message: 'Canvas version does not match baseVersion',
      details: null,
    },
    currentVersion: 3,
  });
});

test('POST operations rejects a malformed project id', async () => {
  const { baseUrl } = await start();
  const response = await fetch(`${baseUrl}/api/projects/not-a-uuid/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_PROJECT_ID');
});

test('POST operations rejects a body outside the frozen contract', async () => {
  const { baseUrl } = await start();
  const response = await fetch(`${baseUrl}/api/projects/${PROJECT_ID}/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseVersion: 0, operations: [] }),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
});

test('POST operations maps missing caller authorization to 401', async () => {
  const repository = {
    async apply() {
      throw new UnauthorizedError('Authorization bearer token is required');
    },
  };
  const { baseUrl } = await start(repository);
  const response = await fetch(`${baseUrl}/api/projects/${PROJECT_ID}/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseVersion: 0,
      operations: [{
        operationId: OPERATION_ID,
        type: 'set_viewport',
        payload: { viewport: { x: 0, y: 0, zoom: 1 } },
      }],
    }),
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
});