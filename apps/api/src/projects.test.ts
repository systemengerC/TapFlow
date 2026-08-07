/**
 * 项目 API 行为测试：列表 / 创建 / 快照加载
 * 运行：npm test（node --test src/projects.test.ts）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import {
  type CreateProjectRequest,
  type ListProjectsResponse,
  type Project,
  type ProjectSnapshotResponse,
  type Uuid,
} from '@tapflow/contracts';

import { createApp, InMemoryOperationsRepository, type OperationsRepository } from './app.ts';
import { InMemoryJobRepository } from './jobRepository.ts';
import { InMemoryProjectRepository, type ProjectRepository } from './projectRepository.ts';
import { InMemoryUploadRepository } from './uploadRepository.ts';

const U = (s: string): Uuid => s as Uuid;

const PROJECT_ID = U('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const OTHER_ID = U('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

async function withServer(
  fn: (baseUrl: string, repository: ProjectRepository) => Promise<void>,
  repositories?: { projects?: ProjectRepository; operations?: OperationsRepository },
): Promise<void> {
  const projectRepo = repositories?.projects ?? new InMemoryProjectRepository();
  const operationRepo = repositories?.operations ?? new InMemoryOperationsRepository();
  const server = createApp({
    projectRepository: projectRepo,
    repository: operationRepo,
    uploadRepository: new InMemoryUploadRepository(),
    jobRepository: new InMemoryJobRepository(),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`, projectRepo);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test('P01: GET /api/projects 返回空列表', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects`);
    assert.equal(response.status, 200);
    const body = await response.json() as ListProjectsResponse;
    assert.deepEqual(body.projects, []);
  });
});

test('P02: POST /api/projects 创建项目并返回 200 + 项目对象', async () => {
  await withServer(async (baseUrl) => {
    const body: CreateProjectRequest = { name: '我的第一个项目' };
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const project = await response.json() as Project;
    assert.equal(project.name, '我的第一个项目');
    assert.equal(project.canvasVersion, 0);
    assert.ok(project.id);
    assert.ok(project.createdAt);
  });
});

test('P03: POST /api/projects 空名字返回 400', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'INVALID_REQUEST');
  });
});

test('P04: GET /api/projects/:id 返回项目快照（含节点和边）', async () => {
  await withServer(async (baseUrl, repo) => {
    const project = await repo.create({ name: '快照项目' });
    await repo.saveSnapshot(project.id, {
      nodes: [{
        id: U('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
        nodeType: 'text',
        parentNodeId: null,
        position: { x: 10, y: 20 },
        size: null,
        data: { text: 'hello' },
        jobId: null,
      }],
      edges: [{
        id: U('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
        sourceNodeId: U('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
        targetNodeId: U('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
        edgeType: 'reference',
      }],
    });
    const response = await fetch(`${baseUrl}/api/projects/${project.id}`);
    assert.equal(response.status, 200);
    const body = await response.json() as ProjectSnapshotResponse;
    assert.equal(body.project.id, project.id);
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0].nodeType, 'text');
    assert.equal(body.edges.length, 1);
  });
});

test('P05: GET /api/projects/:id 不存在返回 404', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects/${OTHER_ID}`);
    assert.equal(response.status, 404);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'PROJECT_NOT_FOUND');
  });
});

test('P06: GET /api/projects/:id 非法 UUID 返回 400', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects/not-a-uuid`);
    assert.equal(response.status, 400);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'INVALID_PROJECT_ID');
  });
});

test('P07: 快照加载后 canvasVersion 与列表一致', async () => {
  await withServer(async (baseUrl, repo) => {
    const project = await repo.create({ name: '版本项目' });
    await repo.saveSnapshot(project.id, { nodes: [], edges: [] });
    const listResponse = await fetch(`${baseUrl}/api/projects`);
    const list = await listResponse.json() as ListProjectsResponse;
    const listed = list.projects.find((p) => p.id === project.id);
    assert.ok(listed);
    assert.equal(listed.canvasVersion, 0);
    const snapshotResponse = await fetch(`${baseUrl}/api/projects/${project.id}`);
    const snapshot = await snapshotResponse.json() as ProjectSnapshotResponse;
    assert.equal(snapshot.project.canvasVersion, listed.canvasVersion);
  });
});

test('P08: 未认证访问项目列表（Supabase 模式）返回 401', async () => {
  const mockFetcher = async () => new Response(JSON.stringify({ message: 'no token' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
  const { SupabaseProjectRepository } = await import('./supabaseProjectRepository.ts');
  const repo = new SupabaseProjectRepository({
    supabaseUrl: 'https://example.supabase.co',
    anonKey: 'test-anon-key',
    fetcher: mockFetcher as typeof fetch,
  });
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects`);
    assert.equal(response.status, 401);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'UNAUTHORIZED');
  }, { projects: repo });
});

test('P09: Supabase 创建项目正确透传 RPC 参数', async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const mockFetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.endsWith('/rpc/create_project')) {
      return new Response(JSON.stringify({
        id: PROJECT_ID,
        name: 'rpc项目',
        canvas_version: 0,
        created_at: '2026-08-07T10:00:00.000Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 404, headers: { 'content-type': 'application/json' } });
  };
  const { SupabaseProjectRepository } = await import('./supabaseProjectRepository.ts');
  const repo = new SupabaseProjectRepository({
    supabaseUrl: 'https://example.supabase.co',
    anonKey: 'test-anon-key',
    fetcher: mockFetcher as typeof fetch,
  });
  const result = await repo.create({ name: 'rpc项目' }, 'Bearer test-token');
  assert.equal(result.id, PROJECT_ID);
  assert.equal(result.name, 'rpc项目');
  assert.equal(result.canvasVersion, 0);
  const createCall = calls.find((c) => c.url.endsWith('/rpc/create_project'));
  assert.ok(createCall, 'should call create_project RPC');
  assert.deepEqual(createCall.body, { p_name: 'rpc项目' });
});

test('P10: Supabase 快照加载查询项目与节点/边', async () => {
  const calls: string[] = [];
  const mockFetcher = async (url: string) => {
    calls.push(url);
    if (url.includes('/projects?')) {
      return new Response(JSON.stringify([{
        id: PROJECT_ID,
        name: '快照项目',
        canvas_version: 3,
        created_at: '2026-08-07T10:00:00.000Z',
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/canvas_nodes?')) {
      return new Response(JSON.stringify([{
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        node_type: 'text',
        parent_node_id: null,
        position: { x: 1, y: 2 },
        size: null,
        data: { text: 'hi' },
        job_id: null,
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/canvas_edges?')) {
      return new Response(JSON.stringify([{
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        source_node_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        target_node_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        edge_type: 'reference',
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 404, headers: { 'content-type': 'application/json' } });
  };
  const { SupabaseProjectRepository } = await import('./supabaseProjectRepository.ts');
  const repo = new SupabaseProjectRepository({
    supabaseUrl: 'https://example.supabase.co',
    anonKey: 'test-anon-key',
    fetcher: mockFetcher as typeof fetch,
  });
  const result = await repo.getSnapshot(PROJECT_ID, 'Bearer test-token');
  assert.equal(result.project.id, PROJECT_ID);
  assert.equal(result.project.canvasVersion, 3);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].nodeType, 'text');
  assert.equal(result.edges.length, 1);
  assert.ok(calls.some((u) => u.includes('/canvas_nodes?')));
  assert.ok(calls.some((u) => u.includes('/canvas_edges?')));
});
