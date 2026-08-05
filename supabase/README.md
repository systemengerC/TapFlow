# TapFlow — Supabase Migrations

> 契约基准：`packages/contracts` v1.4（Implementation Frozen，2026-08-05）
> 状态：**正式 Migration v1.0**（已在 PostgreSQL 17 容器真实执行验证）

## 文件清单

| 文件 | 内容 |
|---|---|
| `202608050001_init_core.sql` | projects / canvas_nodes / canvas_edges / project_operations / confirmations / assets / generation_jobs + apply_project_operations 乐观锁函数 + 存储桶 |
| `202608050002_upload_sessions.sql` | upload_sessions 表 + complete_upload 并发函数 + expire_stale_upload_sessions 清理函数 |
| `202608050003_rls_policies.sql` | 全部业务表 RLS + Worker claim 策略 |
| `down/0001_rollback_all.sql` | 回滚全部（30 个 DROP，已验证） |

## 已闭环的终审阻塞项

1. **complete 并发**：`complete_upload()` 条件更新抢占（`WHERE status='pending'`），影响行数=1 者胜出；并发/重复调用幂等返回同一 asset_id。**真实并发验证**：A 抢得资产、B 幂等返回，资产总数=1。
2. **storage_path 路径语义**：桶内相对路径，`ck_upload_sessions_path_not_bucket` / `ck_assets_path_not_bucket` CHECK 约束杜绝 `uploads/uploads/`。
3. **乐观锁**：`apply_project_operations()` 事务内 `WHERE canvas_version=$baseVersion` 递增，冲突抛 CONFLICT（服务端映射 409），同事务写操作历史。
4. **updated_at 触发器**：moddatetime 扩展 + generation_jobs / canvas_nodes 触发器。
5. **存储桶**：uploads（1GB）/ generated（1GB）/ thumbs（10MB），非公开。

## 测试

```bash
# 1. 启动 PostgreSQL 15+（需 auth/storage schema stub，见测试脚本头注释）
# 2. 依次执行 001 → 002 → 003
# 3. 运行并发测试
psql -f tests/run_concurrency_tests.sql
# 结果：T1~T7 全部 PASS
```

覆盖场景：

| 场景 | 结果 |
|---|---|
| T1 并发/重复 complete | ✅ 单资产 + 幂等同一 asset_id |
| T2 complete vs expired 竞态 | ✅ expired 后 complete 被拒 |
| T3 对象缺失 | ✅ session 保持 pending |
| T4 乐观锁版本冲突 | ✅ 过期基线被拒，历史不污染 |
| T5 桶前缀路径 | ✅ CHECK 拒绝 |
| T6 content_hash 格式 | ✅ 非 sha256:64hex 被拒 |
| T7 孤儿清理 | ✅ 标 expired + 返回待删列表 |

## 注意

- 测试脚本内含 `auth.users` / `storage.buckets` stub，仅用于本地验证；Supabase 生产环境由平台提供。
- `auth.uid()` 依赖 `request.jwt.claim.sub` 设置；Worker 以 service_role 运行绕过 RLS，或使用 `generation_jobs_worker_claim` 策略。
- 部署顺序：`supabase db push` 或手动 psql 按编号执行；回滚用 down 脚本。
