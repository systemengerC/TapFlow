/**
 * Supabase WorkerStore 测试
 * 覆盖：migration 005 Worker 生命周期 RPC 的调用参数、结果映射、错误映射、凭证透传
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SupabaseWorkerStore } from './supabaseWorkerStore.ts';
import { JobNotFoundError, JobStateTransitionError } from '../../worker/src/workerStore.ts';

const SUPABASE_URL = 'https://example.supabase.co';
const ANON_KEY = 'anon-key';
const SERVICE_KEY = 'service-role-key';

const JOB_ROW = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  project_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  parent_job_id: null,
  attempt: 1,
  job_type: 'text_to_image',
  provider: null,
  model: 'gpt-image-2',
  params: { prompt: 'a red apple' },
  input_node_ids: [],
  status: 'running',
  provider_job_id: 'fake-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  error_code: null,
  error_message: null,
  idempotency_key: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  cancel_requested_at: null,
  finished_at: null,
  created_at: '2026-08-07T00:00:00.000Z',
  updated_at: '2026-08-07T00:00:00.000Z',
};

function mockFetch(routes: Record<string, (init: RequestInit) => Response>) {
  return async (input: any, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return handler(init ?? {});
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeStore(routes: Record<string, (init: RequestInit) => Response>, serviceKey?: string) {
  return new SupabaseWorkerStore({
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    serviceKey,
    fetcher: mockFetch(routes) as typeof fetch,
  });
}

test('claimNext calls claim_next_generation_job and maps the claimed job', async () => {
  let calledBody: any = null;
  let calledHeaders: any = null;
  const store = makeStore({
    'rpc/claim_next_generation_job': (init) => {
      calledBody = JSON.parse(String(init.body));
      calledHeaders = init.headers;
      return jsonResponse([{ job: { ...JOB_ROW, status: 'running' } }]);
    },
  }, SERVICE_KEY);

  const job = await store.claimNext();

  assert.equal(job?.id, JOB_ROW.id);
  assert.equal(job?.status, 'running');
  assert.deepEqual(calledBody, {});
  assert.equal(new Headers(calledHeaders).get('authorization'), `Bearer ${SERVICE_KEY}`);
});

test('claimNext returns null when the queue is empty', async () => {
  const store = makeStore({
    'rpc/claim_next_generation_job': () => jsonResponse([]),
  });
  assert.equal(await store.claimNext(), null);
});

test('setProviderJobId calls the RPC with job id and provider id', async () => {
  let calledBody: any = null;
  const store = makeStore({
    'rpc/set_generation_job_provider_id': (init) => {
      calledBody = JSON.parse(String(init.body));
      return jsonResponse([{ job: JOB_ROW }]);
    },
  });

  await store.setProviderJobId(JOB_ROW.id, 'fake-job-1');

  assert.deepEqual(calledBody, { p_job_id: JOB_ROW.id, p_provider_job_id: 'fake-job-1' });
});

test('complete calls complete_generation_job then reads output rows', async () => {
  let calledBody: any = null;
  const store = makeStore({
    'rpc/complete_generation_job': (init) => {
      calledBody = JSON.parse(String(init.body));
      return jsonResponse([{ job: { ...JOB_ROW, status: 'succeeded' } }]);
    },
    'generation_job_outputs': () =>
      jsonResponse([
        { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', asset_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ordinal: 0 },
      ]),
  });

  const result = await store.complete(JOB_ROW.id, [
    { url: 'https://fake.local/outputs/0.png', mimeType: 'image/png', width: 1024, height: 1024 },
  ]);

  assert.equal(result.job.status, 'succeeded');
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].assetId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  assert.equal(result.outputs[0].ordinal, 0);
  assert.equal(result.outputs[0].url, 'https://fake.local/outputs/0.png');
  assert.deepEqual(calledBody.p_outputs, [
    { url: 'https://fake.local/outputs/0.png', mimeType: 'image/png', width: 1024, height: 1024 },
  ]);
});

test('fail maps JOB_NOT_FOUND to JobNotFoundError', async () => {
  const store = makeStore({
    'rpc/fail_generation_job': () =>
      jsonResponse({ code: 'P0002', message: 'JOB_NOT_FOUND', details: null }, 400),
  });

  await assert.rejects(
    () => store.fail(JOB_ROW.id, 'INTERNAL_ERROR', 'boom'),
    (err: unknown) => err instanceof JobNotFoundError,
  );
});

test('fail maps INVALID_STATE_TRANSITION to JobStateTransitionError', async () => {
  const store = makeStore({
    'rpc/fail_generation_job': () =>
      jsonResponse({ code: 'P0001', message: 'INVALID_STATE_TRANSITION: cannot fail job in status succeeded' }, 400),
  });

  await assert.rejects(
    () => store.fail(JOB_ROW.id, 'INTERNAL_ERROR', 'boom'),
    (err: unknown) => err instanceof JobStateTransitionError,
  );
});

test('resolveCancel and rollbackCancel call their RPCs', async () => {
  let resolveBody: any = null;
  let rollbackBody: any = null;
  const store = makeStore({
    'rpc/resolve_cancel_generation_job': (init) => {
      resolveBody = JSON.parse(String(init.body));
      return jsonResponse([{ job: { ...JOB_ROW, status: 'cancelled' } }]);
    },
    'rpc/rollback_cancel_generation_job': (init) => {
      rollbackBody = JSON.parse(String(init.body));
      return jsonResponse([{ job: { ...JOB_ROW, status: 'running' } }]);
    },
  });

  const cancelled = await store.resolveCancel(JOB_ROW.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(resolveBody, { p_job_id: JOB_ROW.id });

  const running = await store.rollbackCancel(JOB_ROW.id);
  assert.equal(running.status, 'running');
  assert.deepEqual(rollbackBody, { p_job_id: JOB_ROW.id });
});

test('listCancelRequested and get query generation_jobs with JOB_SELECT', async () => {
  const store = makeStore({
    'rest/v1/generation_jobs': () => jsonResponse([{ ...JOB_ROW, status: 'cancel_requested' }]),
  });

  const pending = await store.listCancelRequested();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'cancel_requested');

  const job = await store.get(JOB_ROW.id);
  assert.equal(job.id, JOB_ROW.id);
});

test('uses anon key headers when no service key is configured', async () => {
  let calledHeaders: any = null;
  const store = makeStore({
    'rpc/claim_next_generation_job': (init) => {
      calledHeaders = init.headers;
      return jsonResponse([]);
    },
  });

  await store.claimNext();

  const headers = new Headers(calledHeaders);
  assert.equal(headers.get('apikey'), ANON_KEY);
  assert.equal(headers.get('authorization'), null);
});
