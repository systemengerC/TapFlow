/**
 * TapFlow Phase 1 — Zod 契约（v1.4 设计冻结基线）
 * 单一事实源目标：packages/contracts；此处为最小可运行验证集。
 * 文档：SOP/contracts/01-AgentCommand-CanvasOperation-API契约.md
 *       SOP/contracts/02-签名URL规范.md
 *       SOP/contracts/03-Job状态转换与错误码.md
 * v1.4 变更（终审阻塞项闭环）：
 *   1. AgentCommandResponseSchema 接入批次语义校验（200/202/accept 全路径）
 *   2. results 与 operations 一一对应；result 类型必须匹配对应操作类型
 *   3. needsConfirmation=false 的已执行响应不得为空
 *   4. JsonSchema 按 UTF-8 字节数计算；拒绝非 JSON 值
 *   5. 请求体 256KB 上限（AgentCommand / applyOperations）
 *   6. 版本标记统一为 v1.4
 */
import { z } from 'zod';

// ---------- 通用约束 ----------
export const UuidSchema = z.string().uuid();

/** UTF-8 字节数；对合法 JSON 值用 JSON.stringify 计算（循环引用已被 isJsonValue 拒绝，不会到达此处） */
function utf8Bytes(v: unknown): number {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? Infinity : new TextEncoder().encode(s).length;
  } catch {
    return Infinity;
  }
}

/** 递归 JSON 值校验：只允许 null / boolean / string / 有限 number / 数组 / 普通对象；
 *  拒绝 undefined / NaN / Infinity / bigint / function / symbol / Date / Map / Set / 类实例 / 循环引用。
 *  通过 seen 集合检测真正的环；同一对象被多次引用（DAG）在递归返回后从 seen 移除，允许通过。 */
function isJsonValue(v: unknown, seen: Set<object> = new Set()): boolean {
  if (v === null) return true;
  if (typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'object') {
    const obj = v as object;
    if (seen.has(obj)) return false; // 循环引用
    seen.add(obj);
    let ok = true;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (!isJsonValue(item, seen)) {
          ok = false;
          break;
        }
      }
    } else {
      const proto = Object.getPrototypeOf(obj);
      if (proto !== Object.prototype && proto !== null) {
        ok = false; // Date / Map / Set / 类实例等
      } else {
        for (const key of Object.keys(obj)) {
          if (!isJsonValue((obj as Record<string, unknown>)[key], seen)) {
            ok = false;
            break;
          }
        }
      }
    }
    seen.delete(obj);
    return ok;
  }
  return false; // undefined / function / symbol / bigint
}

/** Json 字段大小 ≤ 100KB（UTF-8 字节），深度 ≤ 10，且必须是真正的 JSON 值 */
function maxDepth(v: unknown): number {
  if (v === null || typeof v !== 'object') return 0;
  const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
  return 1 + (children.length ? Math.max(...children.map(maxDepth)) : 0);
}
export const JsonSchema = z.unknown().refine(
  (v) => isJsonValue(v) && utf8Bytes(v) <= 100_000 && maxDepth(v) <= 10,
  { message: 'Json 字段必须是 JSON 值（null/boolean/string/有限 number/数组/普通对象），大小 ≤ 100KB（UTF-8 字节），深度 ≤ 10' },
);

export const Vec2Schema = z.object({ x: z.number(), y: z.number() }).strict();

// ---------- 引用类型（阻塞项 #1 修订） ----------
/** 直接引用：画布上已存在的节点（客户端 + 服务端通用） */
export const NodeRefSchema = z.object({ ref: z.literal('node'), nodeId: UuidSchema }).strict();

/** 规划期引用：仅服务端 Agent 链路，事务内解析 */
export const OperationResultRefSchema = z
  .object({ ref: z.literal('operation_result'), operationId: UuidSchema })
  .strict();
export const SelectionRefSchema = z
  .object({ ref: z.literal('selection'), nodeIds: z.array(UuidSchema).max(200) })
  .strict()
  .superRefine((val, ctx) => {
    // 多选展开规则：selection 引用只允许单节点，多选必须由 Agent 显式展开
    if (val.nodeIds.length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'EXPAND_SELECTION_REQUIRED: selection 引用只允许单节点' });
    }
  });

