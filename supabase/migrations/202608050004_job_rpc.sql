-- ============================================================================
-- TapFlow Phase 1 — Migration 004: 项目创建 + Generation Job RPC
-- 契约基准: packages/contracts v1.4 (Job API) + 03-Job状态转换与错误码.md v1.3
-- 补充:
--   - create_project            (修复: supabaseProjectRepository 已调用但原 migration 缺失)
--   - create_generation_job     (幂等键 idempotency_key unique 防重复提交)
--   - cancel_generation_job     (03 契约 §4.1 三步流程: queued→cancelled / running→cancel_requested)
-- 安全: security definer + 固定 search_path + auth.uid() 归属校验
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- create_project — 创建项目（返回行）
-- 调用方: POST /api/projects（Supabase 模式）
-- ---------------------------------------------------------------------------
create or replace function create_project(p_name text)
returns table (id uuid, user_id uuid, name text, canvas_version bigint, created_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'UNAUTHORIZED: caller must be authenticated' using errcode = '42501';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'INVALID_NAME: project name must not be empty' using errcode = '22023';
  end if;

  return query
    insert into projects (user_id, name)
    values (auth.uid(), trim(p_name))
    returning projects.id, projects.user_id, projects.name, projects.canvas_version, projects.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_generation_job — 创建生成任务（幂等）
-- 幂等: idempotency_key unique 命中 → 返回已有 job + is_replay=true
-- 归属: 仅项目 owner 可创建（projects.user_id = auth.uid()）
-- 调用方: POST /api/jobs（Supabase 模式）
-- ---------------------------------------------------------------------------
create or replace function create_generation_job(
  p_project_id       uuid,
  p_job_type         text,
  p_model            text,
  p_params           jsonb,
  p_input_node_ids   uuid[] default '{}',
  p_idempotency_key  uuid default gen_random_uuid()
)
returns table (job jsonb, is_replay boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id  uuid;
  v_existing generation_jobs%rowtype;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHORIZED: caller must be authenticated' using errcode = '42501';
  end if;

  -- 归属校验：项目必须属于当前用户
  select user_id into v_user_id from projects where id = p_project_id;
  if v_user_id is null then
    raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_user_id <> auth.uid() then
    raise exception 'FORBIDDEN: caller does not own the project' using errcode = '42501';
  end if;

  -- 幂等键命中 → 返回已有 Job
  select * into v_existing from generation_jobs where idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    return query select row_to_json(v_existing)::jsonb, true;
    return;
  end if;

  return query
    with inserted as (
      insert into generation_jobs (project_id, user_id, job_type, model, params, input_node_ids, idempotency_key)
      values (p_project_id, auth.uid(), p_job_type, p_model, coalesce(p_params, '{}'::jsonb), p_input_node_ids, p_idempotency_key)
      returning generation_jobs.*
    )
    select row_to_json(inserted.*)::jsonb, false from inserted;
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_generation_job — 取消任务（03 契约 §4.1）
--   queued    → cancelled（终态，无需外部副作用）
--   running   → cancel_requested（步骤 1 拿锁；外部副作用由 Worker 执行）
--   其余状态  → 返回当前状态，应用层映射 409 INVALID_STATE_TRANSITION
-- 归属: 仅任务 owner 可取消
-- 调用方: POST /api/jobs/:jobId/cancel（Supabase 模式）
-- ---------------------------------------------------------------------------
create or replace function cancel_generation_job(p_job_id uuid)
returns table (job jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job    generation_jobs%rowtype;
  v_now    timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'UNAUTHORIZED: caller must be authenticated' using errcode = '42501';
  end if;

  select * into v_job from generation_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'JOB_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_job.user_id <> auth.uid() then
    raise exception 'FORBIDDEN: caller does not own the job' using errcode = '42501';
  end if;

  -- queued → cancelled（无需外部副作用）
  if v_job.status = 'queued' then
    update generation_jobs
       set status = 'cancelled', finished_at = v_now, updated_at = v_now
     where id = p_job_id and status = 'queued'
     returning * into v_job;
    return query select row_to_json(v_job)::jsonb;
    return;
  end if;

  -- running → cancel_requested（步骤 1 拿锁）
  if v_job.status = 'running' then
    update generation_jobs
       set status = 'cancel_requested', cancel_requested_at = v_now, updated_at = v_now
     where id = p_job_id and status = 'running'
     returning * into v_job;
    return query select row_to_json(v_job)::jsonb;
    return;
  end if;

  -- 其余状态（succeeded/failed/cancelled/cancel_requested）→ 返回当前状态，应用层映射 409
  return query select row_to_json(v_job)::jsonb;
end;
$$;

commit;
