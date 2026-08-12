/**
 * 重试控制器测试。
 *
 * 核心约束：失败任务的重试按钮是异步提交。若不加在途守卫，连续点击会创建多个重复 job
 * （每次 createJob 都会生成新的 idempotencyKey，服务端幂等键无法去重）。
 * 另外提交失败必须可见——静默失败会让用户以为已重新排队。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildRetryRequest, createRetryController } from './retryController.ts';
import type { Job, Uuid } from '@tapflow/contracts';

const JOB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as Uuid;
const JOB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as Uuid;
const NODE_A = '11111111-1111-4111-8111-111111111111' as Uuid;

function failedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_A,
    projectId: '99999999-9999-4999-8999-999999999999' as Uuid,
    parentJobId: null,
    attempt: 1,
    jobType: 'text_to_image',
    provider: 'openai',
    model: 'dall-e-3',
    params: { prompt: '一只猫', size: '1024x1024' },
    inputNodeIds: [NODE_A],
    status: 'failed',
    providerJobId: null,
    errorCode: 'PROVIDER_TIMEOUT',
    errorMessage: 'provider timeout',
    idempotencyKey: '88888888-8888-4888-8888-888888888888' as Uuid,
    cancelRequestedAt: null,
    finishedAt: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  } as Job;
}

/** 手动可控的 deferred，用于制造"提交在途"窗口 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('buildRetryRequest 原参数透传', () => {
  test('保留 jobType / model / params / inputNodeIds', () => {
    const job = failedJob();
    const req = buildRetryRequest(job);

    assert.equal(req.jobType, 'text_to_image');
    assert.equal(req.model, 'dall-e-3');
    assert.deepEqual(req.params, { prompt: '一只猫', size: '1024x1024' });
    assert.deepEqual(req.inputNodeIds, [NODE_A]);
  });

  test('不透传旧 idempotencyKey（否则服务端幂等去重会让重试变成空操作）', () => {
    const req = buildRetryRequest(failedJob());
    assert.ok(
      !('idempotencyKey' in req),
      '重试必须让服务端生成新幂等键，否则返回原失败 job',
    );
  });

  test('不透传 status / errorMessage 等结果字段', () => {
    const req = buildRetryRequest(failedJob());
    assert.deepEqual(
      Object.keys(req).sort(),
      ['inputNodeIds', 'jobType', 'model', 'params'],
      '只允许提交请求字段',
    );
  });
});

describe('createRetryController 防重复提交', () => {
  test('在途期间第二次点击被丢弃，只提交一次', async () => {
    const calls: Uuid[] = [];
    const gate = deferred<Uuid | null>();
    const controller = createRetryController(async (_req, jobId) => {
      calls.push(jobId);
      return gate.promise;
    });

    const first = controller.retry(failedJob());
    // 在途时再次点击（用户双击）
    const second = controller.retry(failedJob());

    assert.equal(controller.isSubmitting(JOB_A), true, '在途应标记为提交中');
    gate.resolve(JOB_A);
    await Promise.all([first, second]);

    assert.equal(calls.length, 1, '连续点击只应产生一次提交');
    assert.equal(controller.isSubmitting(JOB_A), false, '完成后应解除在途标记');
  });

  test('提交完成后可再次重试', async () => {
    let count = 0;
    const controller = createRetryController(async () => {
      count += 1;
      return JOB_A;
    });

    await controller.retry(failedJob());
    await controller.retry(failedJob());

    assert.equal(count, 2, '上一次完成后应允许再次提交');
  });

  test('不同 job 的在途状态互不影响', async () => {
    const gate = deferred<Uuid | null>();
    const submitted: Uuid[] = [];
    const controller = createRetryController(async (_req, jobId) => {
      submitted.push(jobId);
      return gate.promise;
    });

    const a = controller.retry(failedJob({ id: JOB_A }));
    const b = controller.retry(failedJob({ id: JOB_B }));

    assert.equal(controller.isSubmitting(JOB_A), true);
    assert.equal(controller.isSubmitting(JOB_B), true);
    gate.resolve(JOB_A);
    await Promise.all([a, b]);

    assert.deepEqual(submitted, [JOB_A, JOB_B], '两个不同 job 都应提交');
  });
});

describe('createRetryController 失败可见', () => {
  test('提交抛错时记录错误并解除在途标记', async () => {
    const controller = createRetryController(async () => {
      throw new Error('网络中断');
    });

    await controller.retry(failedJob());

    assert.equal(controller.errorFor(JOB_A), '网络中断', '错误必须可读取用于展示');
    assert.equal(controller.isSubmitting(JOB_A), false, '失败后必须解除在途，否则按钮永久禁用');
  });

  test('createJob 返回 null（契约/参数校验失败）也算提交失败', async () => {
    const controller = createRetryController(async () => null);

    await controller.retry(failedJob());

    assert.ok(controller.errorFor(JOB_A), 'null 返回值必须产生可见错误');
    assert.equal(controller.isSubmitting(JOB_A), false);
  });

  test('重试成功时清除上一次的错误', async () => {
    let shouldFail = true;
    const controller = createRetryController(async () => {
      if (shouldFail) throw new Error('第一次失败');
      return JOB_A;
    });

    await controller.retry(failedJob());
    assert.equal(controller.errorFor(JOB_A), '第一次失败');

    shouldFail = false;
    await controller.retry(failedJob());
    assert.equal(controller.errorFor(JOB_A), null, '成功后应清除旧错误');
  });

  test('订阅者在状态变化时被通知（驱动按钮禁用/错误渲染）', async () => {
    let notified = 0;
    const controller = createRetryController(async () => JOB_A);
    const unsubscribe = controller.subscribe(() => {
      notified += 1;
    });

    await controller.retry(failedJob());
    unsubscribe();

    assert.ok(notified >= 2, `状态变化应至少通知两次（开始/结束），实际 ${notified}`);
  });
});
