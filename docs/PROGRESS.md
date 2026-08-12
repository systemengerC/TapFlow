# TapFlow Progress

Last reviewed: 2026-08-12 (deepseek backend lane verified)

## Current State

| Area | Status | Evidence / Notes |
|---|---|---|
| P0 Supabase runtime wiring | Done (backend) | `SupabaseWorkerStore` moved to `apps/worker/src/`, wired via `buildRuntime()` in `apps/api/src/runtime.ts`; runner drives it. Worker entrypoint `apps/worker/src/index.ts` exists (Supabase mode via env, in-memory fallback). |
| P0 upload completion and `asset_type` | Done (backend) | `complete_upload` uses session `asset_type` (P0-2); `SupabaseUploadRepository` supports signed upload URL (serviceKey mode); presign/PUT/complete auth path covered by API tests + PG closure T1/T2/T3. |
| P0 generation completion SQL | Done (backend) | Migration 005: `complete_generation_job` returns updated row (`returning *`), `resize_nodes` numeric cast, `ASSET_TRANSFER_REQUIRED` fail-closed. Verified against real PostgreSQL 17.9 via podman: full chain setup→001→002→003→005→closure, 26 PASS, exit=0. |
| Worker asset transfer (serviceKey) | Done (backend) | `SupabaseWorkerStore.transferOutputs` downloads provider output → PUT `generated/{jobId}/{ordinal}.{ext}` → RPC receives object path. 5 new transfer tests added (transfer, passthrough, no-serviceKey passthrough, download failure, upload failure). Worker tests 24/24, tsc clean. |
| Web retry and duplicate-submit protection | In progress (cc lane) | Retry controller and related Web changes present in working tree; final suite and diff review remain. |
| Web single/multi-node deletion | In progress (cc lane) | Delete helpers and component tests are present; final suite and diff review remain. |
| Persistent asset URL / media preview | Blocked | Backend contract does not yet expose a persistent asset URL or `GET /api/assets/:id`; do not mark complete until that contract exists. |
| Release gates | Pending (gpt) | Run full tests, typecheck, lint, build, inspect diff, then commit/push as requested. |

## Verified Git State At Review

- Branch: `main`
- Ahead of `origin/main`: 3 commits (unpushed)
- Working tree: backend lane changes verified but **not yet committed** (API runtime/upload repo, Worker store+entrypoint+tests, Supabase migration 005 + closure tests).
- Latest known relevant commit: `d092d3c fix(api,supabase): wire SupabaseWorkerStore into runtime, fix complete_upload asset_type and worker RPC output (P0)`

## Verified Test Evidence (backend lane, 2026-08-12)

- Real PostgreSQL closure: `podman exec tapflow-review-pg` (PG 17.9), fresh DB `tapflow_closure`, full chain `setup_test_env.sql → 001 → 002 → 003 → 005 → run_closure_tests.sql`, `ON_ERROR_STOP=1`: **26 PASS, 0 FAIL, exit=0** (`ALL CLOSURE TESTS PASS`).
  - T1 upload closure (presign→PUT→complete→assets+session completed), T2 idempotent complete, T3 cross-user denied, T4 worker lifecycle (claim→provider_id→complete→succeeded+generated asset+outputs), T5 fail-closed (provider URL rejected, job stays running), T6 permission boundary (authenticated cannot claim/complete/fail), T7 canvas persistence (create_node→canvas_nodes+version+history), T8 RLS (own assets only, worker reads queue).
- Worker: `npm test` 24/24 pass (incl. 5 new transfer tests), `tsc --noEmit` exit=0.
- API: `npm test` 63/63 pass, `tsc --noEmit` exit=0.

## Working TODO

1. [x] Review uncommitted changes; resolve incomplete edits (actor check constraint + `raise notice` top-level SQL fixed in closure tests).
2. [x] Verify independent Worker entrypoint and Supabase runtime wiring.
3. [x] Execute upload/storage and generation closure tests against real PostgreSQL.
4. [ ] Finish Web retry/delete regression coverage and run Web checks (cc lane).
5. [ ] Implement persistent asset URL/API and media preview after the backend contract is available (blocked).
6. [ ] Run repository release gates, inspect final diff, commit, and push (gpt).
