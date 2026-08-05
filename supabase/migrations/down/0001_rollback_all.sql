-- ============================================================================
-- TapFlow Phase 1 — Down Migration（回滚全部 3 个 migration）
-- 执行顺序与 up 相反
-- ============================================================================

begin;

-- migration 003: RLS
drop policy if exists generation_jobs_worker_claim on generation_jobs;
drop policy if exists generation_jobs_owner on generation_jobs;
drop policy if exists upload_sessions_owner on upload_sessions;
drop policy if exists assets_owner on assets;
drop policy if exists confirmations_owner on confirmations;
drop policy if exists project_operations_owner on project_operations;
drop policy if exists canvas_edges_owner on canvas_edges;
drop policy if exists canvas_nodes_owner on canvas_nodes;
drop policy if exists projects_owner on projects;

alter table generation_jobs disable row level security;
alter table upload_sessions disable row level security;
alter table assets disable row level security;
alter table confirmations disable row level security;
alter table project_operations disable row level security;
alter table canvas_edges disable row level security;
alter table canvas_nodes disable row level security;
alter table projects disable row level security;

-- migration 002: upload_sessions
drop function if exists expire_stale_upload_sessions();
drop function if exists complete_upload(uuid, uuid, uuid, text, text, text, text, bigint, int, int);
drop table if exists upload_sessions;
drop type if exists upload_session_status;

-- migration 001: core
drop function if exists apply_project_operations(uuid, bigint, text, uuid, jsonb);
drop table if exists generation_jobs;
drop type if exists generation_job_status;
drop table if exists assets;
drop table if exists confirmations;
drop table if exists project_operations;
drop table if exists canvas_edges;
drop table if exists canvas_nodes;
drop table if exists projects;

-- buckets（保留，避免误删用户数据；如需删除取消注释）
-- delete from storage.buckets where id in ('uploads','generated','thumbs');

commit;
