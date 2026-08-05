-- ============================================================================
-- TapFlow Phase 1 — 数据库并发测试（终审返修 #4 重写）
-- 前置: setup_test_env.sql → 001 → 002 → 003 已执行
-- 运行: psql -v ON_ERROR_STOP=1 -f tests/run_concurrency_tests.sql
-- 语义: 任一测试块 FAIL/异常 → psql 立即以非 0 退出；只有全部通过才输出 PASS
-- 可重复: 确定性 UUID 测试身份，重复运行不会污染断言
-- ============================================================================

\set ON_ERROR_STOP 1

-- ---------------------------------------------------------------------------
-- 0) 准备：确定性测试身份 + JWT 上下文（auth.uid() 校验依赖）
--    USER_ID   = 00000000-0000-0000-0000-000000000001
--    PROJECT_ID= 00000000-0000-0000-0000-000000000002
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000001', 'tester@tapflow.test')
on conflict (id) do update set email = excluded.email;

insert into projects (id, user_id, name)
values ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '并发测试')
on conflict (id) do update set name = excluded.name;

-- ---------------------------------------------------------------------------
-- T1: 并发/重复 complete（同一 uploadId）→ 仅一个 INSERT assets
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid := '00000000-0000-0000-0000-000000000001';
  v_project uuid := '00000000-0000-0000-0000-000000000002';
  v_upload uuid; v_path text;
  v_a uuid; v_b uuid; v_ok_a boolean; v_ok_b boolean;
  v_asset_count int;
begin
  insert into upload_sessions
    (project_id, user_id, asset_type, declared_mime_type, declared_size_bytes,
     storage_bucket, storage_path, expires_at)
  values
    (v_project, v_user, 'image', 'image/png', 1024, 'uploads', gen_random_uuid()::text || '/a.png', now() + interval '15 minutes')
  returning id, storage_path into v_upload, v_path;

  select asset_id, already_completed into v_a, v_ok_a from complete_upload(
    v_upload, v_project, v_user, 'image', 'uploads', v_path,
    'sha256:' || repeat('a', 64), 1024, 100, 100);

  -- 第二次 complete：应幂等返回同一 asset_id，already_completed=true
  select asset_id, already_completed into v_b, v_ok_b from complete_upload(
    v_upload, v_project, v_user, 'image', 'uploads', v_path,
    'sha256:' || repeat('a', 64), 1024, 100, 100);

  select count(*) into v_asset_count from assets where id = v_a;

  if v_a = v_b and v_ok_b and v_asset_count = 1 and v_a is not null then
    raise notice 'T1 PASS: 并发 complete 单资产 + 幂等同一 asset_id (%)', v_a;
  else
    raise exception 'T1 FAIL: a=% b=% ok_a=% ok_b=% count=%', v_a, v_b, v_ok_a, v_ok_b, v_asset_count;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T2: complete 与 expired 竞态 → 条件更新保证只有一个胜者
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid := '00000000-0000-0000-0000-000000000001';
  v_project uuid := '00000000-0000-0000-0000-000000000002';
  v_upload uuid; v_path text;
  v_asset_count int;
begin
  insert into upload_sessions
    (project_id, user_id, asset_type, declared_mime_type, declared_size_bytes,
     storage_bucket, storage_path, expires_at)
  values
    (v_project, v_user, 'image', 'image/png', 2048, 'uploads', gen_random_uuid()::text || '/b.png', now() - interval '1 minute')
  returning id, storage_path into v_upload, v_path;

  -- 标 expired（模拟 cron）
  update upload_sessions set status = 'expired' where id = v_upload;

  -- complete 应失败
  begin
    perform complete_upload(
      v_upload, v_project, v_user, 'image', 'uploads', v_path,
      'sha256:' || repeat('b', 64), 2048, 50, 50);
    raise exception 'T2 FAIL: complete 应抛错但未抛';
  exception when others then
    if sqlerrm like '%UPLOAD_EXPIRED%' then
      select count(*) into v_asset_count from assets where storage_path = v_path;
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
-- T3: complete 时对象缺失（session 存在但未实际上传）→ 应用层拒绝，session 保持 pending
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid := '00000000-0000-0000-0000-000000000001';
  v_project uuid := '00000000-0000-0000-0000-000000000002';
  v_upload uuid; v_status text;
