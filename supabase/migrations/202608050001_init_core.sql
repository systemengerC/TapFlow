-- ============================================================================
-- TapFlow Phase 1 — Migration 001: Core Tables
-- 契约基准: packages/contracts v1.4 (Design Frozen → Implementation Frozen)
--   - 01-AgentCommand-CanvasOperation-API契约.md (v1.3, zod v1.4 对齐)
--   - 02-签名URL规范.md (v1.3)
--   - 03-Job状态转换与错误码.md (v1.3)
-- 目标库: Supabase (PostgreSQL 15+)
-- 状态: 正式 (Implementation Frozen) · 与 packages/contracts v1.4 一一对应
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- extensions
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;  -- gen_random_uuid()
create extension if not exists moddatetime; -- updated_at 触发器（未决项 #4 落地）

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create table projects (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null,
  canvas_version bigint not null default 0,  -- 乐观锁基准版本（applyOperations）
  created_at     timestamptz not null default now()
);

create index idx_projects_user on projects(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- canvas_nodes
-- 契约: CanvasOperation.create_node / update_node / delete_node / duplicate
-- data 为 JsonSchema（≤100KB UTF-8 / 深度≤10，契约 REJ-23~32 强制）
-- ---------------------------------------------------------------------------
create table canvas_nodes (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  node_type      text not null check (node_type in
                    ('text','image','video','audio','generation_job','group','document')),
  parent_node_id uuid references canvas_nodes(id) on delete set null,
  position       jsonb,      -- Vec2Schema {x,y}
  size           jsonb,      -- Vec2Schema {width,height}
  data           jsonb,      -- JsonSchema
  job_id         uuid,       -- node_type='generation_job' 时关联 generation_jobs.id
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint uq_canvas_nodes_project_id unique (project_id, id),
  constraint ck_canvas_nodes_position check (position is null or jsonb_typeof(position) = 'object'),
  constraint ck_canvas_nodes_data check (data is null or jsonb_typeof(data) = 'object')
);

create index idx_canvas_nodes_project on canvas_nodes(project_id, created_at);
create index idx_canvas_nodes_parent on canvas_nodes(parent_node_id);

-- ---------------------------------------------------------------------------
-- canvas_edges
-- 契约: create_edge / delete_edge，edge_type ∈ reference|input|derived_from
-- ---------------------------------------------------------------------------
create table canvas_edges (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  source_node_id uuid not null references canvas_nodes(id) on delete cascade,
  target_node_id uuid not null references canvas_nodes(id) on delete cascade,
  edge_type      text not null check (edge_type in ('reference','input','derived_from')),
  created_at     timestamptz not null default now(),
  constraint uq_canvas_edges_source_target unique (project_id, source_node_id, target_node_id, edge_type)
);

create index idx_canvas_edges_project on canvas_edges(project_id);
create index idx_canvas_edges_source on canvas_edges(source_node_id);
create index idx_canvas_edges_target on canvas_edges(target_node_id);

-- ---------------------------------------------------------------------------
-- project_operations
-- 契约: applyOperations 历史（撤销用 inverse_payload，不直接删历史）
-- actor 服务端推导，客户端不可传
-- ---------------------------------------------------------------------------
create table project_operations (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references projects(id) on delete cascade,
  operation_group_id uuid,   -- 批量原子撤销组（= AgentCommand 的 groupId）
  actor              text not null check (actor in ('user','agent')),
  operation          jsonb not null,  -- CanvasOperation（含 operationId）
  inverse_payload    jsonb,           -- 逆操作
  applied_at         timestamptz not null default now()
);

create index idx_project_operations_project on project_operations(project_id, applied_at desc);
create index idx_project_operations_group on project_operations(operation_group_id);

-- ---------------------------------------------------------------------------
-- confirmations
-- 契约: 202 预览确认单（AgentCommand 契约 §5）
-- status: pending → accepted|rejected|expired
-- ---------------------------------------------------------------------------
create table confirmations (
  id            uuid primary key default gen_random_uuid(),  -- = confirmationId
  project_id    uuid not null references projects(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  summary       text not null,
  cost_estimate jsonb not null,       -- {min,max,currency}
  operations    jsonb not null,       -- CanvasOperation[]（未落库，确认后按此执行）
  status        text not null default 'pending' check (status in ('pending','accepted','rejected','expired')),
  expires_at    timestamptz not null, -- 默认 now()+5min
  created_at    timestamptz not null default now(),
  constraint uq_confirmations_idempotency unique (id, status)
);

create index idx_confirmations_expiry on confirmations(status, expires_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- assets
-- 契约: 02-签名URL规范.md。签名 URL 不落库；storage_path 为桶内相对路径。
-- ---------------------------------------------------------------------------
create table assets (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  asset_type    text not null check (asset_type in ('image','video','audio','thumbnail','document')),
  storage_bucket text not null check (storage_bucket in ('uploads','generated','thumbs')),
  storage_path  text not null,       -- 桶内相对路径（不含 bucket 名）
  content_hash  text,                -- 'sha256:<64 hex>'（02 契约 §4）
  size_bytes    bigint,
  width         int,
  height        int,
  created_at    timestamptz not null default now(),
  constraint uq_assets_bucket_path unique (storage_bucket, storage_path),
  constraint ck_assets_path_not_bucket check (storage_path !~ '^uploads/' ),  -- 杜绝 uploads/uploads/
  constraint ck_assets_content_hash check (content_hash is null or content_hash ~ '^sha256:[0-9a-f]{64}$')
);

create index idx_assets_project on assets(project_id, created_at desc);
create index idx_assets_user on assets(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- generation_jobs — Job 状态机（03 契约）
-- status 转换均为条件更新；取消分三步（running→cancel_requested→cancelled/回退 running）
-- ---------------------------------------------------------------------------
create type generation_job_status as enum
  ('queued','running','cancel_requested','succeeded','failed','cancelled');

create table generation_jobs (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references projects(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  parent_job_id       uuid references generation_jobs(id),  -- 用户重试链
  attempt             int not null default 1 check (attempt >= 1),
  job_type            text not null check (job_type in
                        ('text_to_image','image_to_video','text_to_video','tts','edit_image')),
  provider            text,           -- provider 标识
  model               text not null,
  params              jsonb not null, -- 脱敏后的生成参数
  raw_provider_params jsonb,          -- 审计用，写入前脱敏（禁存 API Key/Bearer/签名 URL）
  input_node_ids      uuid[] not null default '{}',
  status              generation_job_status not null default 'queued',
  provider_job_id     text,           -- running 后必填
  error_code          text,           -- 03 契约 §6 错误码
  error_message       text,
  provider_error      text,           -- 脱敏
  idempotency_key     uuid not null unique,
  cancel_requested_at timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index idx_generation_jobs_claim on generation_jobs(status, created_at) where status = 'queued';
create index idx_generation_jobs_cancel on generation_jobs(status, cancel_requested_at) where status = 'cancel_requested';
create index idx_generation_jobs_project on generation_jobs(project_id, created_at desc);
create index idx_generation_jobs_parent on generation_jobs(parent_job_id);

-- updated_at 触发器（未决项 #4 落地）
create trigger trg_generation_jobs_updated_at before update on generation_jobs
  for each row execute function moddatetime(updated_at);
create trigger trg_canvas_nodes_updated_at before update on canvas_nodes
  for each row execute function moddatetime(updated_at);

-- ---------------------------------------------------------------------------
-- 未决项 #1 落地：applyOperations 乐观锁存储函数
-- 事务内原子递增 canvas_version + 写操作历史，WHERE canvas_version=$baseVersion 表达乐观锁
-- 影响行数 = 0 → 409 CONFLICT（客户端重取基线重放）
-- ---------------------------------------------------------------------------
create or replace function apply_project_operations(
  p_project_id   uuid,
  p_base_version bigint,
  p_actor        text,
  p_group_id     uuid,
  p_operations   jsonb
) returns bigint  -- 返回新 canvas_version
language plpgsql
security definer
as $$
declare
  v_new_version bigint;
  v_op jsonb;
begin
  -- 1) 乐观锁：版本匹配才递增，否则 0 行 → 抛 409 语义错误
  update projects
     set canvas_version = canvas_version + 1
   where id = p_project_id and canvas_version = p_base_version
  returning canvas_version into v_new_version;

  if v_new_version is null then
    raise exception 'CONFLICT: canvas version % does not match current', p_base_version
      using errcode = '23505';  -- unique_violation 类，服务端映射 409
  end if;

  -- 2) 写操作历史（同一事务）
  for v_op in select * from jsonb_array_elements(p_operations) loop
    insert into project_operations (project_id, operation_group_id, actor, operation)
    values (p_project_id, p_group_id, p_actor, v_op);
  end loop;

  return v_new_version;
end;
$$;

-- ---------------------------------------------------------------------------
-- 未决项 #3 落地：存储桶（Service Role 执行；RLS 见 migration 003）
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('uploads',   'uploads',   false, 1073741824, null),  -- 1GB，用户上传
  ('generated', 'generated', false, 1073741824, null),  -- 1GB，生成产物
  ('thumbs',    'thumbs',    false, 10485760,   null)   -- 10MB，缩略图
on conflict (id) do nothing;

commit;
