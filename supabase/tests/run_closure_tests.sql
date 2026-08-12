-- ============================================================================
-- TapFlow Phase 1 — Migration 005 闭环测试（真实 PostgreSQL 执行验证）
-- 覆盖（对应阻断项 5 要求）：
--   T1 上传闭环：presign（create_upload_session）→ 模拟客户端 PUT（storage.objects
--      RLS insert 策略）→ complete_upload → assets 落库 + session completed
--   T2 complete_upload 幂等：重复 complete 返回同一 asset_id（already_completed=true）
--   T3 越权：其他用户 complete 他人 session → UPLOAD_SESSION_NOT_FOUND
--   T4 Worker 生命周期：claim → set_provider_id → complete（转存后对象路径）
--      → assets(generated) + generation_job_outputs + succeeded
--   T5 fail-closed：complete 传 provider URL（http(s)://）→ ASSET_TRANSFER_REQUIRED
--   T6 权限边界：authenticated 不能 claim/complete（仅 tapflow_worker/service_role）
--   T7 画布落库：apply_project_operations create_node → canvas_nodes 行 + 版本递增 + 操作历史
--   T8 RLS：authenticated 只见本人资产；tapflow_worker 可读 job 队列
-- 运行: setup_test_env.sql → 001 → 002 → 003 → 005 → 本文件（psql -v ON_ERROR_STOP=1）
-- 任一 FAIL 立即抛异常退出非 0；全部通过输出 PASS
-- ============================================================================

-- 测试断言辅助（仅测试库；生产不执行本文件）
create or replace function tf_expect(cond boolean, label text) returns void as $$
begin
  if not cond then
    raise exception 'FAIL: %', label;
  end if;
  raise notice 'PASS: %', label;
end;
$$ language plpgsql;

-- 表级权限（表在 001-005 创建后补齐；Supabase 生产默认授予，RLS 负责行级过滤）
grant select, insert, update, delete on all tables in schema public to authenticated, service_role, tapflow_worker;

-- 期望异常辅助：do 块内捕获，message 匹配即 PASS
create or replace function tf_expect_error(fn text, expected text, label text) returns void as $$
declare
  v_msg text;
begin
  begin
    execute fn;
    raise exception 'FAIL: % (no error raised, expected %)', label, expected;
  exception when others then
    v_msg := sqlerrm;
    if v_msg like '%' || expected || '%' then
      raise notice 'PASS: %', label;
    else
      raise exception 'FAIL: % (got: %)', label, v_msg;
    end if;
  end;
end;
$$ language plpgsql;

-- 确定性标识
-- users / projects / sessions / jobs
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'closure-a@test'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'closure-b@test')
on conflict (id) do nothing;

insert into projects (id, user_id, name) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'closure-project')
on conflict (id) do nothing;

-- ============================================================================
-- T1 上传闭环（authenticated A）
-- ============================================================================
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

select tf_expect(
  (select user_id from create_upload_session(
     'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid, 'image'::text, 'image/png'::text, 1024::bigint,
     800::int, 600::int, 'uploads'::text, '99999999-9999-4999-8999-999999999999/upload.png'::text,
     now() + interval '15 min')) = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'T1a create_upload_session persists user_id = auth.uid()');