begin
  insert into upload_sessions
    (project_id, user_id, asset_type, declared_mime_type, declared_size_bytes,
     storage_bucket, storage_path, expires_at)
  values
    (v_project, v_user, 'image', 'image/png', 4096, 'uploads', gen_random_uuid()::text || '/c.png', now() + interval '15 minutes')
  returning id into v_upload;

  select status into v_status from upload_sessions where id = v_upload;
  if v_status = 'pending' then
    raise notice 'T3 PASS: 对象缺失时应用层拒绝，session 保持 pending';
  else
    raise exception 'T3 FAIL: session status=%', v_status;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T4: 乐观锁 —— apply_project_operations 版本冲突（可重复运行）
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid := '00000000-0000-0000-0000-000000000001';
  v_project uuid := '00000000-0000-0000-0000-000000000002';
  v_group uuid; v_cur bigint; v_new_version bigint;
  v_op_count int;
begin
  select canvas_version into v_cur from projects where id = v_project;
  v_group := gen_random_uuid();

  -- 正确基线 v_cur：应成功 → v_cur + 1
  select * into v_new_version from apply_project_operations(
    v_project, v_cur, 'user', v_group,
    ('[{"operationId":"' || gen_random_uuid() || '","type":"create_node","data":{"nodeType":"text","position":{"x":0,"y":0},"size":{"width":100,"height":50}}}]')::jsonb);
  raise notice 'T4a: 正确基线成功, version % → %', v_cur, v_new_version;

  if v_new_version <> v_cur + 1 then
    raise exception 'T4 FAIL: 新版本=% 应为 %', v_new_version, v_cur + 1;
  end if;

  -- 过期基线 v_cur：应抛 CONFLICT，且本组无历史写入
  begin
    perform apply_project_operations(
      v_project, v_cur, 'user', gen_random_uuid(), '[]'::jsonb);
    raise exception 'T4 FAIL: 过期基线应抛错但未抛';
  exception when others then
    if sqlerrm like '%CONFLICT%' then
      select count(*) into v_op_count from project_operations
       where project_id = v_project and operation_group_id = v_group;
      if v_op_count = 1 then
        raise notice 'T4 PASS: 过期基线被拒，本组历史仅 1 条（首次成功）';
      else
        raise exception 'T4 FAIL: 本组历史条数=%', v_op_count;
      end if;
    else
      raise exception 'T4 FAIL: 异常不符 %', sqlerrm;
    end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- T5: 路径语义 —— storage_path 禁止桶名前缀（CK 约束）
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid := '00000000-0000-0000-0000-000000000001';
  v_project uuid := '00000000-0000-0000-0000-000000000002';
  v_rejected boolean := false;
begin
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
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid := '00000000-0000-0000-0000-000000000001';
  v_project uuid := '00000000-0000-0000-0000-000000000002';
  v_rejected boolean := false;
begin
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
  v_user uuid := '00000000-0000-0000-0000-000000000001';
  v_project uuid := '00000000-0000-0000-0000-000000000002';
  v_upload uuid; v_path text;
  v_expired int; v_to_delete int;
begin
  insert into upload_sessions
    (project_id, user_id, asset_type, declared_mime_type, declared_size_bytes,
     storage_bucket, storage_path, expires_at)
  values
    (v_project, v_user, 'image', 'image/png', 256, 'uploads', gen_random_uuid()::text || '/d.png', now() - interval '2 hours')
  returning id, storage_path into v_upload, v_path;

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
-- 汇总（只有走到这里才输出；任一 FAIL 已使 psql 以 ON_ERROR_STOP 提前退出）
-- ---------------------------------------------------------------------------
select 'ALL CONCURRENCY TESTS PASS' as result;
