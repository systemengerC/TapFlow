/**
 * 文档示例（v1.4）—— 与 SOP/contracts/*.md 中的 JSON 示例保持一致，全部使用合法 UUID。
 * 所有示例必须通过对应 schema 的 safeParse（契约测试强制）。
 */
import type { z } from 'zod';
import type {
  AgentCommandRequestSchema,
  CanvasOperationSchema,
  ApplyOperationsRequestSchema,
  ApplyOperationsResponseSchema,
  PresignUploadRequestSchema,
  PresignUploadResponseSchema,
  CompleteUploadRequestSchema,
  CompleteUploadResponseSchema,
  ConfirmationAcceptRequestSchema,
  AgentCommandResponseSchema,
  JobStatusEventSchema,
} from './schemas.ts';

// ---------- 通用 UUID ----------
export const U = {
  project: '4f9c1a2e-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
  selectedNode: '11111111-2222-3333-4444-555555555555',
  clientRequestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  opJob: '6f9c1a2e-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
  opNode: '7f9c1a2e-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
  opEdge: '8f9c1a2e-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
  opNodeA: '1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d',
  opNodeB: '2a3b4c5d-6e7f-4b8c-9d0e-1f2a3b4c5d6e',
  jobId: 'a6f9c1a2-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
  nodeId: 'b6f9c1a2-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
  edgeId: 'c6f9c1a2-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
  confirmationId: 'caf9c1a2-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
  groupId: '9f9c1a2e-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
  uploadId: '3f9c1a2e-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
  assetId: '6f9c1a2e-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
  capabilityId: 'd6f9c1a2-8b3d-4e5f-9a6b-2c3d4e5f6a7b',
} as const;

// ---------- 01 文档：AgentCommand ----------
export const agentCommandRequest: z.input<typeof AgentCommandRequestSchema> = {
  projectId: U.project,
  command: '让 @产品图 动起来，生成 5 秒视频',
  selection: {
    nodeIds: [U.selectedNode],
    explicitReferenceNodeIds: [U.selectedNode],
    viewportCenter: { x: 820, y: 460 },
  },
  preferences: { defaultVideoModel: 'openai/sora', aspectRatio: '16:9' },
  clientRequestId: U.clientRequestId,
};

export const agentOperations: z.input<typeof CanvasOperationSchema>[] = [
  {
    type: 'create_job',
    operationId: U.opJob,
    payload: {
      jobType: 'image_to_video',
      inputNodeIds: [U.selectedNode],
      model: 'openai/sora',
      params: { durationSeconds: 5 },
    },
  },
  {
    type: 'create_node',
    operationId: U.opNode,
    payload: {
      nodeType: 'generation_job',
      jobRef: { ref: 'operation_result', operationId: U.opJob },
    },
  },
  {
    type: 'create_edge',
    operationId: U.opEdge,
    payload: {
      edgeType: 'input',
      source: { ref: 'node', nodeId: U.selectedNode },
      target: { ref: 'operation_result', operationId: U.opNode },
    },
  },
];

export const agentCommandResponse200 = {
  message: '将使用选中的产品图生成 5 秒视频。',
  needsConfirmation: false,
  confirmation: null,
  operations: agentOperations,
  results: {
    [U.opJob]: { type: 'create_job', jobId: U.jobId },
    [U.opNode]: { type: 'create_node', nodeId: U.nodeId },
    [U.opEdge]: { type: 'create_edge', edgeId: U.edgeId },
  },
};

export const agentCommandResponse202 = {
  message: '预计成本超出阈值，需要确认。',
  needsConfirmation: true,
  confirmation: {
    confirmationId: U.confirmationId,
    summary: '将生成 3 个视频任务，预计 $0.42~$0.60',
    costEstimate: { min: 0.42, max: 0.6, currency: 'USD' },
    operations: agentOperations,
    expiresAt: '2026-08-05T10:05:00.000Z',
  },
  operations: [],
  results: {},
};

