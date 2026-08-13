/**
 * Supabase Job repository 测试
 * 覆盖：RPC 参数准确、JWT 透传、404/409/401 映射、幂等 replay
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SupabaseJobRepository } from './supabaseJobRepository.ts';

const SUPABASE_URL = 'https://example.supabase.co';
const ANON_KEY = 'anon-key';

function mockFetch(routes: Record<string, (init: RequestInit, input?: string) => Response>) {
  return async (input: any, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return handler(init ?? {}, url);
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
  status: 'queued',
  provider_job_id: null,
  error_code: null,
  error_message: null,
  idempotency_key: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  cancel_requested_at: null,
  finished_at: null,
  created_at: '2026-08-07T00:00:00.000Z',
  updated_at: '2026-08-07T00:00:00.000Z',
};

test('create calls create_generation_job RPC with exact args', async () => {
  let calledUrl = '';
  let calledBody: any = null;
  let calledHeaders: any = null;
  const repo = new SupabaseJobRepository({
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    fetcher: mockFetch({
      'rpc/create_generation_job': (init) => {
        calledBody = JSON.parse(String(init.body));
        calledHeaders = init.headers;
        return jsonResponse([{ job: JOB_ROW, is_replay: false }]);
      },
    }) as typeof fetch,
  });

  const result = await repo.create({
    projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as any,
    jobType: 'text_to_image',
    model: 'gpt-image-2',
    params: { prompt: 'a red apple' },
    idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as any,
  }, 'Bearer test-jwt');

  assert.equal(result.idempotentReplay, false);
  assert.equal(result.job.id, JOB_ROW.id);
  assert.equal(calledBody.p_project_id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(calledBody.p_job_type, 'text_to_image');
  assert.equal(calledBody.p_model, 'gpt-image-2');
  assert.deepEqual(calledBody.p_params, { prompt: 'a red apple' });
  assert.equal(calledBody.p_idempotency_key, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.deepEqual(calledHeaders, {
    apikey: ANON_KEY,
    'content-type': 'application/json',
    authorization: 'Bearer test-jwt',
  });
});

test('create maps idempotent replay from RPC response', async () => {
  const repo = new SupabaseJobRepository({
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    fetcher: mockFetch({
      'rpc/create_generation_job': () => jsonResponse([{ job: JOB_ROW, is_replay: true }]),
    }) as typeof fetch,
  });

  const result = await repo.create({
    projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as any,
    jobType: 'text_to_image',
    model: 'gpt-image-2',
    params: {},
  });

  assert.equal(result.idempotentReplay, true);
});

test('cancel calls cancel_generation_job RPC', async () => {
  let calledBody: any = null;
  const repo = new SupabaseJobRepository({
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    fetcher: mockFetch({
      'rpc/cancel_generation_job': (init) => {
        calledBody = JSON.parse(String(init.body));
        const cancelled = { ...JOB_ROW, status: 'cancelled', finished_at: '2026-08-07T01:00:00.000Z' };
        return jsonResponse([{ job: cancelled }]);
      },
    }) as typeof fetch,
  });

  const result = await repo.cancel(JOB_ROW.id, 'Bearer test-jwt');

  assert.equal(result.job.status, 'cancelled');
  assert.equal(calledBody.p_job_id, JOB_ROW.id);
});

test('cancel maps terminal status to 409 INVALID_STATE_TRANSITION', async () => {
  const repo = new SupabaseJobRepository({
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    fetcher: mockFetch({
      'rpc/cancel_generation_job': () => jsonResponse([{ job: { ...JOB_ROW, status: 'succeeded' } }]),
    }) as typeof fetch,
  });

  await assert.rejects(
    () => repo.cancel(JOB_ROW.id, 'Bearer test-jwt'),
    (err: any) => err.name === 'JobStateTransitionError' && err.from === 'succeeded',
  );
});

test('cancel maps missing row to 404 JOB_NOT_FOUND', async () => {
  const repo = new SupabaseJobRepository({
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    fetcher: mockFetch({
      'rpc/cancel_generation_job': () => jsonResponse([], 404),
    }) as typeof fetch,
  });

  await assert.rejects(
    () => repo.cancel('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Bearer test-jwt'),
    (err: any) => err.name === 'JobNotFoundError',
  );
});

test('get maps 401 to UnauthorizedError', async () => {
  const repo = new SupabaseJobRepository({
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    fetcher: mockFetch({
      'rest/v1/generation_jobs': () => jsonResponse({ message: 'Invalid API key' }, 401),
    }) as typeof fetch,
  });

  await assert.rejects(
    () => repo.get(JOB_ROW.id),
    (err: any) => err.name === 'UnauthorizedError',
  );
});

test('listByProject queries generation_jobs filtered by project', async () => {
  let calledPath = '';
  const repo = new SupabaseJobRepository({
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    fetcher: mockFetch({
      'rest/v1/generation_jobs': () => {
        calledPath = '/rest/v1/generation_jobs';
        return jsonResponse([JOB_ROW]);
      },
    }) as typeof fetch,
  });

  const result = await repo.listByProject(JOB_ROW.project_id, 'Bearer test-jwt');

  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].id, JOB_ROW.id);
  assert.ok(calledPath.includes('rest/v1/generation_jobs'));
});

test('getOutputs queries generation_job_outputs ordered by ordinal', async () => {
  let calledPath = '';
  const repo = new SupabaseJobRepository({
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    fetcher: mockFetch({
      'rest/v1/generation_job_outputs': (init, input) => {
        calledPath = input ?? '';
        return jsonResponse([
          { asset_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', ordinal: 1 },
          { asset_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ordinal: 0 },
        ]);
      },
    }) as typeof fetch,
  });

  const result = await repo.getOutputs(JOB_ROW.id, 'Bearer test-jwt');

  assert.ok(calledPath.includes(`job_id=eq.${JOB_ROW.id}`));
  assert.ok(calledPath.includes('order=ordinal.asc'));
  assert.deepEqual(result, [
    { assetId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', ordinal: 1 },
    { assetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ordinal: 0 },
  ]);
});
