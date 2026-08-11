/**
 * 模块解析 hook 实现（在 loader 线程运行）。
 *
 * 应用源码里的相对导入是无扩展名的（`../stores/nodesStore`），Next.js/webpack 能解析，
 * 但 Node ESM 要求显式扩展名。这里在测试运行时把无扩展名的相对导入补成 `.ts`/`.tsx`，
 * 从而无需为了可测性给源码加 `.ts` 后缀（那会要求开 allowImportingTsExtensions 并影响 next build）。
 */
const CANDIDATE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(specifier);

  if (isRelative && !hasExtension) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      try {
        return await nextResolve(specifier + suffix, context);
      } catch {
        // 试下一个候选后缀
      }
    }
  }

  return nextResolve(specifier, context);
}
