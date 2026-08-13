/**
 * 上传存储接口 + 内存实现
 * P0 范围：presign（签发上传签名）/ complete（上传完成回执，幂等）
 * Supabase 实现见 supabaseUploadRepository.ts
 */
import { randomUUID } from 'node:crypto';

import {
  type Asset,
  type CompleteUploadResponse,
  type PresignUploadRequest,
  type PresignUploadResponse,
  type Uuid,
} from '@tapflow/contracts';

export type UploadRepositoryOptions = {
  /** presign 有效期（秒），默认 900（15min） */
  presignTtlSeconds?: number;
  /** 模拟的存储基地址，仅 InMemory 使用 */
  fakeStorageBaseUrl?: string;
};

export interface UploadRepository {
  presign(request: PresignUploadRequest, authorization?: string): Promise<PresignUploadResponse>;
  complete(uploadId: string, authorization?: string): Promise<CompleteUploadResponse>;
  /** 读取资产并签发下载签名 URL（GET /api/assets/:id） */
  getAsset(assetId: string, authorization?: string): Promise<Asset>;
}

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
};

export class UploadValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'UploadValidationError';
    this.code = code;
  }
}

export class UploadNotFoundError extends Error {
  readonly uploadId: string;

  constructor(uploadId: string) {
    super(`Upload session ${uploadId} was not found`);
    this.name = 'UploadNotFoundError';
    this.uploadId = uploadId;
  }
}

export class AssetNotFoundError extends Error {
  readonly assetId: string;

  constructor(assetId: string) {
    super(`Asset ${assetId} was not found`);
    this.name = 'AssetNotFoundError';
    this.assetId = assetId;
  }
}

export class InMemoryUploadRepository implements UploadRepository {
  private readonly presignTtlSeconds: number;
  private readonly fakeStorageBaseUrl: string;
  private readonly sessions = new Map<string, {
    request: PresignUploadRequest;
    expiresAt: number;
    assetId?: Uuid;
  }>();

  constructor(options: UploadRepositoryOptions = {}) {
    this.presignTtlSeconds = options.presignTtlSeconds ?? 900;
    this.fakeStorageBaseUrl = options.fakeStorageBaseUrl ?? 'https://storage.example.invalid';
  }

  async presign(request: PresignUploadRequest): Promise<PresignUploadResponse> {
    const extension = MIME_EXTENSION[request.mimeType];
    if (!extension) {
      throw new UploadValidationError('UNSUPPORTED_MEDIA_TYPE', `Unsupported MIME type: ${request.mimeType}`);
    }

    const uploadId = randomUUID() as Uuid;
    const storagePath = `${uploadId}/upload.${extension}`;
    const expiresAt = Date.now() + this.presignTtlSeconds * 1000;

    this.sessions.set(uploadId, {
      request,
      expiresAt,
    });

    return {
      uploadId,
      url: `${this.fakeStorageBaseUrl}/uploads/${storagePath}?token=fake-presign-${uploadId}`,
      headers: { 'Content-Type': request.mimeType },
      expiresIn: this.presignTtlSeconds,
      expiresAt: new Date(expiresAt).toISOString(),
      storagePath,
    };
  }

  async complete(uploadId: string): Promise<CompleteUploadResponse> {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new UploadNotFoundError(uploadId);
    }
    if (Date.now() > session.expiresAt) {
      throw new UploadValidationError('UPLOAD_EXPIRED', 'Upload session has expired');
    }

    const alreadyCompleted = session.assetId !== undefined;
    const assetId = session.assetId ?? (randomUUID() as Uuid);
    session.assetId = assetId;

    return {
      assetId,
      storagePath: `${uploadId}/upload.${MIME_EXTENSION[session.request.mimeType]}`,
      sizeBytes: session.request.sizeBytes,
      contentHash: `sha256:${'0'.repeat(64)}`,
      alreadyCompleted,
      contentDuplicateOfAssetId: null,
    };
  }

  async getAsset(assetId: string): Promise<Asset> {
    let found: { uploadId: string; request: PresignUploadRequest } | undefined;
    for (const [uploadId, session] of this.sessions) {
      if (session.assetId === assetId) {
        found = { uploadId, request: session.request };
        break;
      }
    }
    if (!found) {
      throw new AssetNotFoundError(assetId);
    }
    const storagePath = `${found.uploadId}/upload.${MIME_EXTENSION[found.request.mimeType]}`;
    return {
      id: assetId as Uuid,
      projectId: found.request.projectId,
      assetType: found.request.assetType,
      mimeType: found.request.mimeType,
      sizeBytes: found.request.sizeBytes,
      width: found.request.width ?? null,
      height: found.request.height ?? null,
      contentHash: `sha256:${'0'.repeat(64)}`,
      storagePath,
      url: `${this.fakeStorageBaseUrl}/assets/${assetId}?token=fake-download-${assetId}`,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };
  }
}
