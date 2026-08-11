/**
 * 测试入口：注册 test-hooks.mjs 的解析 hook。
 *
 * 用法：node --import ./lib/test-resolver.mjs --test "lib/**\/*.test.ts"
 */
import { register } from 'node:module';

register('./test-hooks.mjs', import.meta.url);
