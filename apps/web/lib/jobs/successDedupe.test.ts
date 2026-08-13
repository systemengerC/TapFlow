/**
 * 成功任务去重控制器测试。
 * 覆盖 gpt 门禁指出的缺口：成功任务并发去重（同一 job 只回调一次），
 * 且 getJob 失败时不提前登记完成（允许后续重试）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSucceededJobGuard } from './successDedupe.ts';

const JOB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('成功任务去重守卫', () => {
  test('claim 后 shouldProcess 为 false（在途去重，防并发重复请求）', () => {
    const guard = createSucceededJobGuard();
    assert.equal(guard.shouldProcess(JOB_A), true);
    guard.claim(JOB_A);
    assert.equal(guard.shouldProcess(JOB_A), false, '在途 job 不得重复处理');
    // 其他 job 不受影响
    assert.equal(guard.shouldProcess(JOB_B), true);
  });

  test('getJob 失败 release 后可重试，不登记完成', () => {
    const guard = createSucceededJobGuard();
    guard.claim(JOB_A);
    guard.release(JOB_A); // getJob 失败
    assert.equal(guard.shouldProcess(JOB_A), true, '失败后应允许重试');
    assert.equal(guard.isCompleted(JOB_A), false, '失败不得提前登记完成');
  });

  test('getJob 成功 complete 后永久去重', () => {
    const guard = createSucceededJobGuard();
    guard.claim(JOB_A);
    guard.complete(JOB_A);
    assert.equal(guard.shouldProcess(JOB_A), false, '完成后不得再次回调');
    assert.equal(guard.isCompleted(JOB_A), true);
  });

  test('完整流程：并发命中两次只处理一次', () => {
    const guard = createSucceededJobGuard();
    let processed = 0;
    // 模拟两次轮询同时命中（React effect 重跑）
    for (let i = 0; i < 2; i += 1) {
      if (guard.shouldProcess(JOB_A)) {
        guard.claim(JOB_A);
        processed += 1;
        guard.complete(JOB_A);
      }
    }
    assert.equal(processed, 1, '同一 succeeded job 只应回调一次');
  });

  test('失败→重试→成功：最终只回调一次', () => {
    const guard = createSucceededJobGuard();
    let processed = 0;
    const attempt = (succeed: boolean) => {
      if (!guard.shouldProcess(JOB_A)) return;
      guard.claim(JOB_A);
      if (succeed) {
        guard.complete(JOB_A);
        processed += 1;
      } else {
        guard.release(JOB_A);
      }
    };
    attempt(false); // 第一次 getJob 失败
    assert.equal(processed, 0);
    attempt(true); // 第二次成功
    assert.equal(processed, 1);
    attempt(true); // 第三次再命中：已被完成集合拦截
    assert.equal(processed, 1);
  });
});
