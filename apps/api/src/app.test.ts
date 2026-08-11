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
import { InMemoryJobRepository } from './jobRepository.ts';
import { InMemoryUploadRepository, type UploadRepository } from './uploadRepository.ts';

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
  uploadRepository: UploadRepository = new InMemoryUploadRepository(),
) {
  const server = createApp({ repository, projectRepository, uploadRepository, jobRepository: new InMemoryJobRepository() });
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

// ---------- 内存画布模式（注入 projectRepository）下的并发 / 回滚 / 完整性校验 ----------

const uuid = (n: number | string) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function startMemoryCanvas() {
  const projectRepo = new InMemoryProjectRepository();
  const repository = new InMemoryOperationsRepository(projectRepo);
  const { baseUrl } = await start(repository, projectRepo);
  const createProject = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'canvas test' }),
  });
  const projectId = (await createProject.json()).id as string;
  const postOps = (body: unknown) => fetch(`${baseUrl}/api/projects/${projectId}/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const getSnapshot = async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}`);
    return res.json() as Promise<{ project: { canvasVersion: number }; nodes: unknown[]; edges: unknown[] }>;
  };
  return { postOps, getSnapshot };
}

test('memory canvas: concurrent applies on the same baseVersion serialize and lose nothing', async () => {
  const { postOps, getSnapshot } = await startMemoryCanvas();

  const results = await Promise.all([...Array(10)].map((_, i) =>
    postOps({
      baseVersion: 0,
      operations: [{
        operationId: uuid(i),
        type: 'create_node',
        payload: { nodeType: 'text', position: { x: i, y: i } },
      }],
    }),
  ));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 200).length, 1, 'exactly one concurrent apply wins');
  assert.equal(statuses.filter((s) => s === 409).length, 9, 'the rest get an optimistic lock conflict');

  const snapshot = await getSnapshot();
  assert.equal(snapshot.project.canvasVersion, 1);
  assert.equal(snapshot.nodes.length, 1, 'no node is silently lost');
  assert.deepEqual(snapshot.nodes[0], {
    id: results.findIndex((r) => r.status === 200) >= 0 ? uuid(results.findIndex((r) => r.status === 200)) : null,
    nodeType: 'text',
    parentNodeId: null,
    position: { x: results.findIndex((r) => r.status === 200), y: results.findIndex((r) => r.status === 200) },
    size: null,
    data: null,
    jobId: null,
  });
});

test('memory canvas: a batch with an invalid operation rolls back atomically', async () => {
  const { postOps, getSnapshot } = await startMemoryCanvas();

  const response = await postOps({
    baseVersion: 0,
    operations: [
      { operationId: uuid('aaaa'), type: 'create_node', payload: { nodeType: 'text' } },
      {
        operationId: uuid('bbbb'),
        type: 'create_edge',
        payload: {
          edgeType: 'reference',
          source: { ref: 'node', nodeId: uuid('aaaa') },
          target: { ref: 'node', nodeId: uuid('cafe') },
        },
      },
    ],
  });

  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'INVALID_REFERENCE');
  const snapshot = await getSnapshot();
  assert.equal(snapshot.nodes.length, 0, 'first operation must not be committed');
  assert.equal(snapshot.edges.length, 0);
  assert.equal(snapshot.project.canvasVersion, 0, 'version must not advance on rollback');
});

test('memory canvas: rejects an invalid nodeType instead of poisoning the snapshot', async () => {
  const { postOps, getSnapshot } = await startMemoryCanvas();

  const response = await postOps({
    baseVersion: 0,
    operations: [{
      operationId: OPERATION_ID,
      type: 'create_node',
      payload: { nodeType: 'bogus_type', position: { x: 0, y: 0 } },
    }],
  });

  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'INVALID_NODE_TYPE');
  const snapshot = await getSnapshot();
  assert.equal(snapshot.nodes.length, 0);
  assert.equal(snapshot.project.canvasVersion, 0);
});

