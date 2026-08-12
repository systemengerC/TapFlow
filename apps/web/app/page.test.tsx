/**
 * 产品根入口测试。
 *
 * 覆盖 gpt 门禁指出的缺口：`/` 必须重定向到 `/workspace`，
 * 否则用户看到的是 Next.js 脚手架首页（P0：无产品入口）。
 *
 * Next.js 的 redirect() 会抛出特殊的 NEXT_REDIRECT 错误来终止渲染，
 * 我们验证组件确实抛出了带正确目标路径的重定向错误。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('根路由重定向', () => {
  test('渲染 / 时重定向到 /workspace', async () => {
    const { default: Home } = await import('./page.tsx');

    try {
      Home();
      assert.fail('组件必须抛出 NEXT_REDIRECT，不能正常返回');
    } catch (err) {
      assert.ok(err instanceof Error, '必须抛出 Error 实例');
      assert.match(err.message, /NEXT_REDIRECT/, '错误消息必须包含 NEXT_REDIRECT');

      // Next.js 把重定向目标编码在 digest 字段：NEXT_REDIRECT;replace;/workspace;307;
      const digest = (err as Error & { digest?: string }).digest;
      assert.ok(digest, '重定向错误必须带 digest');
      assert.ok(digest.includes('/workspace'), `重定向目标必须是 /workspace，实际 digest: ${digest}`);
    }
  });
});
