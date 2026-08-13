/**
 * 资产预览组件:根据 assetId 获取签名 URL，渲染图片或视频。
 * 处理加载失败、URL 过期重新签名（有界重试，可取消）。
 */
'use client';

import { useState, useEffect, useRef } from 'react';
import type { Uuid } from '@tapflow/contracts';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

interface AssetPreviewProps {
  assetId: Uuid;
}

interface Asset {
  id: Uuid;
  assetType: 'image' | 'video' | 'audio' | 'document';
  mimeType: string;
  url: string;
  expiresAt: string;
  width?: number;
  height?: number;
}

export default function AssetPreview({ assetId }: AssetPreviewProps) {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchAsset = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/assets/${assetId}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setAsset(data.asset);
      retryCountRef.current = 0;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleMediaError = () => {
    const MAX_RETRIES = 3;
    if (retryCountRef.current >= MAX_RETRIES) {
      setError('加载失败，已达最大重试次数');
      return;
    }
    retryCountRef.current += 1;
    const delay = Math.min(1000 * retryCountRef.current, 5000);
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      void fetchAsset();
    }, delay);
  };

  useEffect(() => {
    retryCountRef.current = 0;
    void fetchAsset();
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [assetId]);

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 120,
          color: '#6a6a7a',
          fontSize: 12,
        }}
      >
        加载中...
      </div>
    );
  }

  if (error || !asset) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 120,
          color: '#d94848',
          fontSize: 12,
          gap: 8,
        }}
      >
        <div>加载失败：{error || '未知错误'}</div>
        <button
          onClick={() => void fetchAsset()}
          style={{
            padding: '6px 12px',
            background: '#2a2a36',
            border: '1px solid #3a3a46',
            borderRadius: 6,
            color: '#e0e0ea',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          重试
        </button>
      </div>
    );
  }

  if (asset.assetType === 'image') {
    return (
      <img
        src={asset.url}
        alt="生成的图片"
        style={{
          width: '100%',
          height: 'auto',
          borderRadius: 6,
          display: 'block',
        }}
        onError={handleMediaError}
      />
    );
  }

  if (asset.assetType === 'video') {
    return (
      <video
        src={asset.url}
        controls
        style={{
          width: '100%',
          height: 'auto',
          borderRadius: 6,
          display: 'block',
        }}
        onError={handleMediaError}
      />
    );
  }

  return (
    <div
      style={{
        padding: 16,
        color: '#8a8a9a',
        fontSize: 12,
        textAlign: 'center',
      }}
    >
      不支持的资产类型：{asset.assetType}
    </div>
  );
}
