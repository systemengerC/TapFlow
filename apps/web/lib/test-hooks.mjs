/**
 * 模块解析 + 加载 hook（在 loader 线程运行）。
 *
 * 解析（resolve）：
 *   1. 应用源码里的相对导入是无扩展名的（`../stores/nodesStore`），Next.js/webpack 能解析，
 *      但 Node ESM 要求显式扩展名。这里在测试运行时把无扩展名的相对导入补成 `.ts`/`.tsx`，
 *      从而无需为了可测性给源码加 `.ts` 后缀（那会要求开 allowImportingTsExtensions 并影响 next build）。
 *   2. `@/*` 是 tsconfig paths 别名（指向 apps/web 根），Node 不认，这里映射成真实文件 URL。
 *
 * 加载（load）：
 *   Node 24 原生 type-stripping 只处理 `.ts`，不处理 `.tsx` 的 JSX 语法。组件级测试需要真实
 *   渲染组件，故用仓库已有的 typescript devDependency 把 `.tsx` transpile 成 ESM + jsx-runtime 调用。
 *   仅测试链路生效，不参与 next build。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const CANDIDATE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/** apps/web 根目录（本文件位于 apps/web/lib/） */
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function resolve(specifier, context, nextResolve) {
  // tsconfig paths 别名：@/lib/stores/canvasStore → <webRoot>/lib/stores/canvasStore
  if (specifier.startsWith('@/')) {
    const base = path.join(WEB_ROOT, specifier.slice(2));
    for (const suffix of ['', ...CANDIDATE_SUFFIXES]) {
      try {
        return await nextResolve(pathToFileURL(base + suffix).href, context);
      } catch {
        // 试下一个候选后缀
      }
    }
  }

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

  // 裸规范符（bare specifier）兜底：部分包（如 next）用无扩展名的子路径文件
  // （next/navigation → next/navigation.js）且没有 exports map。webpack 能解析，
  // Node ESM 要求显式扩展名，会抛 ERR_MODULE_NOT_FOUND。这里补 `.js` 重试。
  if (!isRelative && !hasExtension && !specifier.startsWith('@/') && !specifier.startsWith('node:')) {
    try {
      return await nextResolve(specifier, context);
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND') {
        return nextResolve(specifier + '.js', context);
      }
      throw err;
    }
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.tsx')) {
    const source = await readFile(new URL(url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        verbatimModuleSyntax: false,
      },
    });
    return { format: 'module', shortCircuit: true, source: outputText };
  }

  return nextLoad(url, context);
}
