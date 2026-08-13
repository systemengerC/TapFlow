/**
 * 媒体重试预算纯函数测试。
 * 覆盖 gpt 门禁指出的缺口：重试必须有真正上限（重新签名成功不重置同一轮媒体失败次数）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA_MAX_RETRIES, isMediaRetryExhausted, nextMediaRetryDelay } from './mediaRetry.ts';

describe('isMediaRetryExhausted（有界重试）', () => {
  test('attempt 0/1/2 未耗尽（可重试）', () => {
    assert.equal(isMediaRetryExhausted(0), false);
    assert.equal(isMediaRetryExhausted(1), false);
    assert.equal(isMediaRetryExhausted(MEDIA_MAX_RETRIES - 1), false);
  });

  test('attempt >= MEDIA_MAX_RETRIES 时耗尽（停止重签）', () => {
    assert.equal(isMediaRetryExhausted(MEDIA_MAX_RETRIES), true);
    assert.equal(isMediaRetryExhausted(MEDIA_MAX_RETRIES + 10), true);
  });

  test('重试上限必须为 3（防止无限重签）', () => {
    assert.equal(MEDIA_MAX_RETRIES, 3);
  });
});

describe('nextMediaRetryDelay（退避）', () => {
  test('按次数线性退避且上限 5s', () => {
    assert.equal(nextMediaRetryDelay(1), 1000);
    assert.equal(nextMediaRetryDelay(2), 2000);
    assert.equal(nextMediaRetryDelay(3), 3000);
    assert.equal(nextMediaRetryDelay(4), 4000);
    assert.equal(nextMediaRetryDelay(5), 5000);
    assert.equal(nextMediaRetryDelay(99), 5000, '超过 5s 必须封顶');
  });
});
