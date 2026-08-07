/**
 * 文件上传 hook：presign → PUT → complete 三步闭环。
 *
 * 用法：
 *   const { upload, uploading, error } = useUpload();
 *   const assetId = await upload({ file, projectId, assetType: 'image' });
 */
'use client';

import { useCallback, useState } from 'react';
import {
  PresignUploadRequestSchema,
  PresignUploadResponseSchema,
  CompleteUploadResponseSchema,
  ErrorResponseSchema,
  type PresignUploadRequest,
  type CompleteUploadResponse,
} from '@tapflow/contracts';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

async function parseError(res: Response): Promise<string> {
  const body = ErrorResponseSchema.safeParse(await res.json().catch(() => null));
  return body.success ? body.data.error.message : `HTTP ${res.status}`;
}

export interface UploadOptions {
  file: File;
  projectId: string;
  assetType: PresignUploadRequest['assetType'];
  /** 图片/视频可选尺寸 */
  width?: number;
  height?: number;
}

export interface UploadResult extends CompleteUploadResponse {
  uploadId: string;
}

export function useUpload() {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number>(0); // 0-100
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(async (opts: UploadOptions): Promise<UploadResult | null> => {
    setUploading(true);
    setProgress(0);
    setError(null);

    try {
      // Step 1: presign
      const presignReq = PresignUploadRequestSchema.safeParse({
        assetType: opts.assetType,
        mimeType: opts.file.type || 'application/octet-stream',
        sizeBytes: opts.file.size,
        projectId: opts.projectId,
        width: opts.width,
        height: opts.height,
      });
      if (!presignReq.success) {
        throw new Error(`参数无效: ${presignReq.error.issues[0]?.message}`);
      }

      const presignRes = await fetch(`${API_BASE}/api/assets/presign-upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(presignReq.data),
      });
      if (!presignRes.ok) throw new Error(await parseError(presignRes));

      const presignBody = PresignUploadResponseSchema.safeParse(await presignRes.json());
      if (!presignBody.success) {
        throw new Error(`presign 响应契约错误: ${presignBody.error.issues[0]?.message}`);
      }
      const { uploadId, url, headers: signedHeaders } = presignBody.data;

      setProgress(10);

      // Step 2: PUT to signed URL（直传，不经服务器）
      const putRes = await fetch(url, {
        method: 'PUT',
        headers: signedHeaders,
        body: opts.file,
      });
      if (!putRes.ok) throw new Error(`存储上传失败: HTTP ${putRes.status}`);

      setProgress(80);

      // Step 3: complete
      const completeRes = await fetch(`${API_BASE}/api/assets/${uploadId}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!completeRes.ok) throw new Error(await parseError(completeRes));

      const completeBody = CompleteUploadResponseSchema.safeParse(await completeRes.json());
      if (!completeBody.success) {
        throw new Error(`complete 响应契约错误: ${completeBody.error.issues[0]?.message}`);
      }

      setProgress(100);
      return { ...completeBody.data, uploadId };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setUploading(false);
    }
  }, []);

  return { upload, uploading, progress, error };
}
