/**
 * 最小生成表单：jobType、model、prompt、可选 params JSON。
 */
'use client';

import { useState, useCallback } from 'react';
import type { JobType } from '@tapflow/contracts';

interface CreateJobFormProps {
  onSubmit: (params: {
    jobType: JobType;
    model: string;
    params: Record<string, unknown>;
    inputNodeIds: string[];
  }) => void;
  disabled?: boolean;
}

const JOB_TYPES: JobType[] = ['text_to_image', 'image_to_video', 'text_to_video', 'tts', 'edit_image'];

export default function CreateJobForm({ onSubmit, disabled }: CreateJobFormProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [jobType, setJobType] = useState<JobType>('text_to_image');
  const [model, setModel] = useState('dall-e-3');
  const [prompt, setPrompt] = useState('');
  const [paramsJson, setParamsJson] = useState('{}');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(() => {
    setError(null);
    if (!prompt.trim()) {
      setError('prompt 不能为空');
      return;
    }
    if (!model.trim()) {
      setError('model 不能为空');
      return;
    }

    let params: Record<string, unknown>;
    try {
      params = JSON.parse(paramsJson);
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        throw new Error('params 必须是对象');
      }
    } catch (e) {
      setError(`params JSON 无效: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // 将 prompt 注入 params
    params.prompt = prompt;

    onSubmit({ jobType, model, params, inputNodeIds: [] });
    setIsOpen(false);
    setPrompt('');
    setParamsJson('{}');
    setError(null);
  }, [jobType, model, prompt, paramsJson, onSubmit]);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        disabled={disabled}
        style={{
          padding: '6px 12px',
          background: '#3a3a4a',
          color: '#e0e0ea',
          border: 'none',
          borderRadius: 6,
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        ➕ 新任务
      </button>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 100,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={() => setIsOpen(false)}
    >
      <div
        style={{
          background: '#1e1e28',
          borderRadius: 10,
          padding: 24,
          width: 480,
          maxHeight: '80vh',
          overflowY: 'auto',
          color: '#e0e0ea',
          fontSize: 13,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>创建生成任务</div>

        {error && (
          <div
            role="alert"
            style={{
              padding: '8px 12px',
              background: '#3a2028',
              color: '#e08090',
              borderRadius: 6,
              fontSize: 12,
              marginBottom: 12,
            }}
          >
            ⚠️ {error}
          </div>
        )}

        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ color: '#8a8a9a', fontSize: 11, marginBottom: 4 }}>任务类型</div>
          <select
            value={jobType}
            onChange={(e) => setJobType(e.target.value as JobType)}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: '#2a2a3a',
              color: '#e0e0ea',
              border: '1px solid #3a3a4a',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {JOB_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ color: '#8a8a9a', fontSize: 11, marginBottom: 4 }}>模型</div>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="例如: dall-e-3"
            style={{
              width: '100%',
              padding: '8px 12px',
              background: '#2a2a3a',
              color: '#e0e0ea',
              border: '1px solid #3a3a4a',
              borderRadius: 6,
              fontSize: 13,
            }}
          />
        </label>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ color: '#8a8a9a', fontSize: 11, marginBottom: 4 }}>Prompt</div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述你想生成的内容..."
            rows={4}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: '#2a2a3a',
              color: '#e0e0ea',
              border: '1px solid #3a3a4a',
              borderRadius: 6,
              fontSize: 13,
              resize: 'vertical',
            }}
          />
        </label>

        <label style={{ display: 'block', marginBottom: 16 }}>
          <div style={{ color: '#8a8a9a', fontSize: 11, marginBottom: 4 }}>
            额外参数 (JSON, 可选)
          </div>
          <textarea
            value={paramsJson}
            onChange={(e) => setParamsJson(e.target.value)}
            placeholder='{"size": "1024x1024"}'
            rows={3}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: '#2a2a3a',
              color: '#e0e0ea',
              border: '1px solid #3a3a4a',
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'monospace',
              resize: 'vertical',
            }}
          />
        </label>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={() => {
              setIsOpen(false);
              setError(null);
            }}
            style={{
              padding: '8px 16px',
              background: '#3a3a4a',
              color: '#8a8a9a',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={disabled}
            style={{
              padding: '8px 16px',
              background: '#5a9aef',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
