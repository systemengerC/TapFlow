-- ============================================================================
-- TapFlow Phase 1 — Migration 003: RLS Policies
-- 契约基准: packages/contracts v1.4 + 01/02/03 契约
-- 原则: 所有权 = user_id = auth.uid()，或经 project 归属判定
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
alter table projects enable row level security;
create policy projects_owner on projects
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- canvas_nodes / canvas_edges / project_operations
-- 通过 project_id → projects.user_id 归属判定
-- ---------------------------------------------------------------------------
alter table canvas_nodes enable row level security;
create policy canvas_nodes_owner on canvas_nodes
  for all using (
    exists (select 1 from projects p where p.id = canvas_nodes.project_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from projects p where p.id = canvas_nodes.project_id and p.user_id = auth.uid())
  );

alter table canvas_edges enable row level security;
create policy canvas_edges_owner on canvas_edges
  for all using (
    exists (select 1 from projects p where p.id = canvas_edges.project_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from projects p where p.id = canvas_edges.project_id and p.user_id = auth.uid())
  );

alter table project_operations enable row level security;
create policy project_operations_owner on project_operations
  for all using (
    exists (select 1 from projects p where p.id = project_operations.project_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from projects p where p.id = project_operations.project_id and p.user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- confirmations
-- ---------------------------------------------------------------------------
alter table confirmations enable row level security;
create policy confirmations_owner on confirmations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- assets
-- ---------------------------------------------------------------------------
alter table assets enable row level security;
create policy assets_owner on assets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- upload_sessions
-- ---------------------------------------------------------------------------
alter table upload_sessions enable row level security;
create policy upload_sessions_owner on upload_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- generation_jobs
-- ---------------------------------------------------------------------------
alter table generation_jobs enable row level security;
create policy generation_jobs_owner on generation_jobs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Worker 服务角色专用策略：读取 queued/cancel_requested 任务
-- （Worker 以 service_role 运行，绕过 RLS；如需最小权限可改为 security definer 函数）
create policy generation_jobs_worker_claim on generation_jobs
  for update using (status in ('queued','cancel_requested'));

commit;
