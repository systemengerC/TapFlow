-- ============================================================================
-- TapFlow Phase 1 — 本地验证环境 stub（仅测试用，可重复执行）
-- 运行顺序: setup_test_env.sql → 001 → 002 → 003 → run_concurrency_tests.sql
-- Supabase 生产环境: 无需本文件（auth/storage/角色由平台提供）
-- 终审返修 #4: 角色 stub 提前创建，保证 migration 内 grant 不失败
-- ============================================================================

create schema if not exists auth;
create schema if not exists storage;

-- authenticated / service_role 由 Supabase 内置；本地验证环境手动补齐
do $$
begin
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end
$$;

-- auth.users stub（Supabase 由 GoTrue 管理）
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- schema 权限（Supabase 生产默认：authenticated 对 public/storage 有 USAGE；
-- 本地 stub 需显式补齐，否则 set role authenticated 后函数解析/对象访问失败）
grant usage on schema public to authenticated, service_role, tapflow_worker;
grant usage on schema storage to authenticated, service_role, tapflow_worker;

-- auth.uid() stub：读取 JWT subject（与 Supabase 行为一致：security definer，
-- 普通角色无需 auth schema USAGE 即可调用）
create or replace function auth.uid() returns uuid language sql stable security definer set search_path = public as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- 业务表级权限（Supabase 生产默认对 authenticated 授予全表权限，行级过滤交给 RLS
-- 策略；本地 stub 补齐，否则 security definer 之外的普通语句被表级权限拒绝）
grant select, insert, update, delete on all tables in schema public to authenticated, service_role, tapflow_worker;

-- storage.buckets stub（列与 migration 001 insert 清单一致）
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

-- storage.objects stub（migration 005 启用 RLS 并建策略需要；
-- 列与 Supabase 生产 storage.objects 对齐，策略只引用 bucket_id/name）
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner uuid,
  owner_id text,
  metadata jsonb,
  version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_accessed_at timestamptz,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  constraint uq_storage_objects_bucket_name unique (bucket_id, name)
);

-- 表级权限（Supabase 生产由 storage 服务授予；RLS 策略负责行级过滤，
-- 无表级 GRANT 时 authenticated 连 INSERT/SELECT 都会被拒）
grant select, insert, update, delete on storage.objects to authenticated, service_role, tapflow_worker;
grant select on storage.buckets to authenticated, service_role, tapflow_worker;
