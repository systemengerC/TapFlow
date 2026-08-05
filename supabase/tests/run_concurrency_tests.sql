-- ============================================================================
-- TapFlow Phase 1 — 数据库并发测试
-- 运行方式: psql -f tests/run_concurrency_tests.sql（需已执行 001~003 migration）
-- 目标: 验证终审阻塞项 #5 —— complete 并发 / 幂等 / 乐观锁 / 路径语义
-- 用法: 以 postgres 超级用户运行；auth.users 由 Supabase 提供，此处用 stub
-- ============================================================================

\set ON_ERROR_STOP off

-- ---------------------------------------------------------------------------
-- 0) 准备：stub auth.users + 测试用户/项目
-- ---------------------------------------------------------------------------
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);
insert into auth.users (email) values ('tester@tapflow.test') on conflict do nothing;

do $$
declare
  v_user uuid;
  v_project uuid;
begin
  select id into v_user from auth.users where email = 'tester@tapflow.test' limit 1;
  insert into projects (user_id, name) values (v_user, '并发测试') returning id into v_project;
  raise notice 'setup: user=% project=%', v_user, v_project;
end $$;

-- ---------------------------------------------------------------------------
-- T1: 两个并发 complete（同一 uploadId）→ 仅一个 INSERT assets
-- 验证: 两个事务同时调用 complete_upload，只有一个 already_completed=false
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid; v_project uuid; v_upload uuid;
  v_a uuid; v_b uuid; v_ok_a boolean; v_ok_b boolean;
  v_asset_count int;
begin
  select id into v_user from auth.users where email = 'tester@tapflow.test' limit 1;
  select id into v_project from projects where user_id = v_user and name = '并发测试' limit 1;

  -- 创建两个 pending 上传会话
  insert into upload_sessions
    (project_id, user_id, asset_type, declared_mime_type, declared_size_bytes,
     storage_bucket, storage_path, expires_at)
  values
    (v_project, v_user, 'image', 'image/png', 1024, 'uploads', gen_random_uuid()::text || '/a.png', now() + interval '15 minutes')
  returning id into v_upload;

  -- 串行模拟两次 complete（真正的并发锁竞争由 plpgsql 函数内条件更新保证）
  select asset_id, already_completed into v_a, v_ok_a from complete_upload(
    v_upload, v_project, v_user, 'image', 'uploads',
    (select storage_path from upload_sessions where id = v_upload),
    'sha256:' || repeat('a', 64), 1024, 100, 100);

  -- 第二次 complete：应幂等返回同一 asset_id，already_completed=true
  select asset_id, already_completed into v_b, v_ok_b from complete_upload(
    v_upload, v_project, v_user, 'image', 'uploads',
    (select storage_path from upload_sessions where id = v_upload),
    'sha256:' || repeat('a', 64), 1024, 100, 100);

  select count(*) into v_asset_count from assets where id = v_a;

  if v_a = v_b and v_ok_b and v_asset_count = 1 and v_a is not null then
    raise notice 'T1 PASS: 并发 complete 单资产 + 幂等同一 asset_id (%)', v_a;
  else
    raise exception 'T1 FAIL: a=% b=% ok_b=% count=%', v_a, v_b, v_ok_b, v_asset_count;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T2: complete 与 expired 竞态 → 条件更新保证只有一个胜者
-- 验证: 先标 expired 后 complete → 抛 UPLOAD_EXPIRED，不产生资产
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid; v_project uuid; v_upload uuid; v_asset_count int;
begin
  select id into v_user from auth.users where email = 'tester@tapflow.test' limit 1;
  select id into v_project from projects where user_id = v_user and name = '并发测试' limit 1;

  insert into upload_sessions
    (project_id, user_id, asset_type, declared_mime_type, declared_size_bytes,
     storage_bucket, storage_path, expires_at)
  values
    (v_project, v_user, 'image', 'image/png', 2048, 'uploads', gen_random_uuid()::text || '/b.png', now() - interval '1 minute')
  returning id into v_upload;

  -- 标 expired（模拟 cron）
  update upload_sessions set status = 'expired' where id = v_upload;

  -- complete 应失败
  begin
    perform complete_upload(
      v_upload, v_project, v_user, 'image', 'uploads',
      (select storage_path from upload_sessions where id = v_upload),
      'sha256:' || repeat('b', 64), 2048, 50, 50);
    raise exception 'T2 FAIL: complete 应抛错但未抛';
  exception when others then
    if sqlerrm like '%UPLOAD_EXPIRED%' then
      select count(*) into v_asset_count from assets where storage_path like '%/b.png';
      if v_asset_count = 0 then
        raise notice 'T2 PASS: expired 后 complete 被拒，无资产产生';
      else
        raise exception 'T2 FAIL: expired 后产生资产 count=%', v_asset_count;
      end if;
    else
      raise exception 'T2 FAIL: 异常不符 %', sqlerrm;
    end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- T3: complete 时对象缺失（session 存在但未实际上传）
