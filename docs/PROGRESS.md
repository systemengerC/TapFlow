# TapFlow Progress

Last reviewed: 2026-08-12 (gpt integration review)

## Current State

| Area | Status | Evidence / Notes |
|---|---|---|
| P0 Supabase runtime wiring | Done (backend) | `SupabaseWorkerStore` moved to `apps/worker/src/`, wired via `buildRuntime()` in `apps/api/src/runtime.ts`; runner drives it. Worker entrypoint `apps/worker/src/index.ts` exists (Supabase mode via env, in-memory fallback). |
| P0 upload completion and `asset_type` | Done (backend) | `complete_upload` uses session `asset_type` (P0-2); `SupabaseUploadRepository` supports signed upload URL (serviceKey mode); presign/PUT/complete auth path covered by API tests + PG closure T1/T2/T3. |
| P0 generation completion SQL | Done (backend) | Migration 005: `complete_generation_job` returns updated row (`returning *`), `resize_nodes` numeric cast, `ASSET_TRANSFER_REQUIRED` fail-closed. Verified against real PostgreSQL 17.9 via podman: full chain setup→001→002→003→005→closure, 26 PASS, exit=0. |
| Worker asset transfer (serviceKey) | Done (backend) | `SupabaseWorkerStore.transferOutputs` downloads provider output → PUT `generated/{jobId}/{ordinal}.{ext}` → RPC receives object path. 5 new transfer tests added (transfer, passthrough, no-serviceKey passthrough, download failure, upload failure). Worker tests 24/24, tsc clean. |
| Web retry and duplicate-submit protection | Done | `retryController` deduplicates in-flight retries by job ID, clears stale errors, and rebuilds requests without the old idempotency key. Covered by controller and `JobCard` tests. |
| Web single/multi-node deletion | Done | Shared delete helper removes selected nodes and dangling edges; `PropertiesPanelView` exposes single/multi-delete UI and interaction tests. |
| Persistent asset URL / media preview | Blocked | Backend contract does not yet expose a persistent asset URL or `GET /api/assets/:id`; do not mark complete until that contract exists. |
| Release gates | Passed and pushed | Web: 44/44 tests, typecheck, lint, production build. API: 64/64 tests, typecheck. Worker: 24/24 tests, typecheck. Real PG closure: 26 PASS. Commit-level review found and fixed signed upload response/auth headers. |

## Verified Git State At Review

- Branch: `main`
- Local `main` matches `origin/main` at `c6a0d2490033d4440317ec8292b07eb78157906d`.
- Working tree: clean; backend and Web lanes are committed separately and pushed.
- Relevant commits: `77770bd` backend/worker/Supabase closure, `c5ecce6` upload signing/auth follow-up, `c77a181` Web retry/delete regression coverage.

## Verified Test Evidence (backend lane, 2026-08-12)

- Real PostgreSQL closure: `podman exec tapflow-review-pg` (PG 17.9), fresh DB `tapflow_closure`, full chain `setup_test_env.sql → 001 → 002 → 003 → 005 → run_closure_tests.sql`, `ON_ERROR_STOP=1`: **26 PASS, 0 FAIL, exit=0** (`ALL CLOSURE TESTS PASS`).
  - T1 upload closure (presign→PUT→complete→assets+session completed), T2 idempotent complete, T3 cross-user denied, T4 worker lifecycle (claim→provider_id→complete→succeeded+generated asset+outputs), T5 fail-closed (provider URL rejected, job stays running), T6 permission boundary (authenticated cannot claim/complete/fail), T7 canvas persistence (create_node→canvas_nodes+version+history), T8 RLS (own assets only, worker reads queue).
- Worker: `npm test` 24/24 pass (incl. 5 new transfer tests), `tsc --noEmit` exit=0.
- API: `npm test` 63/63 pass, `tsc --noEmit` exit=0.

## Working TODO

1. [x] Review uncommitted changes; resolve incomplete edits (actor check constraint + `raise notice` top-level SQL fixed in closure tests).
2. [x] Verify independent Worker entrypoint and Supabase runtime wiring.
3. [x] Execute upload/storage and generation closure tests against real PostgreSQL.
4. [x] Finish Web retry/delete regression coverage and run Web checks.
5. [ ] Implement persistent asset URL/API and media preview after the backend contract is available (blocked).
6. [x] Run repository release gates and inspect final diffs.
7. [x] Push reviewed commits to `origin/main`.
