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

-- auth.uid() stub：读取 JWT subject（与 Supabase 行为一致）
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- storage.buckets stub（列与 migration 001 insert 清单一致）
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
