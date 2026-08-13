/**
 * useProject 刷新恢复链路测试。
 *
 * 覆盖 gpt 门禁指出的缺口：快照中只有 jobId、没有 assetIds 的 generation_job 节点，
 * 加载后必须调 GET /api/jobs/:id 并用 outputs 回填 assetIds（浅合并保留 jobId），
 * 且回填走 applyLocal(update_node)（会进入持久化队列）。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';
import { useProject } from './useProject.ts';
import { useNodesStore } from '../stores/nodesStore.ts';
import type { Job, Uuid } from '@tapflow/contracts';

const PROJECT_ID = '99999999-9999-4999-8999-999999999999' as Uuid;
const NODE_ID = '11111111-1111-4111-8111-111111111111' as Uuid;
const JOB_ID = '22222222-2222-4222-8222-222222222222' as Uuid;
const ASSET_ID = '33333333-3333-4333-8333-333333333333' as Uuid;
const IDEM_KEY = '44444444-4444-4444-8444-444444444444' as Uuid;

const JOB: Job = {
  id: JOB_ID,
  projectId: PROJECT_ID,
  parentJobId: null,
  attempt: 1,
  jobType: 'text_to_image',
  provider: null,
  model: 'dall-e-3',
  params: { prompt: '一只猫' },
  inputNodeIds: [],
  status: 'succeeded',
  providerJobId: null,
  errorCode: null,
  errorMessage: null,
  idempotencyKey: IDEM_KEY,
  cancelRequestedAt: null,
  finishedAt: '2026-08-13T00:00:00.000Z',
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

function snapshotWith(data: unknown) {
  return {
    project: {
      id: PROJECT_ID,
      name: '测试项目',
      canvasVersion: 0,
      createdAt: '2026-08-13T00:00:00.000Z',
    },
    nodes: [
      {
        id: NODE_ID,
        nodeType: 'generation_job',
        parentNodeId: null,
        position: { x: 480, y: 120 },
        size: { width: 320, height: 240 },
        data,
        jobId: JOB_ID,
      },
    ],
    edges: [],
  };
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  useNodesStore.getState().replaceSnapshot([], [], 0);
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** 渲染一个调用 useProject 的 harness，拿到 loadSnapshot 供测试触发 */
function getHook() {
  let captured!: ReturnType<typeof useProject>;
  function Harness(): ReactElement | null {
    captured = useProject();
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return captured;
}

describe('useProject.loadSnapshot 刷新恢复', () => {
  test('只有 jobId 的 generation_job 节点：调 job API 回填 assetIds，保留 jobId', async () => {
    let jobFetchCount = 0;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/projects/')) {
        return okJson(snapshotWith({ jobId: JOB_ID, jobType: 'text_to_image', model: 'dall-e-3' }));
      }
      if (url.includes('/api/jobs/')) {
        jobFetchCount += 1;
        return okJson({ job: JOB, outputs: [{ assetId: ASSET_ID, ordinal: 0 }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const hook = getHook();
    await hook.loadSnapshot(PROJECT_ID);

    const node = useNodesStore.getState().nodes[NODE_ID];
    assert.ok(node, '节点应存在于 store');
    const data = node.data as { jobId: string; assetIds?: string[] };
    assert.deepEqual(data.assetIds, [ASSET_ID], '应回填 assetIds');
    assert.equal(data.jobId, JOB_ID, '浅合并必须保留 jobId');
    assert.equal(jobFetchCount, 1, 'job API 只应请求一次');

    const pending = useNodesStore.getState().pendingOperations;
    const update = pending.find((op) => op.type === 'update_node' && op.payload.nodeId === NODE_ID);
    assert.ok(update, '回填必须走 applyLocal(update_node) 进入持久化队列');
    assert.deepEqual((update!.payload as { patch: { assetIds: string[] } }).patch.assetIds, [ASSET_ID]);
  });

  test('已有 assetIds 的节点不重复请求 job API', async () => {
    let jobFetchCount = 0;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/projects/')) {
        return okJson(snapshotWith({ jobId: JOB_ID, assetIds: [ASSET_ID] }));
      }
      if (url.includes('/api/jobs/')) {
        jobFetchCount += 1;
        return okJson({ job: JOB, outputs: [{ assetId: ASSET_ID, ordinal: 0 }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const hook = getHook();
    await hook.loadSnapshot(PROJECT_ID);

    assert.equal(jobFetchCount, 0, '已有 assetIds 不应再次请求 job API');
    assert.deepEqual(
      (useNodesStore.getState().nodes[NODE_ID].data as { assetIds: string[] }).assetIds,
      [ASSET_ID],
    );
    assert.equal(useNodesStore.getState().pendingOperations.length, 0, '不应产生新的持久化操作');
  });

  test('job API 失败时静默跳过（不阻塞快照加载）', async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/projects/')) {
        return okJson(snapshotWith({ jobId: JOB_ID, jobType: 'text_to_image' }));
      }
      if (url.includes('/api/jobs/')) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const hook = getHook();
    // 不应 reject：单个节点恢复失败不影响快照加载
    await hook.loadSnapshot(PROJECT_ID);

    const node = useNodesStore.getState().nodes[NODE_ID];
    assert.ok(node, '节点仍应加载');
    assert.equal((node.data as { assetIds?: string[] }).assetIds, undefined, '失败时不回填');
  });

  test('job API 返回空 outputs 时不回填 assetIds', async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/projects/')) {
        return okJson(snapshotWith({ jobId: JOB_ID }));
      }
      if (url.includes('/api/jobs/')) {
        return okJson({ job: JOB, outputs: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const hook = getHook();
    await hook.loadSnapshot(PROJECT_ID);

    const node = useNodesStore.getState().nodes[NODE_ID];
    assert.equal((node.data as { assetIds?: string[] }).assetIds, undefined, '无输出时不写空数组');
  });
});
