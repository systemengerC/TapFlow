/**
 * TapFlow Worker — 状态机测试（03 契约 §9 测试矩阵）
 * 覆盖：正常成功 / fatal 失败 / 可重试重试成功 / 配额失败 / 取消三步 / 重复领取 / 事件序列
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Job, JobStatusEvent, JobType, Uuid } from '@tapflow/contracts';

import { FakeProvider, type ProviderRegistry } from './provider.ts';
import { Runner } from './runner.ts';
import { InMemoryWorkerStore } from './workerStore.ts';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111' as Uuid;

function makeJob(overrides: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID() as Uuid,
    projectId: PROJECT_ID,
    parentJobId: null,
    attempt: 1,
    jobType: 'text_to_image',
    provider: null,
    model: 'fake-model',
    params: { fake: {} },
    inputNodeIds: [],
    status: 'queued',
    providerJobId: null,
    errorCode: null,
    errorMessage: null,
    idempotencyKey: crypto.randomUUID() as Uuid,
    cancelRequestedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setup(params: Record<string, unknown>) {
  const store = new InMemoryWorkerStore();
  const fake = new FakeProvider();
  const registry: ProviderRegistry = new Map();
  for (const type of fake.jobTypes) {
    registry.set(type, fake);
  }
  const events: JobStatusEvent[] = [];
  const runner = new Runner(store, registry, { emit: (e) => events.push(e) }, {
    statusIntervalMs: 1,
    maxStatusAttempts: 3,
    cancelConfirmTimeoutMs: 100,
  });
  const job = makeJob({ params: { fake: params } });
  store.seed(job);
  return { store, runner, events, job };
}

test('success: queued → running → succeeded with assetIds in event', async () => {
  const { store, runner, events, job } = setup({});
  await runner.runOnce();
  const done = await store.get(job.id);
  assert.equal(done.status, 'succeeded');
  assert.ok(done.finishedAt);
  assert.ok(done.providerJobId?.startsWith('fake-'));
  const succeeded = events.find((e) => e.type === 'job.succeeded');
  assert.ok(succeeded && succeeded.type === 'job.succeeded');
  assert.equal(succeeded.assetIds.length, 1);
  assert.equal(events[0].type, 'job.running');
  assert.ok((events as JobStatusEvent[]).some((e) => e.type === 'job.succeeded'));
  // 输出资产写入
  assert.equal(store.getOutputs(job.id).length, 1);
});

test('multi-output: fake.outputCount=3 writes 3 outputs with ordinal 0..2', async () => {
  const { store, runner, job } = setup({ outputCount: 3 });
  await runner.runOnce();
  const outputs = store.getOutputs(job.id);
  assert.equal(outputs.length, 3);
  assert.deepEqual(outputs.map((o) => o.ordinal), [0, 1, 2]);
});

test('fatal: queued → running → failed with PROVIDER_AUTH_FAILED', async () => {
  const { store, runner, events, job } = setup({ outcome: 'fatal' });
  await runner.runOnce();
  const done = await store.get(job.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.errorCode, 'PROVIDER_AUTH_FAILED');
  assert.ok(done.finishedAt);
  const failed = events.find((e) => e.type === 'job.failed');
  assert.ok(failed && failed.type === 'job.failed');
  assert.equal(failed.errorCode, 'PROVIDER_AUTH_FAILED');
});

test('retryable: transient failures retry with exponential backoff then succeed', async () => {
  const { store, runner, job } = setup({ outcome: 'retryable', retryCount: 2 });
  await runner.runOnce();
  const done = await store.get(job.id);
  assert.equal(done.status, 'succeeded', 'transient failure should recover after retries');
});

test('retryable exhausted: fails after maxStatusAttempts retries', async () => {
  const { store, runner, job } = setup({ outcome: 'retryable', retryCount: 99 });
  await runner.runOnce();
  const done = await store.get(job.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.errorCode, 'PROVIDER_TIMEOUT');
});

test('quota_error: fails immediately (non-retryable category)', async () => {
  const { store, runner, job } = setup({ outcome: 'quota' });
  await runner.runOnce();
  const done = await store.get(job.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.errorCode, 'PROVIDER_QUOTA_EXCEEDED');
});

test('cancel: cancel_requested → cancelled when provider confirms', async () => {
  const { store, runner, events, job } = setup({});
  // 先跑成 running（不完成）：直接构造 running + cancel_requested
  const running = await store.claimNext();
  assert.ok(running);
  await store.setProviderJobId(job.id, `fake-${job.id}`);

  // 模拟用户取消：running → cancel_requested（API 层已做，这里直接改状态）
  const now = new Date().toISOString();
  const row = await store.get(job.id);
  row.status = 'cancel_requested';
  row.cancelRequestedAt = now;

  await runner.runOnce();
  const done = await store.get(job.id);
  assert.equal(done.status, 'cancelled');
  assert.equal(done.errorCode, 'CANCELLED');
  assert.ok(done.finishedAt);
  assert.ok(events.some((e) => e.type === 'job.cancelled'));
});

test('claim: two workers cannot claim the same queued job', async () => {
  const store = new InMemoryWorkerStore();
  store.seed(makeJob());
  const first = await store.claimNext();
  const second = await store.claimNext();
  assert.ok(first);
  assert.equal(second, null, 'only one worker should win the claim');
  assert.equal(first.status, 'running');
});

test('complete on terminal status is rejected (late completion ignored)', async () => {
  const { store, job } = setup({});
  await store.claimNext();
  await store.fail(job.id, 'PROVIDER_AUTH_FAILED', 'boom');
  await assert.rejects(() => store.complete(job.id, [{ url: 'https://x/y.png', mimeType: 'image/png' }]));
  const done = await store.get(job.id);
  assert.equal(done.status, 'failed', 'late complete must not overwrite terminal state');
});

test('no queued jobs: runOnce returns 0 and does not emit', async () => {
  const store = new InMemoryWorkerStore();
  const fake = new FakeProvider();
  const registry: ProviderRegistry = new Map();
  for (const type of fake.jobTypes) {
    registry.set(type, fake);
  }
  const events: JobStatusEvent[] = [];
  const runner = new Runner(store, registry, { emit: (e) => events.push(e) });
  const handled = await runner.runOnce();
  assert.equal(handled, 0);
  assert.equal(events.length, 0);
});
