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
import { InMemoryWorkerStore } from '../../worker/src/workerStore.ts';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (Boolean(supabaseUrl) !== Boolean(supabaseAnonKey)) {
  throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be configured together');
}

const useSupabase = Boolean(supabaseUrl && supabaseAnonKey);
const operationsRepository = useSupabase
  ? new SupabaseOperationsRepository({ supabaseUrl: supabaseUrl!, anonKey: supabaseAnonKey! })
  : new InMemoryOperationsRepository();
const projectRepository = useSupabase
  ? new SupabaseProjectRepository({ supabaseUrl: supabaseUrl!, anonKey: supabaseAnonKey! })
  : new InMemoryProjectRepository();
const uploadRepository = useSupabase
  ? new SupabaseUploadRepository({ supabaseUrl: supabaseUrl!, anonKey: supabaseAnonKey! })
  : new InMemoryUploadRepository();
const jobRepository = useSupabase
  ? new SupabaseJobRepository({ supabaseUrl: supabaseUrl!, anonKey: supabaseAnonKey! })
  : new InMemoryJobRepository();

// 内存模式（dev/联调）：内嵌 Worker，让 queued→running→succeeded 全链路单进程可见。
// Supabase 模式走独立 worker 进程 + 共享数据库，不内嵌。
let embeddedRunner: ReturnType<typeof startEmbeddedWorker> | undefined;
let effectiveJobRepository: JobRepository = jobRepository;
if (!useSupabase) {
  const workerStore = new InMemoryWorkerStore();
  effectiveJobRepository = new EmbeddedWorkerJobRepository(jobRepository, workerStore);
  embeddedRunner = startEmbeddedWorker(workerStore);
}

const server = createApp({ repository: operationsRepository, projectRepository, uploadRepository, jobRepository: effectiveJobRepository });

server.listen(port, '0.0.0.0', () => {
  console.log(`TapFlow API listening on http://localhost:${port}`);
  if (embeddedRunner) {
    console.log('[embedded-worker] in-memory worker started (dev mode)');
  }
});