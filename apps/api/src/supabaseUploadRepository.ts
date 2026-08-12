/**
 * Supabase 上传存储实现
 * - presign: 调 create_upload_session RPC（服务端写 user_id = auth.uid()，修复 P0-C）
 *   + 返回存储对象 URL（配合 migration 005 storage.objects RLS 策略直传）
 * - complete: 下载对象计算真实 sha256 contentHash（修复 P0-D 假哈希），
 *   再调 complete_upload RPC（归属由 auth.uid() 推导，修复 P0-E）
 */
import { createHash, randomUUID } from 'node:crypto';

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
  serviceKey?: string;
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

type UploadSessionRow = {
  project_id: string;
  asset_type: string;
  storage_bucket: string;
  storage_path: string;
  declared_mime_type: string;
  declared_size_bytes: number;
  declared_width: number | null;
  declared_height: number | null;
  status: string;
};

export class SupabaseUploadRepository implements UploadRepository {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly serviceKey: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor({ supabaseUrl, anonKey, serviceKey, fetcher = fetch }: Options) {
    this.baseUrl = supabaseUrl.replace(/\/$/, '');
    this.anonKey = anonKey;
    this.serviceKey = serviceKey;
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
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // 1) 服务端创建 upload_sessions（RPC 内部写 user_id = auth.uid()，客户端不可伪造归属）
    const rpcResponse = await this.fetcher(
      `${this.baseUrl}/rest/v1/rpc/create_upload_session`,
      {
        method: 'POST',
        headers: this.headers(authorization),
        body: JSON.stringify({
          p_project_id: request.projectId,
          p_asset_type: request.assetType,
          p_declared_mime_type: request.mimeType,
          p_declared_size_bytes: request.sizeBytes,
          p_declared_width: request.width ?? null,
          p_declared_height: request.height ?? null,
          p_storage_bucket: 'uploads',
          p_storage_path: storagePath,
          p_expires_at: expiresAt,
        }),
      },
    );

    if (!rpcResponse.ok) {
      const error = await rpcResponse.json().catch(() => ({})) as SupabaseError;
      if (error.message?.includes('FORBIDDEN')) {
        throw new Error(error.message);
      }
      throw new Error(error.message ?? `Failed to create upload session: HTTP ${rpcResponse.status}`);
    }

    const rows = await rpcResponse.json() as Array<{ storage_bucket: string; storage_path: string }>;
    if (!rows[0]) {
      throw new Error('create_upload_session returned no rows');
    }

    const storageBucket = rows[0].storage_bucket;
    const persistedPath = rows[0].storage_path;

    // 2) 返回直传 URL（阻断项 4）：
    //    - 配置了 serviceKey：调 Storage createSignedUploadUrl 返回签名上传 URL，
    //      客户端 PUT 仅需 Content-Type（token 内置于 URL），无需 apikey/authorization
    //    - 未配置（联调）：返回对象 URL，并把 apikey + Authorization 交给客户端
    let url: string;
    let headers: Record<string, string>;
    if (this.serviceKey) {
      const signResponse = await this.fetcher(
        `${this.baseUrl}/storage/v1/object/upload/sign/${storageBucket}/${persistedPath}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.serviceKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ expiresIn }),
        },
      );
      if (!signResponse.ok) {
        const error = await signResponse.json().catch(() => ({})) as SupabaseError;
        throw new Error(error.message ?? `Failed to create signed upload URL: HTTP ${signResponse.status}`);
      }
      const signResult = await signResponse.json() as {
        signedURL?: string;
        signedUrl?: string;
        url?: string;
        token?: string;
      };
      const signedUrl = signResult.signedURL ?? signResult.signedUrl ?? signResult.url;
      if (!signedUrl) {
        throw new Error('createSignedUploadUrl returned no signed URL');
      }
      url = /^https?:\/\//i.test(signedUrl)
        ? signedUrl
        : `${this.baseUrl}/storage/v1/${signedUrl.replace(/^\/+/, '')}`;
      headers = { 'Content-Type': request.mimeType };
    } else {
      url = `${this.baseUrl}/storage/v1/object/${storageBucket}/${persistedPath}`;
      headers = {
        'Content-Type': request.mimeType,
        apikey: this.anonKey,
        Authorization: authorization,
      };
    }

    return {
      uploadId,
      url,
      headers,
      expiresIn,
      expiresAt,
      storagePath: persistedPath,
    };
  }

  async complete(uploadId: string, authorization?: string): Promise<CompleteUploadResponse> {
    if (!authorization) {
      throw new UnauthorizedError('Authorization is required to complete an upload');
    }

    // 1) 读取 session 拿到归属、声明的 asset_type 与 storage_path
    const readResponse = await this.fetcher(
      `${this.baseUrl}/rest/v1/upload_sessions?id=eq.${encodeURIComponent(uploadId)}&select=project_id,asset_type,storage_bucket,storage_path,declared_mime_type,declared_size_bytes,declared_width,declared_height,status`,
      { headers: this.headers(authorization) },
    );
    if (!readResponse.ok) {
      throw new Error(`Failed to read upload session: HTTP ${readResponse.status}`);
    }
    const rows = await readResponse.json() as UploadSessionRow[];
    if (rows.length !== 1) {
      throw new UploadNotFoundError(uploadId);
    }

    // 2) 下载对象计算真实 sha256（P0-D：替代假哈希；storage.objects read 策略放行 pending owner）
    const objectUrl = `${this.baseUrl}/storage/v1/object/${rows[0].storage_bucket}/${rows[0].storage_path}`;
    const objectResponse = await this.fetcher(objectUrl, {
      headers: this.headers(authorization),
    });
    if (!objectResponse.ok) {
      throw new UploadValidationError(
        'UPLOAD_INCOMPLETE',
        `Uploaded object not readable: HTTP ${objectResponse.status}（确认文件已 PUT 到存储）`,
      );
    }
    const buffer = Buffer.from(await objectResponse.arrayBuffer());
    const contentHash = `sha256:${createHash('sha256').update(buffer).digest('hex')}`;

    // 3) 调 complete_upload RPC（p_owner_id=null → RPC 内 auth.uid() 推导归属，修复 P0-E）
    //    asset_type 使用 presign 时声明的 session.asset_type（经契约 AssetTypeSchema 校验），
    //    不得用 bucket 名推导（'uploads' 不在 assets CHECK 约束内，修复 P0-2）
    const rpcResponse = await this.fetcher(
      `${this.baseUrl}/rest/v1/rpc/complete_upload`,
      {
        method: 'POST',
        headers: this.headers(authorization),
        body: JSON.stringify({
          p_upload_id: uploadId,
          p_project_id: rows[0].project_id,
          p_owner_id: null,
          p_asset_type: rows[0].asset_type,
          p_storage_bucket: rows[0].storage_bucket,
          p_storage_path: rows[0].storage_path,
          p_content_hash: contentHash,
          p_size_bytes: buffer.length,
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
      sizeBytes: buffer.length,
      contentHash,
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
