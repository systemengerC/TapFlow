import { buildRuntime } from './runtime.ts';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);

const runtime = buildRuntime({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
});

runtime.server.listen(port, '0.0.0.0', () => {
  console.log(`TapFlow API listening on http://localhost:${port}`);
  console.log(`[worker] ${runtime.workerMode} worker started`);
});