test('memory canvas: refuses operations the snapshot cannot persist (no fake success)', async () => {
  const { postOps, getSnapshot } = await startMemoryCanvas();

  const response = await postOps({
    baseVersion: 0,
    operations: [{
      operationId: OPERATION_ID,
      type: 'set_viewport',
      payload: { viewport: { x: 0, y: 0, zoom: 1 } },
    }],
  });

  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'UNSUPPORTED_OPERATION');
  const snapshot = await getSnapshot();
  assert.equal(snapshot.nodes.length, 0);
  assert.equal(snapshot.project.canvasVersion, 0, 'version must not advance without a real write');
});

test('memory canvas: version conflict wins over operation validation', async () => {
  const { postOps } = await startMemoryCanvas();
  await postOps({
    baseVersion: 0,
    operations: [{ operationId: uuid('a1'), type: 'create_node', payload: { nodeType: 'text' } }],
  });

  const response = await postOps({
    baseVersion: 99,
    operations: [{
      operationId: OPERATION_ID,
      type: 'set_viewport',
      payload: { viewport: { x: 0, y: 0, zoom: 1 } },
    }],
  });

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'CANVAS_VERSION_CONFLICT');
});

test('memory canvas: rejects duplicate operation ids in one batch', async () => {
  const { postOps, getSnapshot } = await startMemoryCanvas();

  const response = await postOps({
    baseVersion: 0,
    operations: [
      { operationId: OPERATION_ID, type: 'create_node', payload: { nodeType: 'text' } },
      { operationId: OPERATION_ID, type: 'create_node', payload: { nodeType: 'image' } },
    ],
  });

  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'DUPLICATE_OPERATION_ID');
  const snapshot = await getSnapshot();
  assert.equal(snapshot.nodes.length, 0);
});

test('memory canvas: rejects references to missing nodes and edges', async () => {
  const { postOps, getSnapshot } = await startMemoryCanvas();

  const missingNode = await postOps({
    baseVersion: 0,
    operations: [{ operationId: uuid('b1'), type: 'delete_node', payload: { nodeId: uuid('dead') } }],
  });
  assert.equal(missingNode.status, 422);
  assert.equal((await missingNode.json()).error.code, 'INVALID_REFERENCE');

  await postOps({
    baseVersion: 0,
    operations: [{ operationId: uuid('a1'), type: 'create_node', payload: { nodeType: 'text' } }],
  });
  const missingEdge = await postOps({
    baseVersion: 1,
    operations: [{ operationId: uuid('b2'), type: 'delete_edge', payload: { edgeId: uuid('beef') } }],
  });
  assert.equal(missingEdge.status, 422);
  assert.equal((await missingEdge.json()).error.code, 'INVALID_REFERENCE');
  const snapshot = await getSnapshot();
  assert.equal(snapshot.project.canvasVersion, 1, 'failed ops must not advance the version');
});

test('memory canvas: a batch may reference nodes created earlier in the same batch', async () => {
  const { postOps, getSnapshot } = await startMemoryCanvas();

  const response = await postOps({
    baseVersion: 0,
    operations: [
      { operationId: uuid('a1'), type: 'create_node', payload: { nodeType: 'text', position: { x: 0, y: 0 } } },
      { operationId: uuid('a2'), type: 'create_node', payload: { nodeType: 'image', position: { x: 10, y: 0 } } },
      {
        operationId: uuid('c1'),
        type: 'create_edge',
        payload: {
          edgeType: 'reference',
          source: { ref: 'node', nodeId: uuid('a1') },
          target: { ref: 'node', nodeId: uuid('a2') },
        },
      },
    ],
  });

  assert.equal(response.status, 200);
  const snapshot = await getSnapshot();
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.edges.length, 1);
  assert.equal(snapshot.project.canvasVersion, 1);
});