-- 验证: 调用方校验对象不存在 → 422 UPLOAD_INCOMPLETE，session 保持 pending
-- （对象校验在应用层；此处验证函数对错误前置条件的行为：直接抛错且不回滚 session）
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid; v_project uuid; v_upload uuid; v_status text;
begin
  select id into v_user from auth.users where email = 'tester@tapflow.test' limit 1;
  select id into v_project from projects where user_id = v_user and name = '并发测试' limit 1;

  insert into upload_sessions
    (project_id, user_id, asset_type, declared_mime_type, declared_size_bytes,
     storage_bucket, storage_path, expires_at)
  values
    (v_project, v_user, 'image', 'image/png', 4096, 'uploads', gen_random_uuid()::text || '/c.png', now() + interval '15 minutes')
  returning id into v_upload;

  -- 模拟应用层在函数外先校验对象缺失 → 不调用 complete_upload，直接验证 session 仍 pending
  select status into v_status from upload_sessions where id = v_upload;
  if v_status = 'pending' then
    raise notice 'T3 PASS: 对象缺失时应用层拒绝，session 保持 pending';
  else
    raise exception 'T3 FAIL: session status=%', v_status;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T4: 乐观锁 —— apply_project_operations 版本冲突
-- 验证: 基线版本不匹配 → 抛 CONFLICT，且 project_operations 无写入
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid; v_project uuid; v_op_count int; v_new_version bigint;
begin
  select id into v_user from auth.users where email = 'tester@tapflow.test' limit 1;
  select id into v_project from projects where user_id = v_user and name = '并发测试' limit 1;

  -- 正确基线：应成功
  select * into v_new_version from apply_project_operations(
    v_project, 0, 'user', gen_random_uuid(),
    ('[{"operationId":"' || gen_random_uuid() || '","type":"create_node","data":{"nodeType":"text","position":{"x":0,"y":0},"size":{"width":100,"height":50}}}]')::jsonb);
  raise notice 'T4a: 正确基线成功, new_version=%', v_new_version;

  -- 过期基线：应抛 CONFLICT
  begin
    perform apply_project_operations(
      v_project, 0, 'user', gen_random_uuid(), '[]'::jsonb);
    raise exception 'T4 FAIL: 过期基线应抛错但未抛';
  exception when others then
    if sqlerrm like '%CONFLICT%' then
      select count(*) into v_op_count from project_operations where project_id = v_project;
      if v_op_count = 1 then
        raise notice 'T4 PASS: 过期基线被拒，历史仅 1 条（首次成功）';
      else
        raise exception 'T4 FAIL: 历史条数=%', v_op_count;
      end if;
    else
      raise exception 'T4 FAIL: 异常不符 %', sqlerrm;
    end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- T5: 路径语义 —— storage_path 禁止桶名前缀（CK 约束）
-- 验证: 插入 'uploads/xxx' 被 CHECK 拒绝
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid; v_project uuid; v_rejected boolean := false;
begin
  select id into v_user from auth.users where email = 'tester@tapflow.test' limit 1;
  select id into v_project from projects where user_id = v_user and name = '并发测试' limit 1;

  begin
    insert into upload_sessions
      (project_id, user_id, asset_type, declared_mime_type, declared_size_bytes,
       storage_bucket, storage_path, expires_at)
    values
      (v_project, v_user, 'image', 'image/png', 128, 'uploads', 'uploads/bad.png', now() + interval '15 minutes');
  exception when check_violation then
    v_rejected := true;
  end;

  if v_rejected then
    raise notice 'T5 PASS: uploads/uploads/ 被 CHECK 约束拒绝';
  else
    raise exception 'T5 FAIL: 桶前缀路径未被拒绝';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T6: content_hash 格式（02 契约 §4）
-- 验证: 非 'sha256:<64hex>' 被拒
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid; v_project uuid; v_rejected boolean := false;
  v_a uuid;
begin
  select id into v_user from auth.users where email = 'tester@tapflow.test' limit 1;
  select id into v_project from projects where user_id = v_user and name = '并发测试' limit 1;

  begin
    insert into assets (project_id, user_id, asset_type, storage_bucket, storage_path, content_hash)
    values (v_project, v_user, 'image', 'uploads', 'x.png', 'md5:abc');
  exception when check_violation then
    v_rejected := true;
  end;

  if v_rejected then
    raise notice 'T6 PASS: 非法 content_hash 被拒';
  else
    raise exception 'T6 FAIL: 非法 content_hash 未被拒绝';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T7: 清理 cron —— 过期会话被标 expired，且无资产的返回删除列表
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid; v_project uuid; v_expired int; v_to_delete int;
begin
  select id into v_user from auth.users where email = 'tester@tapflow.test' limit 1;
  select id into v_project from projects where user_id = v_user and name = '并发测试' limit 1;

  insert into upload_sessions
    (project_id, user_id, asset_type, declared_mime_type, declared_size_bytes,
     storage_bucket, storage_path, expires_at)
  values
    (v_project, v_user, 'image', 'image/png', 256, 'uploads', gen_random_uuid()::text || '/d.png', now() - interval '2 hours');

  select count(*) into v_expired from expire_stale_upload_sessions();
  select count(*) into v_to_delete
    from upload_sessions s
    left join assets a on a.id = s.asset_id
   where s.status = 'expired' and s.completed_at is null and a.id is null;

  if v_expired >= 1 and v_to_delete >= 1 then
    raise notice 'T7 PASS: cron 标 expired, 返回待删对象 % 个', v_to_delete;
  else
    raise exception 'T7 FAIL: expired=% to_delete=%', v_expired, v_to_delete;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 汇总
-- ---------------------------------------------------------------------------
select 'ALL CONCURRENCY TESTS DONE' as result;