// ---------- 01 文档：applyOperations ----------
export const applyOperationsRequest: z.input<typeof ApplyOperationsRequestSchema> = {
  operations: [
    {
      type: 'create_node',
      operationId: U.opNode,
      payload: { nodeType: 'text', position: { x: 100, y: 200 }, size: { x: 240, y: 120 } },
    },
    {
      type: 'create_edge',
      operationId: U.opEdge,
      payload: {
        edgeType: 'input',
        source: { ref: 'node', nodeId: U.selectedNode },
        target: { ref: 'node', nodeId: U.nodeId },
      },
    },
  ],
  baseVersion: 42,
  operationGroupId: U.groupId,
};

export const applyOperationsResponse200: z.input<typeof ApplyOperationsResponseSchema> = {
  appliedOperationIds: [U.opNode, U.opEdge],
  canvasVersion: 43,
};

export const versionConflictResponse = {
  error: { code: 'VERSION_CONFLICT', message: '画布版本已变更', details: null },
  currentVersion: 43,
};

// ---------- 02 文档：签名 URL ----------
export const presignUploadRequest: z.input<typeof PresignUploadRequestSchema> = {
  assetType: 'image',
  mimeType: 'image/png',
  sizeBytes: 2457600,
  width: 1920,
  height: 1080,
  projectId: U.project,
};

export const presignUploadResponse: z.input<typeof PresignUploadResponseSchema> = {
  uploadId: U.uploadId,
  url: 'https://example.supabase.co/storage/v1/object/sign/uploads/3f9c1a2e-8b3d-4e5f-9a6b-2c3d4e5f6a7b/image.png?token=placeholder-signature',
  headers: { 'Content-Type': 'image/png' },
  expiresIn: 900,
  expiresAt: '2026-08-05T10:20:00.000Z',
  // 桶内相对路径（不含 bucket 名）：完整 object key = uploads/3f9c1a2e-.../image.png
  storagePath: `${U.uploadId}/image.png`,
};

export const completeUploadRequest: z.input<typeof CompleteUploadRequestSchema> = {};

export const completeUploadResponse: z.input<typeof CompleteUploadResponseSchema> = {
  assetId: U.assetId,
  storagePath: `${U.uploadId}/image.png`,
  sizeBytes: 2457600,
  contentHash: 'sha256:9f2c4e6a8b0d1c3e5f7a9b2d4c6e8a0f9f2c4e6a8b0d1c3e5f7a9b2d4c6e8a0f',
  alreadyCompleted: false,
  contentDuplicateOfAssetId: null,
};

// ---------- 终审阻塞项 #1：完整响应 / 确认 / complete 请求示例 ----------

/** confirmation accept 请求（Idempotency-Key 走 header，body 无业务字段） */
export const confirmationAcceptRequest: z.input<typeof ConfirmationAcceptRequestSchema> = {};
/** accept 幂等键示例（header 值，必须合法 UUID） */
export const idempotencyKey = 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb';

/** accept 响应 = 200 结构（同步事务完成 + 真实 results） */
export const confirmationAcceptResponse = agentCommandResponse200;

/** 含非 create_* 操作的 200 响应示例：move_nodes 返回 ack（v1.4 新增） */
export const agentCommandResponse200Mixed: z.input<typeof AgentCommandResponseSchema> = {
  message: '将选中节点上移。',
  needsConfirmation: false,
  confirmation: null,
  operations: [
    {
      type: 'move_nodes',
      operationId: U.opNode,
      payload: { nodeIds: [U.selectedNode], delta: { x: 0, y: -80 } },
    },
  ],
  results: {
    [U.opNode]: { type: 'ack' },
  },
};

// ---------- 03 文档：Job 状态事件 ----------
export const jobStatusEvents: z.input<typeof JobStatusEventSchema>[] = [
  { type: 'job.queued', jobId: U.jobId },
  { type: 'job.running', jobId: U.jobId },
  { type: 'job.cancel_requested', jobId: U.jobId },
  { type: 'job.succeeded', jobId: U.jobId, assetIds: [U.assetId] },
  { type: 'job.failed', jobId: U.jobId, errorCode: 'PROVIDER_TIMEOUT', errorMessage: '供应商超时' },
  { type: 'job.cancelled', jobId: U.jobId },
];
