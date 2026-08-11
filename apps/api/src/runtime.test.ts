/**
 * Runtime 装配测试（P0-1 修复验证）
 * 覆盖：
 *   - 内存模式：InMemory 全家 + EmbeddedWorkerJobRepository（seed 包装），worker 可启动/停止
 *   - Supabase 模式：Supabase 全家 + SupabaseWorkerStore 驱动 Runner，job 直接落库不 seed
 *   - SUPABASE_URL / SUPABASE_ANON_KEY 必须成对配置
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRuntime } from './runtime.ts';
import { EmbeddedWorkerJobRepository } from './embeddedWorker.ts';
import { SupabaseJobRepository } from './supabaseJobRepository.ts';

test('in-memory runtime wires InMemory repositories and embedded worker with seed wrapper', () => {
  const runtime = buildRuntime({ startWorker: false });
  try {
    assert.equal(runtime.workerMode, 'in-memory');
    assert.ok(runtime.jobRepository instanceof EmbeddedWorkerJobRepository);
    assert.ok(runtime.server, 'server should be created');
  } finally {
    runtime.stopWorker();
  }
});

test('supabase runtime wires Supabase repositories and worker without seed wrapper', () => {
  const runtime = buildRuntime({
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'anon-key',
    supabaseServiceKey: 'service-role-key',
    startWorker: false,
  });
  try {
    assert.equal(runtime.workerMode, 'supabase');
    // job 直接落库：不套 EmbeddedWorkerJobRepository（其 seed 依赖 InMemory store）
    assert.ok(runtime.jobRepository instanceof SupabaseJobRepository);
    assert.ok(!(runtime.jobRepository instanceof EmbeddedWorkerJobRepository));
    assert.ok(runtime.server, 'server should be created');
  } finally {
    runtime.stopWorker();
  }
});

test('supabase runtime rejects mismatched SUPABASE_URL / SUPABASE_ANON_KEY', () => {
  assert.throws(
    () => buildRuntime({ supabaseUrl: 'https://example.supabase.co' }),
    /SUPABASE_URL and SUPABASE_ANON_KEY must be configured together/,
  );
});
