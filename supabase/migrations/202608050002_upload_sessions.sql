-- ============================================================================
-- TapFlow Phase 1 — Migration 002: Upload Sessions & 并发控制
-- 契约基准: 02-签名URL规范.md v1.3 (zod v1.4 对齐) + packages/contracts v1.4
-- 终审阻塞项 #5 正式落地：complete 并发 + storage_path 路径语义 + 孤儿清理
-- ============================================================================

begin;

create type upload_session_status as enum ('pending', 'completed', 'expired');

create table upload_sessions (
  id                  uuid primary key default gen_random_uuid(),  -- = uploadId
  project_id          uuid not null references projects(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  asset_type          text not null check (asset_type in ('image','video','audio','thumbnail','document')),
  declared_mime_type  text not null,
  declared_size_bytes bigint not null check (declared_size_bytes > 0),
  declared_width      int check (declared_width is null or declared_width > 0),
  declared_height     int check (declared_height is null or declared_height > 0),
  storage_bucket      text not null default 'uploads' check (storage_bucket in ('uploads','generated','thumbs')),
  storage_path        text not null,             -- {uploadId}/{sanitized-filename}，服务端生成
  status              upload_session_status not null default 'pending',
  expires_at          timestamptz not null,      -- presign 时 = now() + 15min
  completed_at        timestamptz,
  asset_id            uuid references assets(id),  -- completed 后回填
  created_at          timestamptz not null default now(),
  constraint uq_upload_sessions_user_path unique (user_id, storage_path),
  constraint ck_upload_sessions_path_not_bucket check (storage_path !~ '^uploads/' )  -- 杜绝 uploads/uploads/
);

create index idx_upload_sessions_expiry on upload_sessions(status, expires_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- 未决项 #2 落地：complete 并发存储函数（方式 A：条件状态更新）
-- 同一 uploadId 只创建一个 Asset；并发/重复 complete 幂等返回同一 asset_id。
-- 语义：
--   - 抢占成功 → 返回 (asset_id, already_completed=false)
--   - 已被并发/重复完成 → 返回已有 (asset_id, already_completed=true)
--   - 会话不存在/非 pending → 抛 422 语义（UPLOAD_INCOMPLETE / UPLOAD_EXPIRED）
-- ---------------------------------------------------------------------------
create or replace function complete_upload(
  p_upload_id   uuid,
  p_project_id  uuid,
  p_user_id     uuid,
  p_asset_type  text,
  p_storage_bucket text,
  p_storage_path   text,
  p_content_hash   text,
  p_size_bytes     bigint,
  p_width          int,
  p_height         int
) returns table (asset_id uuid, already_completed boolean)
language plpgsql
security definer
set search_path = public, pg_temp  -- 终审返修 #2：固定 search_path
as $$
declare
  v_new_asset_id uuid := gen_random_uuid();  -- 预生成，先 insert 后 update 同一事务
  v_row upload_sessions%rowtype;
begin
  -- 0) 归属校验（终审返修 #3）：登录用户只能 complete 本人的会话；
  --    service_role/worker（auth.uid()=null）跳过，由应用层授权
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN: caller does not match session owner' using errcode = '42501';
  end if;

  -- 1) 原子抢占 pending → completed（影响行数 = 1 者胜出；暂不填 asset_id，避免外键悬空）
  update upload_sessions
     set status = 'completed', completed_at = now()
   where id = p_upload_id
     and project_id = p_project_id
     and user_id = p_user_id
     and status = 'pending'
     and storage_bucket = p_storage_bucket
     and storage_path = p_storage_path
  returning * into v_row;

  if v_row.id is null then
    -- 抢占失败：查当前状态，幂等返回 or 报错
    select * into v_row from upload_sessions
     where id = p_upload_id and project_id = p_project_id and user_id = p_user_id;

    if v_row.id is null then
      raise exception 'UPLOAD_SESSION_NOT_FOUND' using errcode = 'P0001';
    elsif v_row.status = 'completed' and v_row.asset_id is not null then
      -- 重复 complete：幂等返回首次 asset_id
      return query select v_row.asset_id, true;
      return;
    elsif v_row.status = 'expired' then
      raise exception 'UPLOAD_EXPIRED' using errcode = 'P0001';
    else
      raise exception 'UPLOAD_INCOMPLETE' using errcode = 'P0001';
    end if;
  end if;

  -- 2) 抢占成功者：INSERT assets（同一事务；失败则整体回滚含 status 更新）
  insert into assets
    (id, project_id, user_id, asset_type, storage_bucket, storage_path,
     content_hash, size_bytes, width, height)
  values
    (v_new_asset_id, p_project_id, p_user_id, p_asset_type, p_storage_bucket, p_storage_path,
     p_content_hash, p_size_bytes, p_width, p_height);

  -- 3) 回填 asset_id
  update upload_sessions set asset_id = v_new_asset_id
   where upload_sessions.id = p_upload_id and upload_sessions.status = 'completed' and upload_sessions.asset_id is null;

  return query select v_new_asset_id, false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 孤儿清理 cron（每小时，pg_cron 或外部调度调用）
-- 1) 标 expired（条件更新，与 complete 并发时只有一个胜者）
-- 2) 返回应删除的 storage bucket/path 列表（外部存储清理用）
-- ---------------------------------------------------------------------------
create or replace function expire_stale_upload_sessions()
returns table (bucket text, path text)
language plpgsql
security definer
set search_path = public, pg_temp  -- 终审返修 #2：固定 search_path
as $$
begin
  update upload_sessions set status = 'expired'
   where status = 'pending' and expires_at < now();

  return query
    select s.storage_bucket::text, s.storage_path
      from upload_sessions s
      left join assets a on a.id = s.asset_id
     where s.status = 'expired'
       and s.completed_at is null
       and a.id is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 终审返修 #3：执行权限边界
--   - complete_upload: 面向登录用户（authenticated）+ 应用后端（service_role）+ worker
--   - expire_stale_upload_sessions: 仅 cron/worker（service_role / tapflow_worker）
-- ---------------------------------------------------------------------------
revoke execute on function complete_upload(uuid, uuid, uuid, text, text, text, text, bigint, int, int) from public;
grant execute on function complete_upload(uuid, uuid, uuid, text, text, text, text, bigint, int, int)
  to authenticated, service_role, tapflow_worker;

revoke execute on function expire_stale_upload_sessions() from public;
grant execute on function expire_stale_upload_sessions()
  to service_role, tapflow_worker;

commit;