test('memory canvas: mutations to existing nodes are rolled back when a later op fails (deep-copy)', async () => {
  const { postOps, getSnapshot } = await startMemoryCanvas();

  // v1: create a node with data
  const createResponse = await postOps({
    baseVersion: 0,
    operations: [{
      operationId: uuid(1),
      type: 'create_node',
      payload: { nodeType: 'text', data: { content: 'original' } },
    }],
  });
  assert.equal(createResponse.status, 200);

  // v2 batch: first mutate the existing node, then fail on a missing reference
  const failed = await postOps({
    baseVersion: 1,
    operations: [
      { operationId: uuid(2), type: 'update_node', payload: { nodeId: uuid(1), patch: { content: 'HACKED' } } },
      { operationId: uuid(3), type: 'delete_node', payload: { nodeId: uuid('dead') } },
    ],
  });
  assert.equal(failed.status, 422);

  const snapshot = await getSnapshot();
  assert.equal(snapshot.project.canvasVersion, 1, 'version must not advance on rollback');
  const node = (snapshot.nodes as Array<{ id: string; data: { content: string } | null }>)
    .find((n) => n.id === uuid(1));
  assert.ok(node, 'the node still exists');
  assert.deepEqual(node.data, { content: 'original' }, 'mutation must not leak into the store');
});

test('memory canvas: create_node rejects a parentNodeId that does not exist', async () => {
  const { postOps, getSnapshot } = await startMemoryCanvas();

  const response = await postOps({
    baseVersion: 0,
    operations: [{
      operationId: uuid(1),
      type: 'create_node',
      payload: { nodeType: 'text', parentNodeId: uuid('cafe') },
    }],
  });

  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'INVALID_REFERENCE');
  const snapshot = await getSnapshot();
  assert.equal(snapshot.nodes.length, 0);
  assert.equal(snapshot.project.canvasVersion, 0);
});

test('memory canvas: a batch may attach a child to a parent created earlier in the same batch', async () => {
  const { postOps, getSnapshot } = await startMemoryCanvas();

  const response = await postOps({
    baseVersion: 0,
    operations: [
      { operationId: uuid(1), type: 'create_node', payload: { nodeType: 'group', position: { x: 0, y: 0 } } },
      {
        operationId: uuid(2),
        type: 'create_node',
        payload: { nodeType: 'text', parentNodeId: uuid(1), position: { x: 5, y: 5 } },
      },
    ],
  });

  assert.equal(response.status, 200);
  const snapshot = await getSnapshot();
  assert.equal(snapshot.nodes.length, 2);
  const child = (snapshot.nodes as Array<{ id: string; parentNodeId: string | null }>)
    .find((n) => n.id === uuid(2));
  assert.equal(child?.parentNodeId, uuid(1), 'parent reference resolved within the batch');
});

test('memory canvas: lock entries are released after apply settles (no unbounded growth)', async () => {
  const projectRepo = new InMemoryProjectRepository();
  const repository = new InMemoryOperationsRepository(projectRepo);
  const { baseUrl } = await start(repository, projectRepo);
  const createProject = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'lock test' }),
  });
  const projectId = (await createProject.json()).id as string;
  const postOps = (body: unknown) => fetch(`${baseUrl}/api/projects/${projectId}/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // a successful apply, then a failed apply, then another successful apply
  const ok1 = await postOps({
    baseVersion: 0,
    operations: [{ operationId: uuid(1), type: 'create_node', payload: { nodeType: 'text' } }],
  });
  assert.equal(ok1.status, 200);

  const fail = await postOps({
    baseVersion: 1,
    operations: [{ operationId: uuid(2), type: 'delete_node', payload: { nodeId: uuid('dead') } }],
  });
  assert.equal(fail.status, 422);

  const ok2 = await postOps({
    baseVersion: 1,
    operations: [{ operationId: uuid(3), type: 'create_node', payload: { nodeType: 'image' } }],
  });
  assert.equal(ok2.status, 200);

  // after all applies settle, the lock map must be empty again
  assert.equal((repository as unknown as { locks: Map<string, unknown> }).locks.size, 0,
    'lock map must not accumulate entries');
});