-- ============================================================================
-- TapFlow Phase 1 — Migration 005: Supabase 数据闭环（审计 P0 修复）
-- 修复项（后端与数据 P0 审计，2026-08-11）：
--   A. apply_project_operations 重写：真正应用操作到 canvas_nodes/canvas_edges，
--      不再只写历史 + 版本递增（此前 Supabase 模式画布操作假闭环）
--   B. generation_job_outputs 表 + Worker 生命周期 RPC（claim/complete/fail/
--      resolve_cancel/rollback_cancel）——此前 Supabase 模式无 WorkerStore，job 永远 queued
--   C. create_upload_session RPC：presign 由应用层补 user_id（此前 INSERT 缺 NOT NULL 列必失败）
--   E. complete_upload 归属修正：owner 一律 auth.uid()，不信任客户端 p_user_id
--   F. storage.objects RLS：private bucket 的上传/预览权限
-- 安全：全部 security definer + 固定 search_path + 最小授权（authenticated/service_role/tapflow_worker）
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- A. apply_project_operations — 画布快照落库（P0-A）
-- 与内存模式 applyOperationsToCanvas 语义一致（全有或全无）：
--   支持 create_node / update_node / delete_node / move_nodes / resize_nodes /
--        create_edge / delete_edge / attach_asset / replace_node_asset
--   其余操作类型（rotate/reorder/lock/group/ungroup/set_viewport/create_job）由
--   应用层 422 UNSUPPORTED_OPERATION 拒绝，不会到达此处。
-- 任何操作抛错 → 整个事务回滚（乐观锁版本递增也回滚）。
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
set search_path = public, pg_temp
as $$
declare
  v_new_version bigint;
  v_op          jsonb;
  v_op_type     text;
  v_op_id       uuid;
  v_payload     jsonb;
  v_node_id     uuid;
  v_node_type   text;
  v_parent      uuid;
  v_node_ids    uuid[];
  v_edge_id     uuid;
  v_edge_type   text;
  v_source      uuid;
  v_target      uuid;
  v_asset_id    uuid;
  v_count       int;
  v_delta_x     numeric;
  v_delta_y     numeric;
