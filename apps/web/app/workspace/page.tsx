/**
 * /workspace — 工作台主页面。
 * useSearchParams 需要 Suspense 边界（Next.js App Router 预渲染要求），
 * 实际交互逻辑在 WorkspaceClient 里。
 */
import { Suspense } from 'react';
import WorkspaceClient from './WorkspaceClient';

export default function WorkspacePage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            color: '#8a8a9a',
            background: '#0f0f14',
          }}
        >
          加载中...
        </div>
      }
    >
      <WorkspaceClient />
    </Suspense>
  );
}
