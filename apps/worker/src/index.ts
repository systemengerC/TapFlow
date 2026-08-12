/**
 * TapFlow Worker — 独立进程启动入口（生产部署）
 *
 * 环境变量：
 *   SUPABASE_URL          Supabase 项目 URL（配置即进入 Supabase 模式）
 *   SUPABASE_ANON_KEY     匿名 key（RPC/RLS 请求头 apikey）
 *   SUPABASE_SERVICE_KEY  service_role key（worker 领取任务 + 转存 generated bucket；
 *                         不配置则 complete 时透传 provider URL，仅限联调）
 *   POLL_INTERVAL_MS      Runner 轮询间隔（默认 2000）
 *
 * 无 SUPABASE_URL 时回退内存模式（InMemoryWorkerStore + FakeProvider），
 * 用于本地无数据库联调；生产必须配置 Supabase 三件套。
 */
import { FakeProvider, type ProviderRegistry } from './provider.ts';
import { Runner } from './runner.ts';
import { InMemoryWorkerStore, type WorkerStore } from './workerStore.ts';
import { SupabaseWorkerStore } from './supabaseWorkerStore.ts';

function buildProviderRegistry(): ProviderRegistry {
  const providers: ProviderRegistry = new Map();
  const fake = new FakeProvider();
  for (const jobType of fake.jobTypes) {
    providers.set(jobType, fake);
  }
  return providers;
}

function buildStore(): { store: WorkerStore; mode: 'in-memory' | 'supabase' } {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (Boolean(supabaseUrl) !== Boolean(supabaseAnonKey)) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be configured together');
  }
  if (supabaseUrl && supabaseAnonKey) {
    return {
      mode: 'supabase',
      store: new SupabaseWorkerStore({
        supabaseUrl,
        anonKey: supabaseAnonKey,
        serviceKey: process.env.SUPABASE_SERVICE_KEY,
      }),
    };
  }
  return { mode: 'in-memory', store: new InMemoryWorkerStore() };
}

function main(): void {
  const { store, mode } = buildStore();
  const pollIntervalMs = Number.parseInt(process.env.POLL_INTERVAL_MS ?? '2000', 10);

  const runner = new Runner(
    store,
    buildProviderRegistry(),
    {
      emit(event) {
        const extra = 'assetIds' in event ? ` assetIds=${JSON.stringify(event.assetIds)}` : '';
        console.log(`[tapflow-worker] ${event.type} job=${event.jobId}${extra}`);
      },
    },
    { pollIntervalMs },
  );

  runner.start();
  console.log(`[tapflow-worker] started in ${mode} mode, poll interval ${pollIntervalMs}ms`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`[tapflow-worker] received ${signal}, shutting down...`);
    runner.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main();
