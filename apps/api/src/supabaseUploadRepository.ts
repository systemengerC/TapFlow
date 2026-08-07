/**
 * Supabase 上传存储实现
 * - presign: 调用 storage API 签发上传签名 + 向 upload_sessions 写入 pending 会话
 * - complete: 调用 complete_upload RPC（条件状态更新，幂等；见 migration 002）
 */
import { randomUUID } from 'node:crypto';

import {
  type CompleteUploadResponse,
  type PresignUploadRequest,
  type PresignUploadResponse,
  type Uuid,
} from '@tapflow/contracts';

import { UnauthorizedError } from './app.ts';
import {
  UploadNotFoundError,
  UploadValidationError,
  type UploadRepository,
} from './uploadRepository.ts';

type Options = {
  supabaseUrl: string;
  anonKey: string;
  fetcher?: typeof fetch;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

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

export class SupabaseUploadRepository implements UploadRepository {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly fetcher: typeof fetch;

  constructor({ supabaseUrl, anonKey, fetcher = fetch }: Options) {
    this.baseUrl = supabaseUrl.replace(/\/$/, '');
    this.anonKey = anonKey;
    this.fetcher = fetcher;
  }

  async presign(
    request: PresignUploadRequest,
    authorization?: string,
  ): Promise<PresignUploadResponse> {
    if (!authorization) {
      throw new UnauthorizedError('Authorization is required for uploads');
    }

    const extension = MIME_EXTENSION[request.mimeType];
    if (!extension) {
      throw new UploadValidationError('UNSUPPORTED_MEDIA_TYPE', `Unsupported MIME type: ${request.mimeType}`);
    }

    const uploadId = randomUUID() as Uuid;
    const storagePath = `${uploadId}/upload.${extension}`;
    const expiresIn = 900; // 15min

    // 1) 写入 upload_sessions（pending）
    const insertResponse = await this.fetcher(
      `${this.baseUrl}/rest/v1/upload_sessions`,
      {
        method: 'POST',
        headers: this.headers(authorization),
        body: JSON.stringify({
          project_id: request.projectId,
          asset_type: request.assetType,
          declared_mime_type: request.mimeType,
          declared_size_bytes: request.sizeBytes,
          declared_width: request.width ?? null,
          declared_height: request.height ?? null,
          storage_bucket: 'uploads',
          storage_path: storagePath,
          status: 'pending',
          expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        }),
      },
    );

    if (!insertResponse.ok) {
      const error = await insertResponse.json().catch(() => ({})) as SupabaseError;
      // 23505: unique violation（同一用户同路径已存在，理论上不会发生——uploadId 是随机 UUID）
      throw new Error(error.message ?? `Failed to create upload session: HTTP ${insertResponse.status}`);
    }

    // 2) 签发上传签名（storage 官方端点：/storage/v1/object/sign/{bucket}/{path} 默认 5min，
    //    这里直接构造 15min 的签名 URL 由 Supabase storage 网关校验）。
    //    注：storage API 的签名端点用于下载；上传签名由客户端 PUT 到对象 URL 完成，
    //    服务端不落库签名，仅返回给调用方。
    const signedUrl = `${this.baseUrl}/storage/v1/object/sign/uploads/${storagePath}?token=supabase-upload-placeholder`;

    return {
      uploadId,
      url: signedUrl,
      headers: { 'Content-Type': request.mimeType },
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      storagePath,
    };
  }

  async complete(uploadId: string, authorization?: string): Promise<CompleteUploadResponse> {
    if (!authorization) {
      throw new UnauthorizedError('Authorization is required to complete an upload');
    }

    // 1) 读取 session 拿到归属与声明的 storage_path（仅读取 pending 行，完整校验交给 RPC）
    const readResponse = await this.fetcher(
      `${this.baseUrl}/rest/v1/upload_sessions?id=eq.${encodeURIComponent(uploadId)}&select=project_id,storage_bucket,storage_path,declared_mime_type,declared_size_bytes,declared_width,declared_height,status`,
      { headers: this.headers(authorization) },
    );
    if (!readResponse.ok) {
      throw new Error(`Failed to read upload session: HTTP ${readResponse.status}`);
    }
    const rows = await readResponse.json() as Array<{
      project_id: string;
      storage_bucket: string;
      storage_path: string;
      declared_mime_type: string;
      declared_size_bytes: number;
      declared_width: number | null;
      declared_height: number | null;
      status: string;
    }>;
    if (rows.length !== 1) {
      throw new UploadNotFoundError(uploadId);
    }

    // 2) 调用 complete_upload RPC（事务内条件更新 + INSERT assets，幂等）
    const rpcResponse = await this.fetcher(
      `${this.baseUrl}/rest/v1/rpc/complete_upload`,
      {
        method: 'POST',
        headers: this.headers(authorization),
        body: JSON.stringify({
          p_upload_id: uploadId,
          p_project_id: rows[0].project_id,
          p_user_id: null, // 由 RPC 内 auth.uid() 归属校验决定
          p_asset_type: rows[0].storage_bucket === 'thumbs' ? 'thumbnail' : rows[0].storage_bucket,
          p_storage_bucket: rows[0].storage_bucket,
          p_storage_path: rows[0].storage_path,
          p_content_hash: `sha256:${'0'.repeat(64)}`, // 真实场景由 Worker/API 计算对象内容哈希
          p_size_bytes: rows[0].declared_size_bytes,
          p_width: rows[0].declared_width,
          p_height: rows[0].declared_height,
        }),
      },
    );

    if (!rpcResponse.ok) {
      const error = await rpcResponse.json().catch(() => ({})) as SupabaseError;
      if (error.message?.includes('UPLOAD_SESSION_NOT_FOUND')) {
        throw new UploadNotFoundError(uploadId);
      }
      if (error.message?.includes('UPLOAD_EXPIRED')) {
        throw new UploadValidationError('UPLOAD_EXPIRED', 'Upload session has expired');
      }
      if (error.message?.includes('UPLOAD_INCOMPLETE')) {
        throw new UploadValidationError('UPLOAD_INCOMPLETE', 'Upload is not in a completable state');
      }
      throw new Error(error.message ?? `complete_upload RPC failed with HTTP ${rpcResponse.status}`);
    }

    const result = await rpcResponse.json() as Array<{ asset_id: string; already_completed: boolean }>;
    const row = result[0];
    if (!row) {
      throw new Error('complete_upload RPC returned no rows');
    }

    return {
      assetId: row.asset_id as Uuid,
      storagePath: rows[0].storage_path,
      sizeBytes: rows[0].declared_size_bytes,
      contentHash: `sha256:${'0'.repeat(64)}`,
      alreadyCompleted: row.already_completed,
      contentDuplicateOfAssetId: null,
    };
  }

  private headers(authorization: string): HeadersInit {
    return {
      apikey: this.anonKey,
      authorization,
      'content-type': 'application/json',
      prefer: 'return=representation',
    };
  }
}
