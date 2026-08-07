/**
 * Generation Job API 测试（RED 驱动）
 * 覆盖 03 契约 §4 取消语义 + 幂等键 + 错误映射
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { createApp, InMemoryOperationsRepository } from './app.ts';
import { InMemoryJobRepository } from './jobRepository.ts';
import { InMemoryProjectRepository } from './projectRepository.ts';
import { InMemoryUploadRepository } from './uploadRepository.ts';

// ---------- helpers ----------
type TestServer = { server: ReturnType<typeof createApp>; baseUrl: string };

async function withServer(fn: (ctx: TestServer) => Promise<void>): Promise<void> {
  const jobs = new InMemoryJobRepository();
  const projects = new InMemoryProjectRepository();
  const server = createApp({
    repository: new InMemoryOperationsRepository(),
    projectRepository: projects,
    uploadRepository: new InMemoryUploadRepository(),
    jobRepository: jobs,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ server, baseUrl });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

const UUID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const IDEM_KEY = '22222222-2222-4222-8222-222222222222';

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    jobType: 'text_to_image',
    model: 'gpt-image-2',
    params: { prompt: 'a red apple' },
    inputNodeIds: [UUID],
    ...overrides,
  };
}

async function jsonFetch(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// ---------- tests ----------
before(() => {
  // noop
});

after(async () => {
  // noop
});

test('POST /api/jobs creates a queued job', async () => {
  await withServer(async ({ baseUrl }) => {
    const { status, body } = await jsonFetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody({ idempotencyKey: IDEM_KEY })),
    });
    assert.equal(status, 201);
    assert.equal(body.idempotentReplay, false);
    assert.equal(body.job.projectId, PROJECT_ID);
    assert.equal(body.job.status, 'queued');
    assert.equal(body.job.jobType, 'text_to_image');
    assert.equal(body.job.idempotencyKey, IDEM_KEY);
    assert.equal(body.job.attempt, 1);
    assert.equal(body.job.parentJobId, null);
    assert.ok(body.job.id.match(/^[0-9a-f-]{36}$/));
  });
});

test('POST /api/jobs with same idempotency key replays (no duplicate job)', async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await jsonFetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody({ idempotencyKey: IDEM_KEY })),
    });
    const second = await jsonFetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody({ idempotencyKey: IDEM_KEY })),
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.idempotentReplay, true);
    assert.equal(second.body.job.id, first.body.job.id);
  });
});

test('POST /api/jobs rejects invalid body (400)', async () => {
  await withServer(async ({ baseUrl }) => {
    const { status, body } = await jsonFetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_ID, jobType: 'unknown_type', model: '' }),
    });
    assert.equal(status, 400);
    assert.ok(body.error.code);
  });
});

test('GET /api/projects/:projectId/jobs lists jobs (newest first)', async () => {
  await withServer(async ({ baseUrl }) => {
    await jsonFetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody({ idempotencyKey: IDEM_KEY, params: { prompt: 'first' } })),
    });
    await jsonFetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody({ idempotencyKey: '33333333-3333-4333-8333-333333333333', params: { prompt: 'second' } })),
    });
    const { status, body } = await jsonFetch(`${baseUrl}/api/projects/${PROJECT_ID}/jobs`);
    assert.equal(status, 200);
    assert.equal(body.jobs.length, 2);
    assert.ok(body.jobs[0].params.prompt === 'second', 'newest first');
  });
});

test('GET /api/jobs/:jobId returns a job', async () => {
  await withServer(async ({ baseUrl }) => {
    const created = await jsonFetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody({ idempotencyKey: IDEM_KEY })),
    });
    const jobId = created.body.job.id;
    const { status, body } = await jsonFetch(`${baseUrl}/api/jobs/${jobId}`);
    assert.equal(status, 200);
    assert.equal(body.job.id, jobId);
    assert.equal(body.job.status, 'queued');
  });
});

test('GET /api/jobs/:jobId unknown returns 404', async () => {
  await withServer(async ({ baseUrl }) => {
    const { status, body } = await jsonFetch(`${baseUrl}/api/jobs/${UUID}`);
    assert.equal(status, 404);
    assert.equal(body.error.code, 'JOB_NOT_FOUND');
  });
});

test('POST /api/jobs/:jobId/cancel cancels a queued job (no external side effect needed)', async () => {
  await withServer(async ({ baseUrl }) => {
    const created = await jsonFetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody({ idempotencyKey: IDEM_KEY })),
    });
    const jobId = created.body.job.id;
    const { status, body } = await jsonFetch(`${baseUrl}/api/jobs/${jobId}/cancel`, { method: 'POST' });
    assert.equal(status, 200);
    assert.equal(body.job.status, 'cancelled');
    assert.ok(body.job.finishedAt);
  });
});

test('POST /api/jobs/:jobId/cancel on terminal status returns 409 INVALID_STATE_TRANSITION', async () => {
  await withServer(async ({ baseUrl }) => {
    const created = await jsonFetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody({ idempotencyKey: IDEM_KEY })),
    });
    const jobId = created.body.job.id;
    await jsonFetch(`${baseUrl}/api/jobs/${jobId}/cancel`, { method: 'POST' });
    const second = await jsonFetch(`${baseUrl}/api/jobs/${jobId}/cancel`, { method: 'POST' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'INVALID_STATE_TRANSITION');
  });
});

test('POST /api/jobs/:jobId/cancel unknown returns 404', async () => {
  await withServer(async ({ baseUrl }) => {
    const { status, body } = await jsonFetch(`${baseUrl}/api/jobs/${UUID}/cancel`, { method: 'POST' });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'JOB_NOT_FOUND');
  });
});
