/**
 * Job CRUD hook：创建 / 列表 / 详情 / 取消 / 轮询。
 *
 * 用法：
 *   const { createJob, listJobs, getJob, cancelJob, polling } = useJobs(projectId);
 *   const jobId = await createJob({ jobType: 'text_to_image', model: 'dall-e-3', params: {...}, inputNodeIds: [] });
 *   useEffect(() => { startPolling(jobId); return () => stopPolling(jobId); }, [jobId]);
 */
'use client';

import { useCallback, useState, useRef, useEffect } from 'react';
import {
  CreateJobRequestSchema,
  CreateJobResponseSchema,
  ListJobsResponseSchema,
  GetJobResponseSchema,
  CancelJobResponseSchema,
  ErrorResponseSchema,
  type CreateJobRequest,
  type Job,
  type Uuid,
} from '@tapflow/contracts';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

async function parseError(res: Response): Promise<string> {
  const body = ErrorResponseSchema.safeParse(await res.json().catch(() => null));
  return body.success ? body.data.error.message : `HTTP ${res.status}`;
}

export function useJobs(projectId: string | null) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<Uuid, Job>>({});

  const pollingTimers = useRef<Record<Uuid, NodeJS.Timeout>>({});

  /** 创建 Job（幂等键防重） */
  const createJob = useCallback(
    async (req: Omit<CreateJobRequest, 'projectId'>): Promise<Uuid | null> => {
      if (!projectId) {
        setError('projectId 缺失');
        return null;
      }

      const reqParsed = CreateJobRequestSchema.safeParse({
        ...req,
        projectId,
        idempotencyKey: req.idempotencyKey ?? crypto.randomUUID(),
      });
      if (!reqParsed.success) {
        setError(`参数无效: ${reqParsed.error.issues[0]?.message}`);
        return null;
      }

      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/api/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(reqParsed.data),
        });
        if (!res.ok) throw new Error(await parseError(res));

        const parsed = CreateJobResponseSchema.safeParse(await res.json());
        if (!parsed.success) {
          throw new Error(`响应契约错误: ${parsed.error.issues[0]?.message}`);
        }
        const { job } = parsed.data;
        setJobs((prev) => ({ ...prev, [job.id]: job }));
        return job.id;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  /** 列出项目下所有 Job */
  const listJobs = useCallback(async (): Promise<Job[]> => {
    if (!projectId) return [];

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/jobs`);
      if (!res.ok) throw new Error(await parseError(res));

      const parsed = ListJobsResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error(`响应契约错误: ${parsed.error.issues[0]?.message}`);
      }
      const jobList = parsed.data.jobs;
      setJobs((prev) => ({
        ...prev,
        ...Object.fromEntries(jobList.map((j) => [j.id, j])),
      }));
      return jobList;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return [];
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  /** 获取单个 Job 详情 */
  const getJob = useCallback(async (jobId: Uuid): Promise<Job | null> => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${jobId}`);
      if (!res.ok) throw new Error(await parseError(res));

      const parsed = GetJobResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error(`响应契约错误: ${parsed.error.issues[0]?.message}`);
      }
      const { job } = parsed.data;
      setJobs((prev) => ({ ...prev, [job.id]: job }));
      return job;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  /** 取消 Job */
  const cancelJob = useCallback(async (jobId: Uuid): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${jobId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await parseError(res));

      const parsed = CancelJobResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error(`响应契约错误: ${parsed.error.issues[0]?.message}`);
      }
      const { job } = parsed.data;
      setJobs((prev) => ({ ...prev, [job.id]: job }));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  /** 停止轮询 */
  const stopPolling = useCallback((jobId: Uuid) => {
    const timer = pollingTimers.current[jobId];
    if (timer) {
      clearInterval(timer);
      delete pollingTimers.current[jobId];
    }
  }, []);

  /** 开始轮询（queued/running 状态每 2s 拉一次） */
  const startPolling = useCallback(
    (jobId: Uuid) => {
      if (pollingTimers.current[jobId]) return; // 已在轮询

      const poll = async () => {
        const job = await getJob(jobId);
        if (!job) {
          stopPolling(jobId);
          return;
        }
        // 终态：停止轮询
        if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
          stopPolling(jobId);
        }
      };

      poll(); // 立即拉一次
      pollingTimers.current[jobId] = setInterval(poll, 2000);
    },
    [getJob, stopPolling],
  );

  // 清理：组件卸载时停止所有轮询
  useEffect(() => {
    const timers = pollingTimers.current;
    return () => {
      Object.values(timers).forEach((timer) => clearTimeout(timer));
    };
  }, []);

  return {
    jobs: Object.values(jobs),
    jobsMap: jobs,
    loading,
    error,
    createJob,
    listJobs,
    getJob,
    cancelJob,
    startPolling,
    stopPolling,
  };
}
