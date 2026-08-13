/**
 * @tapflow/contracts — 契约单一事实源（Design Frozen v1.4）
 *
 * 统一导出所有 Schema 与推导类型。
 * 前端（apps/web）与后端（apps/api, apps/worker）一律从这里 import，
 * 禁止各自定义重复类型。
 */
import { z } from 'zod';
import type * as S from './schemas.ts';

export * from './schemas.ts';

// 常用类型别名（从 Schema 推导，便于 TS 侧使用）
export type Uuid = z.infer<typeof S.UuidSchema>;
export type Json = z.infer<typeof S.JsonSchema>;

// 操作相关
export type CanvasOperation = z.infer<typeof S.CanvasOperationSchema>;
export type ClientOperation = z.infer<typeof S.ClientOperationSchema>;
export type OperationResult = z.infer<typeof S.OperationResultSchema>;
export type AgentCommandRequest = z.infer<typeof S.AgentCommandRequestSchema>;
export type AgentCommandResponse = z.infer<typeof S.AgentCommandResponseSchema>;
export type ApplyOperationsRequest = z.infer<typeof S.ApplyOperationsRequestSchema>;
export type ApplyOperationsResponse = z.infer<typeof S.ApplyOperationsResponseSchema>;
export type AgentOperationsBatch = z.infer<typeof S.AgentOperationsBatchSchema>;

// 上传相关
export type AssetType = z.infer<typeof S.AssetTypeSchema>;
export type PresignUploadRequest = z.infer<typeof S.PresignUploadRequestSchema>;
export type PresignUploadResponse = z.infer<typeof S.PresignUploadResponseSchema>;
export type CompleteUploadRequest = z.infer<typeof S.CompleteUploadRequestSchema>;
export type CompleteUploadResponse = z.infer<typeof S.CompleteUploadResponseSchema>;
export type Asset = z.infer<typeof S.AssetSchema>;
export type GetAssetResponse = z.infer<typeof S.GetAssetResponseSchema>;

// 项目相关
export type Project = z.infer<typeof S.ProjectSchema>;
export type CreateProjectRequest = z.infer<typeof S.CreateProjectRequestSchema>;
export type CreateProjectResponse = z.infer<typeof S.CreateProjectResponseSchema>;
export type ListProjectsResponse = z.infer<typeof S.ListProjectsResponseSchema>;
export type ProjectNodeSnapshot = z.infer<typeof S.ProjectNodeSnapshotSchema>;
export type ProjectEdgeSnapshot = z.infer<typeof S.ProjectEdgeSnapshotSchema>;
export type ProjectSnapshotResponse = z.infer<typeof S.ProjectSnapshotResponseSchema>;

// Job 相关
export type JobStatus = z.infer<typeof S.JobStatusSchema>;
export type JobStatusEvent = z.infer<typeof S.JobStatusEventSchema>;
export type Job = z.infer<typeof S.JobSchema>;
export type JobType = z.infer<typeof S.JobTypeSchema>;
export type CreateJobRequest = z.input<typeof S.CreateJobRequestSchema>;
export type CreateJobResponse = z.infer<typeof S.CreateJobResponseSchema>;
export type ListJobsResponse = z.infer<typeof S.ListJobsResponseSchema>;
export type GetJobResponse = z.infer<typeof S.GetJobResponseSchema>;
export type CancelJobResponse = z.infer<typeof S.CancelJobResponseSchema>;
export type ErrorResponse = z.infer<typeof S.ErrorResponseSchema>;
