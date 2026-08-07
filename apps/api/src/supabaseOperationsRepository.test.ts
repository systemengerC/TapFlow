import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ApplyOperationsRequest } from '@tapflow/contracts';

import { VersionConflictError } from './app.ts';
import { SupabaseOperationsRepository } from './supabaseOperationsRepository.ts';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const GROUP_ID = '33333333-3333-4333-8333-333333333333';
const request: ApplyOperationsRequest = {
  baseVersion: 4,
  operationGroupId: GROUP_ID,
  operations: [{
    operationId: OPERATION_ID,
    type: 'set_viewport',
    payload: { viewport: { x: 0, y: 0, zoom: 1 } },
  }],
};

test('Supabase repository calls the reviewed RPC with the caller JWT', async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return Response.json(5);
  };
  const repository = new SupabaseOperationsRepository({
    supabaseUrl: 'https://example.supabase.co',
    anonKey: 'anon-key',
    fetcher,
  });

  const result = await repository.apply(PROJECT_ID, request, 'Bearer user-jwt');

  assert.deepEqual(result, { appliedOperationIds: [OPERATION_ID], canvasVersion: 5 });
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].input), 'https://example.supabase.co/rest/v1/rpc/apply_project_operations');
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'Bearer user-jwt');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    p_project_id: PROJECT_ID,
    p_base_version: 4,
    p_actor: 'user',
    p_group_id: GROUP_ID,
    p_operations: request.operations,
  });
});

test('Supabase repository maps a database conflict and returns the current version', async () => {
  const fetcher: typeof fetch = async (input) => {
    if (String(input).includes('/rpc/')) {
      return Response.json({ code: '23505', message: 'CONFLICT: canvas version 4 does not match current' }, { status: 400 });
    }
    return Response.json([{ canvas_version: 7 }]);
  };
  const repository = new SupabaseOperationsRepository({
    supabaseUrl: 'https://example.supabase.co/',
    anonKey: 'anon-key',
    fetcher,
  });

  await assert.rejects(
    repository.apply(PROJECT_ID, request, 'Bearer user-jwt'),
    (error: unknown) => error instanceof VersionConflictError && error.currentVersion === 7,
  );
});

test('Supabase repository requires caller authorization', async () => {
  const repository = new SupabaseOperationsRepository({
    supabaseUrl: 'https://example.supabase.co',
    anonKey: 'anon-key',
  });

  await assert.rejects(
    repository.apply(PROJECT_ID, request),
    /Authorization is required/,
  );
});