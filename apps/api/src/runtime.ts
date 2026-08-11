/**
 * TapFlow API — Runtime 装配（可测试的依赖注入边界）
 * 根据环境配置装配 repository + worker，与 HTTP listen 解耦。
 * 内存模式：InMemory 全家 + EmbeddedWorkerJobRepository（seed 包装）+ 内嵌 Runner。
 * Supabase 模式：Supabase 全家 + SupabaseWorkerStore 驱动的 Runner（job 已落库，不 seed）。
 */
import { createApp, InMemoryOperationsRepository } from './app.ts';
import { EmbeddedWorkerJobRepository, startEmbeddedWorker } from './embeddedWorker.ts';
import type { JobRepository } from './jobRepository.ts';
import { InMemoryJobRepository } from './jobRepository.ts';
import { InMemoryProjectRepository } from './projectRepository.ts';
import { InMemoryUploadRepository } from './uploadRepository.ts';
import { SupabaseJobRepository } from './supabaseJobRepository.ts';
import { SupabaseOperationsRepository } from './supabaseOperationsRepository.ts';
import { SupabaseProjectRepository } from './supabaseProjectRepository.ts';
import { SupabaseUploadRepository } from './supabaseUploadRepository.ts';
import { SupabaseWorkerStore } from './supabaseWorkerStore.ts';
import { InMemoryWorkerStore } from '../../worker/src/workerStore.ts';

export type RuntimeConfig = {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  supabaseServiceKey?: string;
  /** 是否启动 worker 轮询（默认 true；测试传 false 避免网络轮询） */
  startWorker?: boolean;
};

export type Runtime = {
  server: ReturnType<typeof createApp>;
  jobRepository: JobRepository;
  workerMode: 'in-memory' | 'supabase';
  stopWorker: () => void;
};

export function buildRuntime(config: RuntimeConfig = {}): Runtime {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceKey, startWorker = true } = config;
  if (Boolean(supabaseUrl) !== Boolean(supabaseAnonKey)) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be configured together');
  }

  const useSupabase = Boolean(supabaseUrl && supabaseAnonKey);
  const projectRepository = useSupabase
    ? new SupabaseProjectRepository({ supabaseUrl: supabaseUrl!, anonKey: supabaseAnonKey! })
    : new InMemoryProjectRepository();
  const operationsRepository = useSupabase
    ? new SupabaseOperationsRepository({ supabaseUrl: supabaseUrl!, anonKey: supabaseAnonKey! })
    // 内存模式：注入同一个 projectRepository，让 operations 真正写入画布快照
    : new InMemoryOperationsRepository(projectRepository as InMemoryProjectRepository);
  const uploadRepository = useSupabase
    ? new SupabaseUploadRepository({ supabaseUrl: supabaseUrl!, anonKey: supabaseAnonKey! })
    : new InMemoryUploadRepository();
  const jobRepository = useSupabase
    ? new SupabaseJobRepository({ supabaseUrl: supabaseUrl!, anonKey: supabaseAnonKey! })
    : new InMemoryJobRepository();

  let effectiveJobRepository: JobRepository = jobRepository;
  let workerMode: Runtime['workerMode'] = 'in-memory';
  let runner: ReturnType<typeof startEmbeddedWorker> | undefined;

  if (useSupabase) {
    // Supabase 模式：job 由 SupabaseJobRepository 直接落库，Worker 用
    // SupabaseWorkerStore 从共享 DB 领取（claim RPC），无需 seed 包装。
    const workerStore = new SupabaseWorkerStore({
      supabaseUrl: supabaseUrl!,
      anonKey: supabaseAnonKey!,
      serviceKey: supabaseServiceKey,
    });
    if (startWorker) {
      runner = startEmbeddedWorker(workerStore);
    }
    workerMode = 'supabase';
  } else {
    // 内存模式（dev/联调）：共享 InMemory store，让 queued→running→succeeded 单进程可见。
    const workerStore = new InMemoryWorkerStore();
    effectiveJobRepository = new EmbeddedWorkerJobRepository(jobRepository, workerStore);
    if (startWorker) {
      runner = startEmbeddedWorker(workerStore);
    }
  }

  const server = createApp({
    repository: operationsRepository,
    projectRepository,
    uploadRepository,
    jobRepository: effectiveJobRepository,
  });

  return {
    server,
    jobRepository: effectiveJobRepository,
    workerMode,
    stopWorker: () => runner?.stop(),
  };
}