begin
  -- 0) 归属校验（与 v1 一致）：登录用户只能操作自己的项目；
  --    service_role/worker（auth.uid()=null）跳过，由应用层授权
  if auth.uid() is not null
     and not exists (select 1 from projects where id = p_project_id and user_id = auth.uid()) then
    raise exception 'FORBIDDEN: project does not belong to caller' using errcode = '42501';
  end if;

  -- 1) 乐观锁：版本匹配才递增，否则 0 行 → 抛 409 语义错误
  update projects
     set canvas_version = canvas_version + 1
   where id = p_project_id and canvas_version = p_base_version
  returning canvas_version into v_new_version;

  if v_new_version is null then
    raise exception 'CONFLICT: canvas version % does not match current', p_base_version
      using errcode = '23505';  -- unique_violation 类，服务端映射 409
  end if;

  -- 2) 应用操作到快照表（同一事务，任何异常整体回滚）
  for v_op in select * from jsonb_array_elements(p_operations) loop
    v_op_type := v_op->>'type';
    v_op_id   := (v_op->>'operationId')::uuid;
    v_payload := v_op->'payload';

    case v_op_type
      when 'create_node' then
        v_node_type := v_payload->>'nodeType';
        v_parent    := nullif(v_payload->>'parentNodeId', '')::uuid;
        -- 父节点必须已存在（同批先建父后建子：批内先执行 create_node 父，后执行子即可）
        if v_parent is not null
           and not exists (select 1 from canvas_nodes where id = v_parent and project_id = p_project_id) then
          raise exception 'INVALID_REFERENCE: parent node % does not exist', v_parent using errcode = 'P0001';
        end if;
        insert into canvas_nodes (id, project_id, node_type, parent_node_id, position, size, data)
        values (
          v_op_id, p_project_id, v_node_type, v_parent,
          case when v_payload->'position' = 'null'::jsonb or v_payload->'position' is null then null else v_payload->'position' end,
          case when v_payload->'size'     = 'null'::jsonb or v_payload->'size'     is null then null else v_payload->'size'     end,
          case when v_payload->'data'     = 'null'::jsonb or v_payload->'data'     is null then null else v_payload->'data'     end
        );

      when 'update_node' then
        v_node_id := (v_payload->>'nodeId')::uuid;
        if not exists (select 1 from canvas_nodes where id = v_node_id and project_id = p_project_id) then
          raise exception 'INVALID_REFERENCE: node % does not exist', v_node_id using errcode = 'P0001';
        end if;
        update canvas_nodes
           set data = jsonb_strip_nulls(coalesce(data, '{}'::jsonb) || v_payload->'patch'),
               updated_at = now()
         where id = v_node_id and project_id = p_project_id;

      when 'delete_node' then
        v_node_id := (v_payload->>'nodeId')::uuid;
        if not exists (select 1 from canvas_nodes where id = v_node_id and project_id = p_project_id) then
          raise exception 'INVALID_REFERENCE: node % does not exist', v_node_id using errcode = 'P0001';
        end if;
        -- 子节点解除挂载（保留数据），关联边删除，再删节点
        update canvas_nodes set parent_node_id = null
         where parent_node_id = v_node_id and project_id = p_project_id;
        delete from canvas_edges
         where project_id = p_project_id
           and (source_node_id = v_node_id or target_node_id = v_node_id);
        delete from canvas_nodes where id = v_node_id and project_id = p_project_id;

      when 'move_nodes' then
        v_node_ids := (select array_agg(x::uuid) from jsonb_array_elements_text(v_payload->'nodeIds') x);
        select count(*) into v_count
          from canvas_nodes where project_id = p_project_id and id = any(v_node_ids);
        if v_count <> cardinality(v_node_ids) then
          raise exception 'INVALID_REFERENCE: one or more nodes do not exist' using errcode = 'P0001';
        end if;
        v_delta_x := (v_payload->'delta'->>'x')::numeric;
        v_delta_y := (v_payload->'delta'->>'y')::numeric;
        update canvas_nodes
           set position = jsonb_build_object(
                 'x', coalesce((position->>'x')::numeric, 0) + v_delta_x,
                 'y', coalesce((position->>'y')::numeric, 0) + v_delta_y),
               updated_at = now()
         where project_id = p_project_id and id = any(v_node_ids) and position is not null;

      when 'resize_nodes' then
        v_node_ids := (select array_agg(x::uuid) from jsonb_array_elements_text(v_payload->'nodeIds') x);
        select count(*) into v_count
          from canvas_nodes where project_id = p_project_id and id = any(v_node_ids);
        if v_count <> cardinality(v_node_ids) then
          raise exception 'INVALID_REFERENCE: one or more nodes do not exist' using errcode = 'P0001';
        end if;
        -- 契约 Vec2Schema {x,y} → 快照 size {width,height}
        -- 注意：必须 ::numeric 转数值，->>'x' 返回 text 会被 jsonb_build_object 序列化成 JSON 字符串
        -- （快照契约 size.width/height 为 number，P0-3 修复）
        update canvas_nodes
           set size = jsonb_build_object(
                 'width',  (v_payload->'size'->>'x')::numeric,
                 'height', (v_payload->'size'->>'y')::numeric),
               updated_at = now()
         where project_id = p_project_id and id = any(v_node_ids);

      when 'create_edge' then
        v_edge_id   := v_op_id;
        v_edge_type := v_payload->>'edgeType';
        v_source    := (v_payload->'source'->>'nodeId')::uuid;
        v_target    := (v_payload->'target'->>'nodeId')::uuid;
        if not exists (select 1 from canvas_nodes where id = v_source and project_id = p_project_id)
           or not exists (select 1 from canvas_nodes where id = v_target and project_id = p_project_id) then
          raise exception 'INVALID_REFERENCE: edge endpoint node does not exist' using errcode = 'P0001';
        end if;
        insert into canvas_edges (id, project_id, source_node_id, target_node_id, edge_type)
        values (v_edge_id, p_project_id, v_source, v_target, v_edge_type);

      when 'delete_edge' then
        v_edge_id := (v_payload->>'edgeId')::uuid;
        delete from canvas_edges where id = v_edge_id and project_id = p_project_id;
        if not found then
          raise exception 'INVALID_REFERENCE: edge % does not exist', v_edge_id using errcode = 'P0001';
        end if;

      when 'attach_asset', 'replace_node_asset' then
        v_node_id  := (v_payload->>'nodeId')::uuid;
        v_asset_id := (v_payload->>'assetId')::uuid;
        if not exists (select 1 from canvas_nodes where id = v_node_id and project_id = p_project_id) then
          raise exception 'INVALID_REFERENCE: node % does not exist', v_node_id using errcode = 'P0001';
        end if;
        -- 资产必须属于该项目（不能把别家资产挂到画布）
        if not exists (select 1 from assets where id = v_asset_id and project_id = p_project_id) then
          raise exception 'INVALID_REFERENCE: asset % does not exist in project', v_asset_id using errcode = 'P0001';
        end if;
        update canvas_nodes
           set data = jsonb_strip_nulls(coalesce(data, '{}'::jsonb) || jsonb_build_object('assetId', v_asset_id)),
               updated_at = now()
         where id = v_node_id and project_id = p_project_id;

      else
        -- 应用层已按白名单 422 拒绝；此处兜底防御（安全：未知类型不得落库）
        raise exception 'UNSUPPORTED_OPERATION: % cannot be persisted', v_op_type using errcode = 'P0001';
    end case;

    -- 3) 写操作历史（同一事务）
    insert into project_operations (project_id, operation_group_id, actor, operation)
    values (p_project_id, p_group_id, p_actor, v_op);
  end loop;

  return v_new_version;