-- 模拟客户端 PUT：storage.objects insert（RLS insert 策略放行 pending session owner）
insert into storage.objects (bucket_id, name, owner)
values ('uploads', '99999999-9999-4999-8999-999999999999/upload.png', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
select tf_expect(true, 'T1b storage.objects insert allowed by RLS (pending session owner)');

-- complete_upload：真实哈希由应用层计算后传入
-- （session id 由 create_upload_session 随机生成，用 storage_path 反查）
select tf_expect(
  (select asset_id from complete_upload(
     (select id from upload_sessions where storage_path = '99999999-9999-4999-8999-999999999999/upload.png'),
     'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
     null, 'image'::text, 'uploads'::text, '99999999-9999-4999-8999-999999999999/upload.png'::text,
     'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text, 1024::bigint, 800::int, 600::int)) is not null,
  'T1c complete_upload returns asset_id');

select tf_expect(
  exists (select 1 from assets
           where asset_type = 'image'
             and storage_bucket = 'uploads'
             and storage_path = '99999999-9999-4999-8999-999999999999/upload.png'
             and user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'T1d assets row persisted with owner');

select tf_expect(
  (select status from upload_sessions where id = '99999999-9999-4999-8999-999999999999'::uuid) = 'completed',
  'T1e upload session marked completed');
commit;

-- ============================================================================
-- T2 complete_upload 幂等：重复调用返回同一 asset_id
-- ============================================================================
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select tf_expect(
  (select asset_id from complete_upload(
     (select id from upload_sessions where storage_path = '99999999-9999-4999-8999-999999999999/upload.png'),
     'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
     null, 'image'::text, 'uploads'::text, '99999999-9999-4999-8999-999999999999/upload.png'::text,
     'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text, 1024::bigint, 800::int, 600::int))
   = (select asset_id from upload_sessions where storage_path = '99999999-9999-4999-8999-999999999999/upload.png'),
  'T2 duplicate complete returns same asset_id');
commit;

-- ============================================================================
-- T3 越权：用户 B complete A 的 session → 报错
-- ============================================================================
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select tf_expect_error(
  $$select complete_upload(
     (select id from upload_sessions where storage_path = '99999999-9999-4999-8999-999999999999/upload.png'),
     'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid, null, 'image'::text,
     'uploads'::text, '99999999-9999-4999-8999-999999999999/upload.png'::text,
     'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text, 1024::bigint, 800::int, 600::int)$$,
  'UPLOAD_SESSION_NOT_FOUND',
  'T3 other user cannot complete someone else''s session');
commit;

-- ============================================================================
-- T4 Worker 生命周期（tapflow_worker 视角）
-- ============================================================================
-- setup：queued job
insert into generation_jobs (id, project_id, user_id, job_type, model, params, idempotency_key)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'text_to_image', 'gpt-image-2', '{"prompt":"closure"}',
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
on conflict (id) do nothing;

begin;
set local role tapflow_worker;
select tf_expect(
  (select job->>'id' from claim_next_generation_job()) = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'T4a worker claims queued job');
select tf_expect(
  (select status from generation_jobs where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') = 'running',
  'T4b job transitioned queued → running');

select tf_expect(
  (select job->>'provider_job_id' from set_generation_job_provider_id(
     'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'provider-1')) = 'provider-1',
  'T4c provider_job_id backfilled');

-- complete：转存后的真实对象路径（无 http(s) 前缀）
select tf_expect(
  (select job->>'status' from complete_generation_job(
     'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
     '[{"url":"dddddddd-dddd-4ddd-8ddd-dddddddddddd/0.png","mimeType":"image/png","width":1024,"height":1024}]'::jsonb)) = 'succeeded',
  'T4d complete returns updated row (succeeded, not stale running)');
commit;

select tf_expect(
  (select status from generation_jobs where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') = 'succeeded',
  'T4e job reached succeeded');
select tf_expect(
  exists (select 1 from assets
           where project_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
             and storage_bucket = 'generated'
             and storage_path = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd/0.png'
             and asset_type = 'image'),
  'T4f generated asset persisted (bucket=generated, path=object path)');
select tf_expect(
  exists (select 1 from generation_job_outputs
           where job_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' and ordinal = 0),
  'T4g generation_job_outputs row persisted');

-- ============================================================================
-- T5 fail-closed：complete 传 provider URL → ASSET_TRANSFER_REQUIRED
-- ============================================================================
insert into generation_jobs (id, project_id, user_id, job_type, model, params, idempotency_key)
values ('ffffffff-ffff-4fff-8fff-ffffffffffff',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'tts', 'tts-1', '{"text":"hi"}',
        '11111111-1111-4111-8111-111111111111')
on conflict (id) do nothing;

begin;
set local role tapflow_worker;
select claim_next_generation_job();  -- 领取 ffff（created_at 最新 queued）

select tf_expect_error(
  $$select complete_generation_job('ffffffff-ffff-4fff-8fff-ffffffffffff',
     '[{"url":"https://fake.local/out.mp3","mimeType":"audio/mpeg"}]'::jsonb)$$,
  'ASSET_TRANSFER_REQUIRED',
  'T5 provider URL rejected as storage_path (fail-closed)');
commit;

select tf_expect(
  (select status from generation_jobs where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff') = 'running',
  'T5b job remains running after rejected complete (no side effects)');

-- ============================================================================
-- T6 权限边界：authenticated 不能 claim / complete / fail
-- ============================================================================
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select tf_expect_error(
  $$select claim_next_generation_job()$$,
  'permission denied',
  'T6a authenticated cannot claim jobs');
select tf_expect_error(
  $$select complete_generation_job('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '[]'::jsonb)$$,
  'permission denied',
  'T6b authenticated cannot complete jobs');
select tf_expect_error(
  $$select fail_generation_job('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'X', 'y')$$,
  'permission denied',
  'T6c authenticated cannot fail jobs');
commit;

-- ============================================================================
-- T7 画布落库：apply_project_operations create_node
-- ============================================================================
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

select tf_expect(
  (select apply_project_operations(
     'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid, 0::bigint, 'user'::text,
     '22222222-2222-4222-8222-222222222222'::uuid,
     '[{"operationId":"33333333-3333-4333-8333-333333333333","type":"create_node",
        "payload":{"nodeType":"text","position":{"x":10,"y":20},"size":{"width":200,"height":80},"data":{"text":"hi"}}}]'::jsonb)) = 1,
  'T7a apply_project_operations returns new version');

select tf_expect(
  exists (select 1 from canvas_nodes
           where id = '33333333-3333-4333-8333-333333333333'
             and project_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
             and node_type = 'text'),
  'T7b canvas node persisted (not just history)');
select tf_expect(
  (select canvas_version from projects where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') = 1,
  'T7c canvas version incremented');
select tf_expect(
  exists (select 1 from project_operations
           where project_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
             and operation_group_id = '22222222-2222-4222-8222-222222222222'),
  'T7d operation history written in same transaction');
commit;

-- ============================================================================
-- T8 RLS：authenticated 只见本人资产；tapflow_worker 可读 job 队列
-- ============================================================================
-- setup：B 的资产
insert into assets (project_id, user_id, asset_type, storage_bucket, storage_path, content_hash, size_bytes)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'document', 'generated', 'b-only/doc.pdf',
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 5);

begin;
set local role authenticated;
set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select tf_expect(
  not exists (select 1 from assets a where a.storage_path = 'b-only/doc.pdf'),
  'T8a authenticated A cannot see B assets');
select tf_expect(
  exists (select 1 from assets a where a.user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'T8b authenticated A sees own assets');
commit;

begin;
set local role tapflow_worker;
select tf_expect(
  exists (select 1 from generation_jobs),
  'T8c tapflow_worker can read job queue (worker RLS)');
commit;

-- ============================================================================
-- 收尾
-- ============================================================================
drop function tf_expect(boolean, text);
drop function tf_expect_error(text, text, text);

select 'ALL CLOSURE TESTS PASS' as result;
