/**
 * 任务面板：显示项目下所有 Job，支持创建新任务、轮询状态、取消。
 */
'use client';

import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { useJobs } from '@/lib/hooks/useJobs';
import CreateJobForm from '@/components/ui/CreateJobForm';
import type { Job, Uuid, JobType, JobOutputRef } from '@tapflow/contracts';
import { createRetryController } from '@/lib/jobs/retryController';

interface JobsPanelProps {
  projectId: string | null;
  /** Job 成功后回调，调用方负责在画布上创建输出节点 */
  onJobSucceeded: (job: Job, outputs: JobOutputRef[]) => void;
}

export default function JobsPanel({ projectId, onJobSucceeded }: JobsPanelProps) {
  const { jobs, loading, error, createJob, listJobs, getJob, cancelJob, startPolling, stopPolling } = useJobs(projectId);
  const succeededJobsRef = useRef<Set<Uuid>>(new Set());
  // 首次加载完成前不触发成功回调：已 succeeded 的历史任务节点已在画布快照中，
  // 重新回调会重复落节点（刷新页面即可复现）。
  const [hydrated, setHydrated] = useState(false);

  // 首次加载：拉取列表，并把已成功的任务登记进守卫（不回调）
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      const existing = await listJobs();
      if (cancelled) return;
      existing.forEach((job) => {
        if (job.status === 'succeeded') succeededJobsRef.current.add(job.id);
      });
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, listJobs]);

  // 对所有 queued/running 的任务自动开轮询
  useEffect(() => {
    jobs.forEach((job) => {
      if (['queued', 'running'].includes(job.status)) {
        startPolling(job.id);
      }
    });
  }, [jobs, startPolling]);

  // 监听成功事件，触发回调（每个 job 只回调一次，避免轮询重复落节点）
  useEffect(() => {
    if (!hydrated) return;
    jobs.forEach((job) => {
      if (job.status === 'succeeded' && !succeededJobsRef.current.has(job.id)) {
        // 先调 getJob 拿 outputs，成功后才登记去重和回调
        void getJob(job.id).then((result) => {
          if (result) {
            succeededJobsRef.current.add(job.id);
            onJobSucceeded(result.job, result.outputs);
          }
        });
      }
    });
  }, [hydrated, jobs, getJob, onJobSucceeded]);

  const handleCreateJob = useCallback(
    async (formData: {
      jobType: JobType;
      model: string;
      params: Record<string, unknown>;
      inputNodeIds: string[];
    }) => {
      if (!projectId) return null;
      const jobId = await createJob(formData);
      if (jobId) startPolling(jobId);
      // 返回 jobId 供重试控制器判定成败（null → 展示提交失败）
      return jobId;
    },
    [projectId, createJob, startPolling],
  );

  const retryController = useMemo(
    () =>
      createRetryController(async (request) => {
        return handleCreateJob(request);
      }),
    [handleCreateJob],
  );
  const [, forceRetryRender] = useState(0);

  useEffect(() => retryController.subscribe(() => forceRetryRender((n) => n + 1)), [retryController]);

  const handleRetry = useCallback(
    (job: Job) => retryController.retry(job),
    [retryController],
  );

  const handleCancel = useCallback(
    async (jobId: Uuid) => {
      await cancelJob(jobId);
      stopPolling(jobId);
    },
    [cancelJob, stopPolling],
  );

  if (!projectId) return null;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        zIndex: 10,
        width: 320,
        maxHeight: 400,
        background: '#1e1e28',
        borderRadius: 10,
        padding: 16,
        color: '#e0e0ea',
        fontSize: 13,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <div style={{ color: '#8a8a9a', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>
          生成任务 ({jobs.length})
        </div>
        <CreateJobForm onSubmit={handleCreateJob} disabled={loading} />
      </div>

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

      {jobs.length === 0 && !loading && (
        <div style={{ color: '#5a5a6a', fontSize: 12, textAlign: 'center', padding: 20 }}>暂无任务</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            onCancel={handleCancel}
            onRetry={handleRetry}
            retrySubmitting={retryController.isSubmitting(job.id)}
            retryError={retryController.errorFor(job.id)}
          />
        ))}
      </div>
    </div>
  );
}

export function JobCard({
  job,
  onCancel,
  onRetry,
  retrySubmitting = false,
  retryError = null,
}: {
  job: Job;
  onCancel: (id: Uuid) => void;
  onRetry?: (job: Job) => void | Promise<void>;
  /** 该 job 的重试是否在途（在途时禁用按钮，防止连点创建重复 job） */
  retrySubmitting?: boolean;
  /** 重试提交失败信息，null 表示无错误 */
  retryError?: string | null;
}) {
  const statusColor = {
    queued: '#8a8a9a',
    running: '#5a9aef',
    cancel_requested: '#d0a050',
    succeeded: '#5aef9a',
    failed: '#e08090',
    cancelled: '#8a8a9a',
  }[job.status];

  const statusLabel = {
    queued: '⏳ 队列中',
    running: '▶️ 运行中',
    cancel_requested: '⏸️ 取消中',
    succeeded: '✅ 成功',
    failed: '❌ 失败',
    cancelled: '⏹️ 已取消',
  }[job.status];

  const canCancel = ['queued', 'running'].includes(job.status);

  return (
    <div
      style={{
        padding: 12,
        background: '#2a2a3a',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 12, fontWeight: 500 }}>{job.jobType}</div>
        <div style={{ color: statusColor, fontSize: 11 }}>{statusLabel}</div>
      </div>

      <div style={{ color: '#8a8a9a', fontSize: 11 }}>模型: {job.model}</div>

      {job.status === 'failed' && job.errorMessage && (
        <div style={{ color: '#e08090', fontSize: 11 }}>错误: {job.errorMessage}</div>
      )}

      {retryError && (
        <div role="alert" style={{ color: '#e08090', fontSize: 11 }}>
          重试失败: {retryError}
        </div>
      )}

      {job.status === 'failed' && onRetry && (
        <button
          type="button"
          disabled={retrySubmitting}
          onClick={() => void onRetry(job)}
          style={{
            padding: '4px 8px',
            background: '#3a3a4a',
            color: '#5a9aef',
            border: 'none',
            borderRadius: 4,
            cursor: retrySubmitting ? 'not-allowed' : 'pointer',
            opacity: retrySubmitting ? 0.6 : 1,
            fontSize: 11,
            alignSelf: 'flex-start',
          }}
          title="用相同参数重新提交任务"
        >
          {retrySubmitting ? '⏳ 提交中…' : '🔄 重试'}
        </button>
      )}

      {canCancel && (
        <button
          onClick={() => onCancel(job.id)}
          style={{
            padding: '4px 8px',
            background: '#3a3a4a',
            color: '#d0a050',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 11,
            alignSelf: 'flex-start',
          }}
        >
          取消
        </button>
      )}
    </div>
  );
}
