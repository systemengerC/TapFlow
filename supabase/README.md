# TapFlow — Supabase Migrations

> 契约基准：`packages/contracts` v1.4（Implementation Frozen，2026-08-05）
> 状态：**正式 Migration v1.1**（终审返修 #1~#4 已落地，PostgreSQL 17 容器真实执行验证）

## 文件清单

| 文件 | 内容 |
|---|---|
| `202608050001_init_core.sql` | projects / canvas_nodes / canvas_edges / project_operations / confirmations / assets / generation_jobs + apply_project_operations 乐观锁函数 + 存储桶 + tapflow_worker 角色引导 + 执行权限 |
| `202608050002_upload_sessions.sql` | upload_sessions 表 + complete_upload 并发函数 + expire_stale_upload_sessions 清理函数 + 执行权限 |
| `202608050003_rls_policies.sql` | 全部业务表 RLS + Worker 角色限定策略 |
| `down/0001_rollback_all.sql` | 回滚全部（含 tapflow_worker 角色） |
| `tests/setup_test_env.sql` | 本地验证环境 stub（auth/storage/角色，可重复执行） |
| `tests/run_concurrency_tests.sql` | 并发测试（确定性 UUID、ON_ERROR_STOP=1） |

## 安全边界（终审返修落地）

1. **Worker 策略角色限定**：`generation_jobs_worker_read/claim` 仅对 `tapflow_worker` 角色生效；普通用户只能操作自己的任务（`generation_jobs_owner`）。
2. **`search_path` 固定**：所有 `SECURITY DEFINER` 函数均声明 `set search_path = public, pg_temp`。
3. **执行权限最小化**：全部函数 `REVOKE EXECUTE FROM PUBLIC` 后按需授权：
   - `apply_project_operations` → authenticated / service_role / tapflow_worker
   - `complete_upload` → authenticated / service_role / tapflow_worker
   - `expire_stale_upload_sessions` → service_role / tapflow_worker（仅 cron/worker）
4. **函数内归属校验**：登录用户调用时校验 `auth.uid()` 与项目/会话归属，越权抛 `42501 FORBIDDEN`；service_role/worker（无 JWT 上下文）跳过，由应用层授权。

## 已闭环的终审阻塞项

1. **complete 并发**：`complete_upload()` 条件更新抢占（`WHERE status='pending'`），影响行数=1 者胜出；并发/重复调用幂等返回同一 asset_id。**真实并发验证**：A 抢得资产、B 幂等返回，资产总数=1。
2. **storage_path 路径语义**：桶内相对路径，`ck_upload_sessions_path_not_bucket` / `ck_assets_path_not_bucket` CHECK 约束杜绝 `uploads/uploads/`。
3. **乐观锁**：`apply_project_operations()` 事务内 `WHERE canvas_version=$baseVersion` 递增，冲突抛 CONFLICT（服务端映射 409），同事务写操作历史。
4. **updated_at 触发器**：moddatetime 扩展 + generation_jobs / canvas_nodes 触发器。
5. **存储桶**：uploads（1GB）/ generated（1GB）/ thumbs（10MB），非公开。

## 测试

```bash
# 1. 启动 PostgreSQL 15+
docker run -d --name tapflow-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 pgvector/pgvector:pg17

# 2. 执行顺序（必须）
psql "postgresql://postgres:postgres@localhost:55432/postgres" \
  -v ON_ERROR_STOP=1 -f supabase/tests/setup_test_env.sql
psql ... -v ON_ERROR_STOP=1 -f supabase/migrations/202608050001_init_core.sql
psql ... -v ON_ERROR_STOP=1 -f supabase/migrations/202608050002_upload_sessions.sql
psql ... -v ON_ERROR_STOP=1 -f supabase/migrations/202608050003_rls_policies.sql

# 3. 并发测试（ON_ERROR_STOP=1：任一 FAIL 立即退出非 0，只有全部通过输出 PASS）
psql ... -v ON_ERROR_STOP=1 -f supabase/tests/run_concurrency_tests.sql
# 结果：ALL CONCURRENCY TESTS PASS

# 4. 回滚验证
psql ... -v ON_ERROR_STOP=1 -f supabase/migrations/down/0001_rollback_all.sql
```

覆盖场景：

| 场景 | 结果 |
|---|---|
| T1 并发/重复 complete | ✅ 单资产 + 幂等同一 asset_id |
| T2 complete vs expired 竞态 | ✅ expired 后 complete 被拒 |
| T3 对象缺失 | ✅ session 保持 pending |
| T4 乐观锁版本冲突 | ✅ 过期基线被拒，历史不污染（可重复运行） |
| T5 桶前缀路径 | ✅ CHECK 拒绝 |
| T6 content_hash 格式 | ✅ 非 sha256:64hex 被拒 |
| T7 孤儿清理 | ✅ 标 expired + 返回待删列表 |

## 注意

- `tests/setup_test_env.sql` 仅用于本地验证（auth/storage/角色 stub）；Supabase 生产环境由平台提供，无需执行。
- `auth.uid()` 依赖 `request.jwt.claim.sub`；测试脚本顶部已用确定性用户 UUID 设置。
- 部署顺序：`supabase db push` 或手动 psql 按编号执行；回滚用 down 脚本。