end;
$$;

revoke execute on function apply_project_operations(uuid, bigint, text, uuid, jsonb) from public;
grant execute on function apply_project_operations(uuid, bigint, text, uuid, jsonb)
  to authenticated, service_role, tapflow_worker;

-- ---------------------------------------------------------------------------
-- B. Worker 生命周期（P0-B）
-- generation_job_outputs: job 成功输出资产（complete 时写入，ordinal 唯一防重复）
-- ---------------------------------------------------------------------------
create table generation_job_outputs (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references generation_jobs(id) on delete cascade,
  asset_id   uuid not null references assets(id),
  ordinal    int  not null check (ordinal >= 0),
  created_at timestamptz not null default now(),
  constraint uq_generation_job_outputs_job_ordinal unique (job_id, ordinal),
  constraint uq_generation_job_outputs_asset unique (asset_id)
);

create index idx_generation_job_outputs_job on generation_job_outputs(job_id);

-- claim_next_generation_job — 原子领取 queued Job（queued→running）
-- 仅 worker 角色可执行（grant 控制）；skip locked 防多 worker 重复领取
create or replace function claim_next_generation_job()
returns table (job jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job generation_jobs%rowtype;
begin
  select * into v_job
    from generation_jobs
   where status = 'queued'
   order by created_at asc
   limit 1
   for update skip locked;

  if v_job.id is null then
    return;
  end if;

  update generation_jobs
     set status = 'running', updated_at = now()
   where id = v_job.id and status = 'queued'
  returning * into v_job;

  return query select row_to_json(v_job)::jsonb;
end;
$$;

-- complete_generation_job — running→succeeded + 写输出资产（同一事务）
-- p_outputs: [{url, mimeType, width, height}]；url 为转存后的存储位置
create or replace function complete_generation_job(
  p_job_id   uuid,
  p_outputs  jsonb
)
returns table (job jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job      generation_jobs%rowtype;
  v_out      jsonb;
  v_asset_id uuid;
  v_ordinal  int := 0;
  v_asset_type text;
begin
  select * into v_job from generation_jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_job.status <> 'running' then
    raise exception 'INVALID_STATE_TRANSITION: cannot complete job % in status %', p_job_id, v_job.status using errcode = 'P0001';
  end if;

  -- 资产类型按 job 类型映射（契约 AssetTypeSchema）
  v_asset_type := case
    when v_job.job_type in ('text_to_image', 'edit_image') then 'image'
    when v_job.job_type in ('image_to_video', 'text_to_video') then 'video'
    when v_job.job_type = 'tts' then 'audio'
    else 'document'
  end;

  for v_out in select * from jsonb_array_elements(coalesce(p_outputs, '[]'::jsonb)) loop
    insert into assets
      (project_id, user_id, asset_type, storage_bucket, storage_path,
       size_bytes, width, height)
    values
      (v_job.project_id, v_job.user_id, v_asset_type, 'generated',
       v_out->>'url',
       nullif(v_out->>'sizeBytes', '')::bigint,
       nullif(v_out->>'width', '')::int,
       nullif(v_out->>'height', '')::int)
    returning id into v_asset_id;

    insert into generation_job_outputs (job_id, asset_id, ordinal)
    values (p_job_id, v_asset_id, v_ordinal);
    v_ordinal := v_ordinal + 1;
  end loop;

  update generation_jobs
     set status = 'succeeded', finished_at = now(), updated_at = now()
   where id = p_job_id
  returning * into v_job;

  -- 注意：必须返回更新后的行（returning *），否则调用方拿到 running 旧行，
  -- 会把成功任务误报为仍在运行（P0-3 修复）
  return query select row_to_json(v_job)::jsonb;
end;
$$;

-- set_generation_job_provider_id — 回填 provider_job_id（running 后必填，03 契约 §7）
create or replace function set_generation_job_provider_id(
  p_job_id          uuid,
  p_provider_job_id text
)
returns table (job jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job generation_jobs%rowtype;
begin
  update generation_jobs
     set provider_job_id = p_provider_job_id, updated_at = now()
   where id = p_job_id and status = 'running'
  returning * into v_job;

  if v_job.id is null then
    select * into v_job from generation_jobs where id = p_job_id;
    if v_job.id is null then
      raise exception 'JOB_NOT_FOUND' using errcode = 'P0002';
    end if;
    raise exception 'INVALID_STATE_TRANSITION: cannot set provider id for job % in status %', p_job_id, v_job.status using errcode = 'P0001';
  end if;

  return query select row_to_json(v_job)::jsonb;
end;
$$;

-- fail_generation_job — running→failed（写入脱敏错误）
create or replace function fail_generation_job(
  p_job_id       uuid,
  p_error_code   text,
  p_error_message text
)
returns table (job jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job generation_jobs%rowtype;
begin
  update generation_jobs
     set status = 'failed', error_code = p_error_code,
         error_message = p_error_message, finished_at = now(), updated_at = now()
   where id = p_job_id and status = 'running'
  returning * into v_job;

  if v_job.id is null then
    -- 不存在或非 running：区分 404 与 409
    select * into v_job from generation_jobs where id = p_job_id;
    if v_job.id is null then
      raise exception 'JOB_NOT_FOUND' using errcode = 'P0002';
    end if;
    raise exception 'INVALID_STATE_TRANSITION: cannot fail job % in status %', p_job_id, v_job.status using errcode = 'P0001';
  end if;

  return query select row_to_json(v_job)::jsonb;
end;
$$;

-- resolve_cancel_generation_job — cancel_requested→cancelled（取消确认成功/超时判定）
create or replace function resolve_cancel_generation_job(p_job_id uuid)
returns table (job jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job generation_jobs%rowtype;
begin
  update generation_jobs
     set status = 'cancelled', error_code = 'CANCELLED',
         error_message = 'cancelled by user', finished_at = now(), updated_at = now()
   where id = p_job_id and status = 'cancel_requested'
  returning * into v_job;

  if v_job.id is null then
    select * into v_job from generation_jobs where id = p_job_id;
    if v_job.id is null then
      raise exception 'JOB_NOT_FOUND' using errcode = 'P0002';
    end if;
    raise exception 'INVALID_STATE_TRANSITION: cannot resolve cancel for job % in status %', p_job_id, v_job.status using errcode = 'P0001';
  end if;

  return query select row_to_json(v_job)::jsonb;
end;
$$;

-- rollback_cancel_generation_job — cancel_requested→running（取消失败恢复执行）
create or replace function rollback_cancel_generation_job(p_job_id uuid)
returns table (job jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job generation_jobs%rowtype;
begin
  update generation_jobs
     set status = 'running', cancel_requested_at = null, updated_at = now()
   where id = p_job_id and status = 'cancel_requested'
  returning * into v_job;

  if v_job.id is null then
    select * into v_job from generation_jobs where id = p_job_id;
    if v_job.id is null then
      raise exception 'JOB_NOT_FOUND' using errcode = 'P0002';
    end if;
    raise exception 'INVALID_STATE_TRANSITION: cannot rollback cancel for job % in status %', p_job_id, v_job.status using errcode = 'P0001';
  end if;

  return query select row_to_json(v_job)::jsonb;
end;
$$;

-- Worker RPC 最小授权：仅 tapflow_worker / service_role（普通用户不得领取/完成/失败任务）
revoke execute on function claim_next_generation_job() from public;
grant execute on function claim_next_generation_job() to service_role, tapflow_worker;
revoke execute on function complete_generation_job(uuid, jsonb) from public;
grant execute on function complete_generation_job(uuid, jsonb) to service_role, tapflow_worker;
revoke execute on function fail_generation_job(uuid, text, text) from public;
grant execute on function fail_generation_job(uuid, text, text) to service_role, tapflow_worker;
revoke execute on function resolve_cancel_generation_job(uuid) from public;
grant execute on function resolve_cancel_generation_job(uuid) to service_role, tapflow_worker;
revoke execute on function rollback_cancel_generation_job(uuid) from public;
grant execute on function rollback_cancel_generation_job(uuid) to service_role, tapflow_worker;
revoke execute on function set_generation_job_provider_id(uuid, text) from public;
grant execute on function set_generation_job_provider_id(uuid, text) to service_role, tapflow_worker;

-- ---------------------------------------------------------------------------
-- C. create_upload_session — presign 由服务端补 user_id（P0-C）
-- 此前应用层 INSERT upload_sessions 缺 user_id（NOT NULL + RLS with check）必失败；
-- 改为 security definer RPC 内部写 auth.uid()，客户端不可伪造归属。
-- 返回 session 行（供应用层构造上传 URL）
-- ---------------------------------------------------------------------------
create or replace function create_upload_session(
  p_project_id       uuid,
  p_asset_type       text,
  p_declared_mime_type text,
  p_declared_size_bytes bigint,
  p_declared_width   int,
  p_declared_height  int,
  p_storage_bucket   text,
  p_storage_path     text,
  p_expires_at       timestamptz
)
returns table (id uuid, project_id uuid, user_id uuid, storage_bucket text, storage_path text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'UNAUTHORIZED: caller must be authenticated' using errcode = '42501';
  end if;

  -- 项目归属校验：只能为本人项目创建上传会话
  if not exists (select 1 from projects where id = p_project_id and user_id = auth.uid()) then
    raise exception 'FORBIDDEN: project does not belong to caller' using errcode = '42501';
  end if;

  return query
    insert into upload_sessions
      (project_id, user_id, asset_type, declared_mime_type, declared_size_bytes,
       declared_width, declared_height, storage_bucket, storage_path, status, expires_at)
    values
      (p_project_id, auth.uid(), p_asset_type, p_declared_mime_type, p_declared_size_bytes,
       p_declared_width, p_declared_height, p_storage_bucket, p_storage_path, 'pending', p_expires_at)
    returning upload_sessions.id, upload_sessions.project_id, upload_sessions.user_id,
              upload_sessions.storage_bucket, upload_sessions.storage_path, upload_sessions.expires_at;
end;
$$;

revoke execute on function create_upload_session(uuid, text, text, bigint, int, int, text, text, timestamptz) from public;
grant execute on function create_upload_session(uuid, text, text, bigint, int, int, text, text, timestamptz)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- E. complete_upload 归属修正（P0-E）
-- 移除对客户端 p_user_id 的信任：owner 一律用 auth.uid()（或 service_role 下
-- 由调用方显式指定 service 用户），p_user_id 参数改为 p_owner_id 且仅
-- service_role/tapflow_worker 可传入非空值。
-- ---------------------------------------------------------------------------
create or replace function complete_upload(
  p_upload_id   uuid,
  p_project_id  uuid,
  p_owner_id    uuid,
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
set search_path = public, pg_temp
as $$
declare
  v_new_asset_id uuid := gen_random_uuid();
  v_row upload_sessions%rowtype;
  v_owner uuid;
begin
  -- 归属：authenticated 一律 auth.uid()；service/worker 用显式 owner（应用层授权）
  if auth.uid() is not null then
    v_owner := auth.uid();
  else
    v_owner := p_owner_id;
  end if;

  if v_owner is null then
    raise exception 'UNAUTHORIZED: caller must be authenticated' using errcode = '42501';
  end if;

  -- 1) 原子抢占 pending → completed（必须匹配 session 的 project/user）
  update upload_sessions
     set status = 'completed', completed_at = now()
   where id = p_upload_id
     and project_id = p_project_id
     and user_id = v_owner
     and status = 'pending'
     and storage_bucket = p_storage_bucket
     and storage_path = p_storage_path
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from upload_sessions
     where id = p_upload_id and project_id = p_project_id and user_id = v_owner;

    if v_row.id is null then
      raise exception 'UPLOAD_SESSION_NOT_FOUND' using errcode = 'P0001';
    elsif v_row.status = 'completed' and v_row.asset_id is not null then
      return query select v_row.asset_id, true;
      return;
    elsif v_row.status = 'expired' then
      raise exception 'UPLOAD_EXPIRED' using errcode = 'P0001';
    else
      raise exception 'UPLOAD_INCOMPLETE' using errcode = 'P0001';
    end if;
  end if;

  -- 2) INSERT assets（owner = v_owner）
  insert into assets
    (id, project_id, user_id, asset_type, storage_bucket, storage_path,
     content_hash, size_bytes, width, height)
  values
    (v_new_asset_id, p_project_id, v_owner, p_asset_type, p_storage_bucket, p_storage_path,
     p_content_hash, p_size_bytes, p_width, p_height);

  -- 3) 回填 asset_id
  update upload_sessions set asset_id = v_new_asset_id
   where upload_sessions.id = p_upload_id and upload_sessions.status = 'completed' and upload_sessions.asset_id is null;

  return query select v_new_asset_id, false;
end;
$$;

revoke execute on function complete_upload(uuid, uuid, uuid, text, text, text, text, bigint, int, int) from public;
grant execute on function complete_upload(uuid, uuid, uuid, text, text, text, text, bigint, int, int)
  to authenticated, service_role, tapflow_worker;

-- ---------------------------------------------------------------------------
-- F. storage.objects RLS（P0-F）
-- private bucket（uploads/generated/thumbs）默认 deny；这里给：
--   - authenticated：SELECT 本人项目资产（经 upload_sessions/assets 归属）
--   - authenticated：INSERT/UPDATE uploads 桶（presign 上传路径）
--   - service_role：全部（storage 默认 service_role 绕过 RLS？不，storage.objects 需要显式策略；
--     service_role 在 Supabase 默认拥有 storage 权限，但显式策略更稳妥）
-- 归属判定通过 storage.objects.metadata->>'uploadId' 关联 upload_sessions，
-- 或 path 前缀 {uploadId}/ 匹配 upload_sessions.id。
-- ---------------------------------------------------------------------------
alter table storage.objects enable row level security;

-- 读：项目内已 complete 的资产（uploads/generated/thumbs）可被 owner 读取
create policy storage_objects_read_owner on storage.objects
  for select to authenticated
  using (
    bucket_id in ('uploads', 'generated', 'thumbs')
    and exists (
      select 1 from assets a
       where a.user_id = auth.uid()
         and a.storage_bucket = storage.objects.bucket_id
         and a.storage_path = storage.objects.name
    )
  );

-- 写：uploads 桶内，已创建 pending 会话的 path 允许本人写入
create policy storage_objects_insert_owner on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'uploads'
    and exists (
      select 1 from upload_sessions s
       where s.user_id = auth.uid()
         and s.status = 'pending'
         and s.storage_bucket = 'uploads'
         and s.storage_path = storage.objects.name
    )
  );

create policy storage_objects_update_owner on storage.objects
  for update to authenticated
  using (
    bucket_id = 'uploads'
    and exists (
      select 1 from upload_sessions s
       where s.user_id = auth.uid()
         and s.status = 'pending'
         and s.storage_bucket = 'uploads'
         and s.storage_path = storage.objects.name
    )
  )
  with check (
    bucket_id = 'uploads'
    and exists (
      select 1 from upload_sessions s
       where s.user_id = auth.uid()
         and s.status = 'pending'
         and s.storage_bucket = 'uploads'
         and s.storage_path = storage.objects.name
    )
  );

commit;
