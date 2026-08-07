import { createApp, InMemoryOperationsRepository } from './app.ts';
import { InMemoryProjectRepository } from './projectRepository.ts';
import { SupabaseOperationsRepository } from './supabaseOperationsRepository.ts';
import { SupabaseProjectRepository } from './supabaseProjectRepository.ts';

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
const server = createApp({ repository: operationsRepository, projectRepository });

server.listen(port, '0.0.0.0', () => {
  console.log(`TapFlow API listening on http://localhost:${port}`);
});