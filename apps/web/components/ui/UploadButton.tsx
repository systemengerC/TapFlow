/**
 * 上传按钮：选文件 → useUpload 三步闭环 → 回调 assetId 给调用方落节点。
 */
'use client';

import { useRef, useCallback } from 'react';
import { useUpload } from '@/lib/hooks/useUpload';
import type { AssetType } from '@tapflow/contracts';

interface UploadButtonProps {
  projectId: string | null;
  /** 上传成功后回调，调用方负责在画布上创建节点 */
  onUploaded: (assetId: string, assetType: AssetType, file: File) => void;
}

/** 从 MIME 推断 assetType（契约枚举：image/video/audio/thumbnail/document） */
function inferAssetType(mime: string): AssetType {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

export default function UploadButton({ projectId, onUploaded }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { upload, uploading, progress, error } = useUpload();

  const handleFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // 立即清空 input，让同一文件可以再次选择
      e.target.value = '';
      if (!file || !projectId) return;

      const assetType = inferAssetType(file.type);
      const result = await upload({ file, projectId, assetType });
      if (result) onUploaded(result.assetId, assetType, file);
    },
    [projectId, upload, onUploaded],
  );

  const disabled = !projectId || uploading;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        onChange={handleFile}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        aria-label="上传素材"
        style={{
          padding: '8px 14px',
          background: '#1e1e28',
          color: disabled ? '#5a5a6a' : '#e0e0ea',
          border: 'none',
          borderRadius: 8,
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: 13,
          fontWeight: 500,
          whiteSpace: 'nowrap',
        }}
      >
        {uploading ? `⬆ ${progress}%` : '⬆ 上传'}
      </button>

      {error && (
        <div
          role="alert"
          style={{
            padding: '6px 10px',
            background: '#3a2028',
            color: '#e08090',
            borderRadius: 6,
            fontSize: 12,
            maxWidth: 240,
          }}
        >
          ⚠️ {error}
        </div>
      )}
    </div>
  );
}
