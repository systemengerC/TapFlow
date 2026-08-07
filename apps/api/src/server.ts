import { createApp, InMemoryOperationsRepository } from './app.ts';
import { SupabaseOperationsRepository } from './supabaseOperationsRepository.ts';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (Boolean(supabaseUrl) !== Boolean(supabaseAnonKey)) {
  throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be configured together');
}

const repository = supabaseUrl && supabaseAnonKey
  ? new SupabaseOperationsRepository({ supabaseUrl, anonKey: supabaseAnonKey })
  : new InMemoryOperationsRepository();
const server = createApp({ repository });

server.listen(port, '0.0.0.0', () => {
  console.log(`TapFlow API listening on http://localhost:${port}`);
});