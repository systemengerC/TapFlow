import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AddressInfo } from 'node:net';
import { type Server } from 'node:http';

import {
  CompleteUploadResponseSchema,
  PresignUploadResponseSchema,
} from '@tapflow/contracts';

import { createApp, InMemoryOperationsRepository } from './app.ts';
import { InMemoryJobRepository } from './jobRepository.ts';
import { InMemoryProjectRepository } from './projectRepository.ts';
import { InMemoryUploadRepository } from './uploadRepository.ts';

type AppOptions = Parameters<typeof createApp>[0];

async function withServer(options: AppOptions, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createApp(options);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

const appOptions = (): AppOptions => ({
  repository: new InMemoryOperationsRepository(),
  projectRepository: new InMemoryProjectRepository(),
  uploadRepository: new InMemoryUploadRepository(),
  jobRepository: new InMemoryJobRepository(),
});

test('presign: returns uploadId, signed URL and storagePath for a valid image', async () => {
  await withServer(appOptions(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/assets/presign-upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assetType: 'image',
        mimeType: 'image/png',
        sizeBytes: 2457600,
        width: 1920,
        height: 1080,
        projectId: '4f9c1a2e-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    const parsed = PresignUploadResponseSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? body));
    assert.equal(parsed.data!.expiresIn, 900);
    assert.match(parsed.data!.storagePath, /^[0-9a-f-]{36}\/upload\.png$/);
    assert.ok(parsed.data!.url.startsWith('https://storage.example.invalid/uploads/'));
  });
});

test('presign: rejects unsupported MIME type with 415', async () => {
  await withServer(appOptions(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/assets/presign-upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assetType: 'image',
        mimeType: 'application/x-unknown',
        sizeBytes: 1024,
        projectId: '4f9c1a2e-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
      }),
    });
    assert.equal(response.status, 415);
    const body = await response.json();
    assert.equal(body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
  });
});

test('presign: rejects invalid projectId with 400', async () => {
  await withServer(appOptions(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/assets/presign-upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assetType: 'image',
        mimeType: 'image/png',
        sizeBytes: 1024,
        projectId: 'not-a-uuid',
      }),
    });
    assert.equal(response.status, 400);
  });
});

test('complete: returns assetId and is idempotent for a prior presign', async () => {
  const uploads = new InMemoryUploadRepository();
  await withServer({ ...appOptions(), uploadRepository: uploads }, async (baseUrl) => {
    const presignResponse = await fetch(`${baseUrl}/api/assets/presign-upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assetType: 'image',
        mimeType: 'image/png',
        sizeBytes: 1024,
        projectId: '4f9c1a2e-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
      }),
    });
    const { uploadId } = await presignResponse.json();

    const response = await fetch(`${baseUrl}/api/assets/${uploadId}/complete`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = await response.json();
    const parsed = CompleteUploadResponseSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? body));
    assert.equal(parsed.data!.alreadyCompleted, false);
    assert.match(parsed.data!.contentHash, /^sha256:[0-9a-f]{64}$/);

    // 重复 complete：幂等返回同一 assetId
    const secondResponse = await fetch(`${baseUrl}/api/assets/${uploadId}/complete`, { method: 'POST' });
    assert.equal(secondResponse.status, 200);
    const secondBody = await secondResponse.json();
    assert.equal(secondBody.assetId, body.assetId);
  });
});

test('complete: unknown uploadId returns 404', async () => {
  await withServer(appOptions(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/assets/00000000-0000-0000-0000-000000000000/complete`, {
      method: 'POST',
    });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, 'UPLOAD_NOT_FOUND');
  });
});

test('complete: invalid uploadId returns 400', async () => {
  await withServer(appOptions(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/assets/not-a-uuid/complete`, { method: 'POST' });
    assert.equal(response.status, 400);
  });
});
