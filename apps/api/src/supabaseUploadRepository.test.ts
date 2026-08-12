/**
 * Supabase Upload repository 测试（P0-C/D/E 修复验证）
 * 覆盖：
 *   - presign 走 create_upload_session RPC（服务端补 user_id），返回对象 URL
 *   - complete 下载对象计算真实 sha256，不再返回假哈希
 *   - complete_upload RPC 不再传 p_user_id（归属由 auth.uid() 推导）
 *   - 错误映射（401 / 404 / UPLOAD_EXPIRED / UPLOAD_INCOMPLETE）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SupabaseUploadRepository } from './supabaseUploadRepository.ts';
import { UnauthorizedError } from './app.ts';
import { UploadNotFoundError, UploadValidationError } from './uploadRepository.ts';

const SUPABASE_URL = 'https://example.supabase.co';
const ANON_KEY = 'anon-key';
const PROJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UPLOAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function mockFetch(routes: Record<string, (init: RequestInit) => Response>) {
  return async (input: any, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return handler(init ?? {});
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeRepo(routes: Record<string, (init: RequestInit) => Response>) {
  return new SupabaseUploadRepository({
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    fetcher: mockFetch(routes) as typeof fetch,
  });
}

test('presign calls create_upload_session RPC and returns an authenticated object URL without serviceKey', async () => {
  let calledBody: any = null;
  let calledHeaders: any = null;
  const repo = makeRepo({
    'rpc/create_upload_session': (init) => {
      calledBody = JSON.parse(String(init.body));
      calledHeaders = init.headers;
      return jsonResponse([{ storage_bucket: 'uploads', storage_path: `${UPLOAD_ID}/upload.png` }]);
    },
  });

  const result = await repo.presign({
    projectId: PROJECT_ID as any,
    assetType: 'image',
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: 800,
    height: 600,
  }, 'Bearer test-jwt');

  assert.equal(calledBody.p_project_id, PROJECT_ID);
  assert.equal(calledBody.p_asset_type, 'image');
  assert.equal(calledBody.p_storage_bucket, 'uploads');
  // storage_path 由服务端生成：{随机uploadId}/upload.png（uuid 前缀 + 扩展名）
  assert.match(calledBody.p_storage_path, /^[0-9a-f-]{36}\/upload\.png$/);
  assert.ok(!String(calledBody).includes('user_id'));
  // URL 由 RPC 返回的 storage_path 构造（mock 返回 UPLOAD_ID 固定值）
  assert.equal(result.url, `${SUPABASE_URL}/storage/v1/object/uploads/${UPLOAD_ID}/upload.png`);
  assert.equal(new Headers(calledHeaders).get('authorization'), 'Bearer test-jwt');
  assert.equal(result.headers['Content-Type'], 'image/png');
  assert.equal(result.headers.apikey, ANON_KEY);
  assert.equal(result.headers.Authorization, 'Bearer test-jwt');
});

test('presign accepts Supabase signedURL response and normalizes relative URLs', async () => {
  let signedRequest: RequestInit | undefined;
  const repo = new SupabaseUploadRepository({
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
    serviceKey: 'service-role-key',
    fetcher: mockFetch({
      'rpc/create_upload_session': () =>
        jsonResponse([{ storage_bucket: 'uploads', storage_path: `${UPLOAD_ID}/upload.png` }]),
      'storage/v1/object/upload/sign/uploads': (init) => {
        signedRequest = init;
        return jsonResponse({ signedURL: `/object/upload/sign/uploads/${UPLOAD_ID}/upload.png?token=test-token` });
      },
    }) as typeof fetch,
  });

  const result = await repo.presign({
    projectId: PROJECT_ID as any,
    assetType: 'image',
    mimeType: 'image/png',
    sizeBytes: 10,
  }, 'Bearer test-jwt');

  assert.equal(result.url, `${SUPABASE_URL}/storage/v1/object/upload/sign/uploads/${UPLOAD_ID}/upload.png?token=test-token`);
  assert.equal(result.headers['Content-Type'], 'image/png');
  assert.equal(result.headers.apikey, undefined);
  assert.equal(new Headers(signedRequest?.headers).get('authorization'), 'Bearer service-role-key');
});

test('presign rejects unsupported MIME with 415', async () => {
  const repo = makeRepo({});
  await assert.rejects(
    () => repo.presign({
      projectId: PROJECT_ID as any,
      assetType: 'image',
      mimeType: 'application/zip',
      sizeBytes: 10,
    }, 'Bearer test-jwt'),
    (err: unknown) => err instanceof UploadValidationError && err.code === 'UNSUPPORTED_MEDIA_TYPE',
  );
});

test('presign requires authorization', async () => {
  const repo = makeRepo({});
  await assert.rejects(
    () => repo.presign({
      projectId: PROJECT_ID as any,
      assetType: 'image',
      mimeType: 'image/png',
      sizeBytes: 10,
    }),
    (err: unknown) => err instanceof UnauthorizedError,
  );
});

test('complete downloads the object, computes real sha256, and calls RPC without p_user_id', async () => {
  let rpcBody: any = null;
  let objectFetched = false;
  const repo = makeRepo({
    'rest/v1/upload_sessions': () =>
      jsonResponse([{
        project_id: PROJECT_ID,
        asset_type: 'image',
        storage_bucket: 'uploads',
        storage_path: `${UPLOAD_ID}/upload.png`,
        declared_mime_type: 'image/png',
        declared_size_bytes: 3,
        declared_width: 800,
        declared_height: 600,
        status: 'pending',
      }]),
    'storage/v1/object/uploads': () => {
      objectFetched = true;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    },
    'rpc/complete_upload': (init) => {
      rpcBody = JSON.parse(String(init.body));
      return jsonResponse([{ asset_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', already_completed: false }]);
    },
  });

  const result = await repo.complete(UPLOAD_ID, 'Bearer test-jwt');

  assert.ok(objectFetched, 'complete must download the object to compute the real hash');
  assert.equal(result.contentHash, 'sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
  assert.equal(result.sizeBytes, 3);
  assert.equal(result.assetId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  assert.equal(rpcBody.p_owner_id, null); // 归属由 RPC 内 auth.uid() 推导
  assert.equal(rpcBody.p_content_hash, 'sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
  // P0-2：asset_type 必须来自 session（presign 声明），不能拿 bucket 名 'uploads' 当 asset_type
  assert.equal(rpcBody.p_asset_type, 'image');
});

test('complete passes declared asset_type from session, never the bucket name (P0-2)', async () => {
  let rpcBody: any = null;
  const repo = makeRepo({
    'rest/v1/upload_sessions': () =>
      jsonResponse([{
        project_id: PROJECT_ID,
        // 即使桶是 uploads，asset_type 也必须是契约枚举值（来自 presign 声明）
        asset_type: 'video',
        storage_bucket: 'uploads',
        storage_path: `${UPLOAD_ID}/clip.mp4`,
        declared_mime_type: 'video/mp4',
        declared_size_bytes: 5,
        declared_width: null,
        declared_height: null,
        status: 'pending',
      }]),
    'storage/v1/object/uploads': () => new Response(new Uint8Array([9, 9, 9, 9, 9]), { status: 200 }),
    'rpc/complete_upload': (init) => {
      rpcBody = JSON.parse(String(init.body));
      return jsonResponse([{ asset_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', already_completed: false }]);
    },
  });

  await repo.complete(UPLOAD_ID, 'Bearer test-jwt');

  assert.equal(rpcBody.p_asset_type, 'video');
  assert.notEqual(rpcBody.p_asset_type, 'uploads');
  assert.equal(rpcBody.p_storage_bucket, 'uploads');
});

test('complete maps unknown upload id to 404', async () => {
  const repo = makeRepo({
    'rest/v1/upload_sessions': () => jsonResponse([]),
  });
  await assert.rejects(
    () => repo.complete(UPLOAD_ID, 'Bearer test-jwt'),
    (err: unknown) => err instanceof UploadNotFoundError,
  );
});

test('complete maps unreadable object to UPLOAD_INCOMPLETE', async () => {
  const repo = makeRepo({
    'rest/v1/upload_sessions': () =>
      jsonResponse([{
        project_id: PROJECT_ID,
        storage_bucket: 'uploads',
        storage_path: `${UPLOAD_ID}/upload.png`,
        declared_mime_type: 'image/png',
        declared_size_bytes: 3,
        declared_width: null,
        declared_height: null,
        status: 'pending',
      }]),
    'storage/v1/object/uploads': () => jsonResponse({ message: 'not found' }, 404),
  });
  await assert.rejects(
    () => repo.complete(UPLOAD_ID, 'Bearer test-jwt'),
    (err: unknown) => err instanceof UploadValidationError && err.code === 'UPLOAD_INCOMPLETE',
  );
});