export const PlanningRefSchema = z.union([OperationResultRefSchema, SelectionRefSchema]);

// ---------- 16 种 CanvasOperation（完整版，Agent 链路可用 PlanningRef） ----------
const opBase = { operationId: UuidSchema };

export const CreateEdgePayloadSchema = z.union([
  // 直接引用模式（两侧均为 node）
  z
    .object({
      edgeType: z.enum(['reference', 'input', 'derived_from']),
      source: NodeRefSchema,
      target: NodeRefSchema,
    })
    .strict(),
  // 规划期引用模式（至少一侧为 PlanningRef；SelectionRef 已强制单节点）
  z
    .object({
      edgeType: z.enum(['reference', 'input', 'derived_from']),
      source: z.union([NodeRefSchema, PlanningRefSchema]),
      target: z.union([NodeRefSchema, PlanningRefSchema]),
    })
    .strict()
    .superRefine((val, ctx) => {
      const srcPlan = val.source.ref !== 'node';
      const tgtPlan = val.target.ref !== 'node';
      if (!srcPlan && !tgtPlan) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INVALID_REFERENCE: planning 模式至少一侧为 PlanningRef' });
      }
    }),
]);

export const CanvasOperationSchema = z.discriminatedUnion('type', [
  z.object({ ...opBase, type: z.literal('create_node'), payload: z.object({
    nodeType: z.string().min(1),
    position: Vec2Schema.optional(),
    size: Vec2Schema.optional(),
    data: JsonSchema.optional(),
    parentNodeId: UuidSchema.nullable().optional(),
    jobRef: OperationResultRefSchema.optional(), // 仅 Agent 规划链路；客户端提交拒绝
  }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('update_node'), payload: z.object({ nodeId: UuidSchema, patch: JsonSchema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('delete_node'), payload: z.object({ nodeId: UuidSchema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('move_nodes'), payload: z.object({ nodeIds: z.array(UuidSchema), delta: Vec2Schema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('create_edge'), payload: CreateEdgePayloadSchema }).strict(),
  z.object({ ...opBase, type: z.literal('delete_edge'), payload: z.object({ edgeId: UuidSchema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('create_job'), payload: z.object({
    jobType: z.string().min(1),
    inputNodeIds: z.array(UuidSchema),
    model: z.string().min(1),
    params: JsonSchema,
    capabilityId: UuidSchema.optional(),
  }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('attach_asset'), payload: z.object({ nodeId: UuidSchema, assetId: UuidSchema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('replace_node_asset'), payload: z.object({ nodeId: UuidSchema, assetId: UuidSchema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('resize_nodes'), payload: z.object({ nodeIds: z.array(UuidSchema), size: Vec2Schema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('rotate_nodes'), payload: z.object({ nodeIds: z.array(UuidSchema), rotation: z.number() }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('group_nodes'), payload: z.object({ nodeIds: z.array(UuidSchema) }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('ungroup_nodes'), payload: z.object({ groupNodeId: UuidSchema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('reorder_nodes'), payload: z.object({ nodeIds: z.array(UuidSchema), zIndex: z.number() }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('set_nodes_locked'), payload: z.object({ nodeIds: z.array(UuidSchema), locked: z.boolean() }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('set_viewport'), payload: z.object({ viewport: JsonSchema }).strict() }).strict(),
]);

// ---------- 客户端提交版（applyOperations）：仅直接引用模式 ----------
/** 客户端 create_edge：两侧必须 node 引用 */
export const ClientCreateEdgePayloadSchema = z
  .object({
    edgeType: z.enum(['reference', 'input', 'derived_from']),
    source: NodeRefSchema,
    target: NodeRefSchema,
  })
  .strict();
/** 客户端 create_node：禁止 jobRef（PlanningRef 仅服务端链路） */
export const ClientCreateNodePayloadSchema = z.object({
  nodeType: z.string().min(1),
  position: Vec2Schema.optional(),
  size: Vec2Schema.optional(),
  data: JsonSchema.optional(),
  parentNodeId: UuidSchema.nullable().optional(),
}).strict();

export const ClientOperationSchema = z.discriminatedUnion('type', [
  z.object({ ...opBase, type: z.literal('create_node'), payload: ClientCreateNodePayloadSchema }).strict(),
  z.object({ ...opBase, type: z.literal('update_node'), payload: z.object({ nodeId: UuidSchema, patch: JsonSchema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('delete_node'), payload: z.object({ nodeId: UuidSchema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('move_nodes'), payload: z.object({ nodeIds: z.array(UuidSchema), delta: Vec2Schema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('create_edge'), payload: ClientCreateEdgePayloadSchema }).strict(),
  z.object({ ...opBase, type: z.literal('delete_edge'), payload: z.object({ edgeId: UuidSchema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('create_job'), payload: z.object({
    jobType: z.string().min(1),
    inputNodeIds: z.array(UuidSchema),
    model: z.string().min(1),
    params: JsonSchema,
    capabilityId: UuidSchema.optional(),
  }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('attach_asset'), payload: z.object({ nodeId: UuidSchema, assetId: UuidSchema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('replace_node_asset'), payload: z.object({ nodeId: UuidSchema, assetId: UuidSchema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('resize_nodes'), payload: z.object({ nodeIds: z.array(UuidSchema), size: Vec2Schema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('rotate_nodes'), payload: z.object({ nodeIds: z.array(UuidSchema), rotation: z.number() }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('group_nodes'), payload: z.object({ nodeIds: z.array(UuidSchema) }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('ungroup_nodes'), payload: z.object({ groupNodeId: UuidSchema }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('reorder_nodes'), payload: z.object({ nodeIds: z.array(UuidSchema), zIndex: z.number() }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('set_nodes_locked'), payload: z.object({ nodeIds: z.array(UuidSchema), locked: z.boolean() }).strict() }).strict(),
  z.object({ ...opBase, type: z.literal('set_viewport'), payload: z.object({ viewport: JsonSchema }).strict() }).strict(),
]);

// ---------- 请求 / 响应 ----------
export const AgentCommandRequestSchema = z
  .object({
    projectId: UuidSchema,
    command: z.string().min(1).max(4000),
    selection: z
      .object({
        nodeIds: z.array(UuidSchema).max(200).default([]),
        explicitReferenceNodeIds: z.array(UuidSchema).max(200).default([]),
        viewportCenter: z.object({ x: z.number(), y: z.number() }).optional(),
      })
      .strict()
      .optional(),
    preferences: z
      .object({
        defaultVideoModel: z.string().optional(),
        defaultImageModel: z.string().optional(),
        aspectRatio: z.string().regex(/^\d+:\d+$/).optional(),
      })
      .strict()
      .optional(),
    clientRequestId: UuidSchema,
  })
  .strict()
  .superRefine((val, ctx) => {
    const bytes = utf8Bytes(val);
    if (bytes > 256 * 1024) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `请求体超过 256KB 上限（UTF-8 字节: ${bytes}）` });
    }
  });

export const ApplyOperationsRequestSchema = z
  .object({
    operations: z.array(ClientOperationSchema).min(1).max(200),
    baseVersion: z.number().int(),
    operationGroupId: UuidSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const bytes = utf8Bytes(val);
    if (bytes > 256 * 1024) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `请求体超过 256KB 上限（UTF-8 字节: ${bytes}）` });
    }
  });

export const ApplyOperationsResponseSchema = z.object({
  appliedOperationIds: z.array(UuidSchema),
  canvasVersion: z.number().int(),
}).strict();

export const ErrorResponseSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().nullable() }).strict(),
    currentVersion: z.number().int().optional(),
  })
  .strict();

// ---------- 项目（P0：项目列表 / 创建 / 快照加载） ----------
export const ProjectSchema = z
  .object({
    id: UuidSchema,
    name: z.string().min(1).max(200),
    canvasVersion: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const CreateProjectRequestSchema = z
  .object({
    name: z.string().min(1).max(200),
  })
  .strict();

export const CreateProjectResponseSchema = ProjectSchema;

export const ListProjectsResponseSchema = z
  .object({
    projects: z.array(ProjectSchema),
  })
  .strict();

/** 画布快照节点（对应 canvas_nodes 行；client 侧直接消费） */
export const ProjectNodeSnapshotSchema = z
  .object({
    id: UuidSchema,
    nodeType: z.enum(['text', 'image', 'video', 'audio', 'generation_job', 'group', 'document']),
    parentNodeId: UuidSchema.nullable(),
    position: z.object({ x: z.number(), y: z.number() }).nullable(),
    size: z.object({ width: z.number(), height: z.number() }).nullable(),
    data: JsonSchema.nullable(),
    jobId: UuidSchema.nullable(),
  })
  .strict();

/** 画布快照边（对应 canvas_edges 行） */
export const ProjectEdgeSnapshotSchema = z
  .object({
    id: UuidSchema,
    sourceNodeId: UuidSchema,
    targetNodeId: UuidSchema,
    edgeType: z.enum(['reference', 'input', 'derived_from']),
  })
  .strict();

export const ProjectSnapshotResponseSchema = z
  .object({
    project: ProjectSchema,
    nodes: z.array(ProjectNodeSnapshotSchema),
    edges: z.array(ProjectEdgeSnapshotSchema),
  })
  .strict();

// ---------- 签名 URL（02 文档） ----------
export const AssetTypeSchema = z.enum(['image', 'video', 'audio', 'thumbnail', 'document']);

export const PresignUploadRequestSchema = z
  .object({
    assetType: AssetTypeSchema,
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().positive(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    projectId: UuidSchema,
  })
  .strict();

export const PresignUploadResponseSchema = z
  .object({
    uploadId: UuidSchema,
    url: z.string().url(),
    headers: z.record(z.string()),
    expiresIn: z.number().int().positive(),
    expiresAt: z.string().datetime(),
    // storagePath 为桶内相对路径（不含 bucket 名），完整 object key = storage_bucket + '/' + storagePath
    storagePath: z.string().regex(/^[0-9a-f-]{36}\/[^/]+$/),
  })
  .strict();

export const CompleteUploadResponseSchema = z
  .object({
    assetId: UuidSchema,
    storagePath: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    alreadyCompleted: z.boolean(),
    contentDuplicateOfAssetId: UuidSchema.nullable(),
  })
  .strict();

/** 资产读取模型（GET /api/assets/:id 返回）：签名下载 URL 由服务端按需签发，不落库。
 *  url 为前端可直接用于 <img>/<video> 的持久访问地址（私有桶签名 URL 带 token）。 */
export const AssetSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    assetType: AssetTypeSchema,
    /** 由存储路径扩展名推导；未知扩展名按 assetType 给出默认值 */
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
    storagePath: z.string(),
    /** 签名下载 URL（带 token，私有桶可直接访问） */
    url: z.string().url(),
    /** 签名 URL 过期时间；过期后需重新调用 GET /api/assets/:id 获取新 URL */
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const GetAssetResponseSchema = z
  .object({
    asset: AssetSchema,
  })
  .strict();

// ---------- Job 状态事件（03 文档） ----------
export const JobStatusEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('job.queued'), jobId: UuidSchema }).strict(),
  z.object({ type: z.literal('job.running'), jobId: UuidSchema }).strict(),
  z.object({ type: z.literal('job.cancel_requested'), jobId: UuidSchema }).strict(),
  z.object({ type: z.literal('job.succeeded'), jobId: UuidSchema, assetIds: z.array(UuidSchema) }).strict(),
  z.object({ type: z.literal('job.failed'), jobId: UuidSchema, errorCode: z.string(), errorMessage: z.string() }).strict(),
  z.object({ type: z.literal('job.cancelled'), jobId: UuidSchema }).strict(),
]);

export const JobStatusEnum = ['queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled'] as const;
export const JobStatusSchema = z.enum(JobStatusEnum);

export const JobTypeSchema = z.enum(['text_to_image', 'image_to_video', 'text_to_video', 'tts', 'edit_image']);

// ---------- Job API（03 文档 §4 取消流程 / §6 错误码） ----------
export const JobSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    parentJobId: UuidSchema.nullable(),
    attempt: z.number().int().min(1),
    jobType: JobTypeSchema,
    provider: z.string().nullable(),
    model: z.string().min(1),
    params: JsonSchema,
    inputNodeIds: z.array(UuidSchema),
    status: JobStatusSchema,
    providerJobId: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    idempotencyKey: UuidSchema,
    cancelRequestedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const CreateJobRequestSchema = z
  .object({
    projectId: UuidSchema,
    jobType: JobTypeSchema,
    model: z.string().min(1),
    params: JsonSchema,
    inputNodeIds: z.array(UuidSchema).max(50).default([]),
    /** 幂等键（03 契约 §4.3 规则 3）：unique 约束防重复提交，缺省由服务端生成 */
    idempotencyKey: UuidSchema.optional(),
  })
  .strict();

export const CreateJobResponseSchema = z
  .object({
    job: JobSchema,
    /** 是否命中幂等键返回已有 Job（重复提交不产生新 Job） */
    idempotentReplay: z.boolean(),
  })
  .strict();

export const ListJobsResponseSchema = z
  .object({
    jobs: z.array(JobSchema),
  })
  .strict();

/** Job 输出引用（generation_job_outputs 行，按 ordinal 升序）。
 *  仅返回引用，不内嵌短期签名 URL；前端需按 assetId 调用 GET /api/assets/:id 获取下载地址。 */
export const JobOutputRefSchema = z
  .object({
    assetId: UuidSchema,
    ordinal: z.number().int().nonnegative(),
  })
  .strict();

export const GetJobResponseSchema = z
  .object({
    job: JobSchema,
    /** Job 输出资产引用（按 ordinal 升序）；无输出时为空数组 */
    outputs: z.array(JobOutputRefSchema).default([]),
  })
  .strict();

export const CancelJobResponseSchema = z
  .object({
    job: JobSchema,
  })
  .strict();

// ---------- 完整响应 Schema（终审阻塞项 #1：补齐 200/202/accept/reject/complete） ----------

/** 单条操作的真实落库结果：results[operationId] */
export const OperationResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create_job'), jobId: UuidSchema }).strict(),
  z.object({ type: z.literal('create_node'), nodeId: UuidSchema }).strict(),
  z.object({ type: z.literal('create_edge'), edgeId: UuidSchema }).strict(),
  // 非 create_* 操作执行成功无新实体，返回 ack（results key 即 operationId）
  z.object({ type: z.literal('ack') }).strict(),
]);

const ConfirmationSchema = z
  .object({
    confirmationId: UuidSchema,
    summary: z.string(),
    costEstimate: z
      .object({ min: z.number().nonnegative(), max: z.number().nonnegative(), currency: z.string().min(3).max(3) })
      .strict(),
    operations: z.array(CanvasOperationSchema).max(200),
    expiresAt: z.string().datetime(),
  })
  .strict();

/** AgentCommand 响应 200（已执行落库）与 202（预览未执行）共用结构；needsConfirmation 区分 */
export const AgentCommandResponseSchema = z
  .object({
    message: z.string(),
    needsConfirmation: z.boolean(),
    confirmation: ConfirmationSchema.nullable(),
    operations: z.array(CanvasOperationSchema).max(200),
    results: z.record(z.string().uuid(), OperationResultSchema),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.needsConfirmation === false) {
      // 已执行响应：不得为空（阻塞项 #4）
      if (val.operations.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '已执行响应（needsConfirmation=false）operations 不得为空' });
      }
      if (val.confirmation !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'needsConfirmation=false 时 confirmation 必须为 null' });
      }
      // 批次语义校验（阻塞项 #1：200 响应全路径接入 AgentOperationsBatchSchema）
      const batch = AgentOperationsBatchSchema.safeParse(val.operations);
      if (!batch.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `operations 批次语义校验失败: ${JSON.stringify(batch.error.issues)}`,
        });
      }
      // results 与 operations 一一对应（阻塞项 #2）
      const opIds = new Set(val.operations.map((o) => o.operationId));
      const resultKeys = Object.keys(val.results);
      if (resultKeys.length !== opIds.size || resultKeys.some((k) => !opIds.has(k))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'results 必须与 operations 一一对应（key 为 operationId）' });
      }
      // result 类型必须匹配对应操作类型（阻塞项 #3）
      for (const op of val.operations) {
        const result = val.results[op.operationId];
        if (!result) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `缺少 operation ${op.operationId} 的 result` });
          continue;
        }
        if (result.type === 'ack') {
          if (op.type === 'create_job' || op.type === 'create_node' || op.type === 'create_edge') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `operation ${op.operationId}（${op.type}）必须返回真实 ID，不能是 ack`,
            });
          }
        } else if (result.type !== op.type) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `operation ${op.operationId} 类型 ${op.type} 与 result 类型 ${result.type} 不匹配`,
          });
        }
      }
    } else {
      // 202 预览：仅携带 confirmation，operations/results 必须为空（阻塞项 #1：confirmation.operations 也要批次校验）
      if (val.confirmation === null || val.operations.length !== 0 || Object.keys(val.results).length !== 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'needsConfirmation=true 时须携带 confirmation，且 operations/results 为空（仅预览）' });
      }
      if (val.confirmation) {
        const batch = AgentOperationsBatchSchema.safeParse(val.confirmation.operations);
        if (!batch.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `confirmation.operations 批次语义校验失败: ${JSON.stringify(batch.error.issues)}`,
          });
        }
      }
    }
  });

/** 确认接口幂等键：HTTP header `Idempotency-Key`，值必须为 UUID */
export const IdempotencyKeySchema = UuidSchema;

/** confirmation accept 请求体（Idempotency-Key 走 header，body 无业务字段） */
export const ConfirmationAcceptRequestSchema = z.object({}).strict();
/** confirmation reject 请求体 */
export const ConfirmationRejectRequestSchema = z.object({}).strict();
/** accept 响应 = 200 结构（同步事务完成 + 真实 results） */
export const ConfirmationAcceptResponseSchema = AgentCommandResponseSchema;

/** complete 请求体：无业务字段，幂等由 uploadId 绑定（session 已 completed 返回原 assetId） */
export const CompleteUploadRequestSchema = z.object({}).strict();

// ---------- 批次级语义校验（终审阻塞项 #3：跨操作引用必须指向本批且类型匹配） ----------

/**
 * Agent 链路整批 operations 语义校验：
 * 1. operation_result 引用必须指向本批内存在的 operationId（禁止批次外引用）
 * 2. create_node.jobRef 必须指向本批 create_job 操作
 * 3. create_edge 的 source/target 中 operation_result 必须指向本批 create_node 操作
 * 4. operationId 在本批内唯一
 */
export const AgentOperationsBatchSchema = z
  .array(CanvasOperationSchema)
  .min(1)
  .max(200)
  .superRefine((ops, ctx) => {
    const seen = new Set<string>();
    const jobOps = new Set<string>();
    const nodeOps = new Set<string>();
    for (const op of ops) {
      if (seen.has(op.operationId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `DUPLICATE_OPERATION_ID: ${op.operationId}` });
      }
      seen.add(op.operationId);
      if (op.type === 'create_job') jobOps.add(op.operationId);
      if (op.type === 'create_node') nodeOps.add(op.operationId);
    }
    for (const op of ops) {
      if (op.type === 'create_node' && op.payload.jobRef) {
        const ref = op.payload.jobRef.operationId;
        if (!jobOps.has(ref)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `INVALID_REFERENCE: jobRef(${ref}) 必须指向本批 create_job 操作`,
          });
        }
      }
      if (op.type === 'create_edge') {
        for (const side of [op.payload.source, op.payload.target]) {
          if (side.ref === 'operation_result') {
            if (!nodeOps.has(side.operationId)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `INVALID_REFERENCE: edge 引用(${side.operationId}) 必须指向本批 create_node 操作`,
              });
            }
          }
        }
      }
    }
  });
