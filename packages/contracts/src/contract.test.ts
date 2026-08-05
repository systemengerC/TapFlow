/**
 * 契约测试：文档示例必须全部通过 safeParse；非法/旧版示例必须全部失败。
 * 运行：npm test（node --test src/contract.test.ts，Node ≥ 23.6 原生 TS type stripping）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentCommandRequestSchema,
  CanvasOperationSchema,
  ClientOperationSchema,
  ApplyOperationsRequestSchema,
  ApplyOperationsResponseSchema,
  ErrorResponseSchema,
  PresignUploadRequestSchema,
  PresignUploadResponseSchema,
  CompleteUploadRequestSchema,
  CompleteUploadResponseSchema,
  AgentCommandResponseSchema,
  OperationResultSchema,
  ConfirmationAcceptRequestSchema,
  ConfirmationRejectRequestSchema,
  ConfirmationAcceptResponseSchema,
  IdempotencyKeySchema,
  AgentOperationsBatchSchema,
  JobStatusEventSchema,
  SelectionRefSchema,
  JsonSchema,
} from './schemas.ts';
import {
  agentCommandRequest,
  agentOperations,
  agentCommandResponse200,
  agentCommandResponse200Mixed,
  agentCommandResponse202,
  applyOperationsRequest,
  applyOperationsResponse200,
  versionConflictResponse,
  presignUploadRequest,
  presignUploadResponse,
  completeUploadRequest,
  completeUploadResponse,
  confirmationAcceptRequest,
  confirmationAcceptResponse,
  idempotencyKey,
  jobStatusEvents,
  U,
} from './examples.ts';

// ---------- 正向：文档示例必须全部 safeParse 通过 ----------
test('01: AgentCommandRequest 示例通过', () => {
  const r = AgentCommandRequestSchema.safeParse(agentCommandRequest);
  assert.equal(r.success, true, JSON.stringify(r.success === false ? r.error.issues : null));
});

test('01: AgentCommand 200 响应中的每个 CanvasOperation 示例通过', () => {
  for (const op of agentOperations) {
    const r = CanvasOperationSchema.safeParse(op);
    assert.equal(r.success, true, `operation ${op.operationId}: ${r.success === false ? JSON.stringify(r.error.issues) : ''}`);
  }
});

test('01: agentCommandResponse200/202 结构示例通过（operations/results）', () => {
  const r200 = CanvasOperationSchema.array().safeParse(agentCommandResponse200.operations);
  assert.equal(r200.success, true);
  for (const [operationId, result] of Object.entries(agentCommandResponse200.results)) {
    assert.ok(Uuid(operationId));
    const res = result as Record<string, unknown>;
    assert.ok(Uuid((res.jobId ?? res.nodeId ?? res.edgeId ?? '') as string), `results 必须返回合法 UUID: ${JSON.stringify(result)}`);
  }
  const r202 = CanvasOperationSchema.array().safeParse(agentCommandResponse202.confirmation.operations);
  assert.equal(r202.success, true);
  assert.equal(agentCommandResponse202.confirmation.confirmationId, U.confirmationId);
});

test('01: applyOperations 请求/响应/409 示例通过', () => {
  const req = ApplyOperationsRequestSchema.safeParse(applyOperationsRequest);
  assert.equal(req.success, true, req.success === false ? JSON.stringify(req.error.issues) : '');
  const res = ApplyOperationsResponseSchema.safeParse(applyOperationsResponse200);
  assert.equal(res.success, true);
  const err = ErrorResponseSchema.safeParse(versionConflictResponse);
  assert.equal(err.success, true);
});

test('02: presign 请求/响应示例通过', () => {
  const req = PresignUploadRequestSchema.safeParse(presignUploadRequest);
  assert.equal(req.success, true, req.success === false ? JSON.stringify(req.error.issues) : '');
  const res = PresignUploadResponseSchema.safeParse(presignUploadResponse);
  assert.equal(res.success, true, res.success === false ? JSON.stringify(res.error.issues) : '');
});

test('02: complete 响应示例通过（含拆分后的 alreadyCompleted/contentDuplicateOfAssetId）', () => {
  const r = CompleteUploadResponseSchema.safeParse(completeUploadResponse);
  assert.equal(r.success, true, r.success === false ? JSON.stringify(r.error.issues) : '');
});

test('03: JobStatusEvent 示例全部通过（jobId 均为合法 UUID）', () => {
  for (const evt of jobStatusEvents) {
    const r = JobStatusEventSchema.safeParse(evt);
    assert.equal(r.success, true, `${evt.type}: ${r.success === false ? JSON.stringify(r.error.issues) : ''}`);
  }
});

// ---------- 终审阻塞项 #1：完整响应 / 确认 / complete / 批次语义（正向） ----------
test('01: AgentCommandResponseSchema 完整校验 200（已执行）与 202（仅预览）', () => {
  const r200 = AgentCommandResponseSchema.safeParse(agentCommandResponse200);
  assert.equal(r200.success, true, r200.success === false ? JSON.stringify(r200.error.issues) : '');
  const r202 = AgentCommandResponseSchema.safeParse(agentCommandResponse202);
  assert.equal(r202.success, true, r202.success === false ? JSON.stringify(r202.error.issues) : '');
});

test('01: results 的每条记录必须通过 OperationResultSchema（真实 jobId/nodeId/edgeId 为 UUID）', () => {
  for (const [operationId, result] of Object.entries(agentCommandResponse200.results)) {
    assert.ok(Uuid(operationId), `results key 必须为合法 UUID: ${operationId}`);
    const r = OperationResultSchema.safeParse(result);
    assert.equal(r.success, true, `${operationId}: ${r.success === false ? JSON.stringify(r.error.issues) : ''}`);
  }
});

test('01: confirmation accept/reject 请求与幂等键通过（Idempotency-Key 为 UUID）', () => {
  const accept = ConfirmationAcceptRequestSchema.safeParse(confirmationAcceptRequest);
  assert.equal(accept.success, true);
  const reject = ConfirmationRejectRequestSchema.safeParse({});
  assert.equal(reject.success, true);
  const key = IdempotencyKeySchema.safeParse(idempotencyKey);
  assert.equal(key.success, true, 'Idempotency-Key 必须为合法 UUID');
  const acceptRes = ConfirmationAcceptResponseSchema.safeParse(confirmationAcceptResponse);
  assert.equal(acceptRes.success, true, acceptRes.success === false ? JSON.stringify(acceptRes.error.issues) : '');
});

test('02: complete 请求示例通过（幂等由 uploadId 绑定，body 无业务字段）', () => {
  const r = CompleteUploadRequestSchema.safeParse(completeUploadRequest);
  assert.equal(r.success, true);
});

test('01: AgentOperationsBatchSchema 正例通过（jobRef→create_job、edge→create_node、同批引用）', () => {
  const r = AgentOperationsBatchSchema.safeParse(agentOperations);
  assert.equal(r.success, true, r.success === false ? JSON.stringify(r.error.issues) : '');
});

// ---------- v1.4：完整响应全路径批次校验 / 一一对应 / 类型匹配 / ack（正向） ----------
test('01: 含非 create_* 操作的 200 响应通过（move_nodes → ack result）', () => {
  const r = AgentCommandResponseSchema.safeParse(agentCommandResponse200Mixed);
  assert.equal(r.success, true, r.success === false ? JSON.stringify(r.error.issues) : '');
});

// ---------- 反向：非法/旧版示例必须全部失败 ----------
test('REJ-1: 客户端提交 PlanningRef（operation_result）必须失败', () => {
  const clientOp = {
    type: 'create_edge',
    operationId: U.opEdge,
    payload: {
      edgeType: 'input',
      source: { ref: 'node', nodeId: U.selectedNode },
      target: { ref: 'operation_result', operationId: U.opNode },
    },
  };
  const r = ClientOperationSchema.safeParse(clientOp);
  assert.equal(r.success, false, '客户端 create_edge 携带 operation_result 应被拒绝');
});

test('REJ-2: selection 引用多节点必须失败（EXPAND_SELECTION_REQUIRED）', () => {
  const r = SelectionRefSchema.safeParse({ ref: 'selection', nodeIds: [U.selectedNode, U.nodeId] });
  assert.equal(r.success, false, 'selection 引用 nodeIds.length > 1 应被拒绝');
});

test('REJ-3: 字符串 "previous" jobRef 必须失败（v1.2 已废弃）', () => {
  const op = {
    type: 'create_node',
    operationId: U.opNode,
    payload: { nodeType: 'generation_job', jobRef: 'previous' },
  };
  const r = CanvasOperationSchema.safeParse(op);
  assert.equal(r.success, false, '字符串 previous 引用应被拒绝');
});

test('REJ-4: 非合法 UUID（旧示例 job-0000...）必须失败', () => {
  const r = CanvasOperationSchema.safeParse({
    type: 'create_job',
    operationId: U.opJob,
    payload: { jobType: 'image_to_video', inputNodeIds: [U.selectedNode], model: 'openai/sora', params: {} },
  });
  assert.equal(r.success, true, 'operationId 合法时应通过');
  const bad = AgentCommandRequestSchema.safeParse({
    ...agentCommandRequest,
    clientRequestId: 'job-00000000-0000-4000-8000-000000000001',
  });
  assert.equal(bad.success, false, '非 UUID 的 clientRequestId 应被拒绝');
});

test('REJ-5: 旧版 create_edge（sourceNodeId/targetNodeId 字段）必须失败', () => {
  const oldEdge = {
    type: 'create_edge',
    operationId: U.opEdge,
    payload: { edgeType: 'input', sourceNodeId: U.selectedNode, targetNodeId: U.nodeId },
  };
  const r = CanvasOperationSchema.safeParse(oldEdge);
  assert.equal(r.success, false, '旧版 sourceNodeId/targetNodeId 字段应被拒绝');
});

test('REJ-6: complete 响应携带旧版 duplicate 布尔必须失败', () => {
  const r = CompleteUploadResponseSchema.safeParse({
    ...completeUploadResponse,
    duplicate: false,
  });
  assert.equal(r.success, false, '旧版 duplicate 字段应被拒绝（已拆分）');
});

test('REJ-7: 客户端 create_node 携带 jobRef 必须失败（PlanningRef 仅服务端链路）', () => {
  const r = ApplyOperationsRequestSchema.safeParse({
    ...applyOperationsRequest,
    operations: [
      {
        type: 'create_node',
        operationId: U.opNode,
        payload: { nodeType: 'generation_job', jobRef: { ref: 'operation_result', operationId: U.opJob } },
      },
    ],
  });
  assert.equal(r.success, false, '客户端 create_node 携带 jobRef 应被拒绝');
});

// ---------- 终审阻塞项 #3：批次级语义校验（反向） ----------
test('REJ-8: jobRef 指向本批不存在的 operationId 必须失败', () => {
  const ops = [
    {
      type: 'create_node',
      operationId: U.opNode,
      payload: { nodeType: 'generation_job', jobRef: { ref: 'operation_result', operationId: U.opJob } },
    },
  ];
  const r = AgentOperationsBatchSchema.safeParse(ops);
  assert.equal(r.success, false, 'jobRef 指向批次外 operationId 应被拒绝');
});

test('REJ-9: jobRef 指向 create_node（而非 create_job）必须失败', () => {
  const ops = [
    { type: 'create_node', operationId: U.opNodeA, payload: { nodeType: 'text' } },
    {
      type: 'create_node',
      operationId: U.opNodeB,
      payload: { nodeType: 'generation_job', jobRef: { ref: 'operation_result', operationId: U.opNodeA } },
    },
  ];
  const r = AgentOperationsBatchSchema.safeParse(ops);
  assert.equal(r.success, false, 'jobRef 必须指向 create_job，指向 create_node 应被拒绝');
});

test('REJ-10: edge 的 operation_result 指向 create_job（而非 create_node）必须失败', () => {
  const ops = [
    { type: 'create_job', operationId: U.opJob, payload: { jobType: 'image_to_video', inputNodeIds: [U.selectedNode], model: 'openai/sora', params: {} } },
    {
      type: 'create_edge',
      operationId: U.opEdge,
      payload: { edgeType: 'input', source: { ref: 'node', nodeId: U.selectedNode }, target: { ref: 'operation_result', operationId: U.opJob } },
    },
  ];
  const r = AgentOperationsBatchSchema.safeParse(ops);
  assert.equal(r.success, false, 'edge 的 operation_result 必须指向 create_node，指向 create_job 应被拒绝');
});

test('REJ-11: edge 的 operation_result 指向批次外 operationId 必须失败', () => {
  const ops = [
    { type: 'create_node', operationId: U.opNode, payload: { nodeType: 'text' } },
    {
      type: 'create_edge',
      operationId: U.opEdge,
      payload: { edgeType: 'input', source: { ref: 'node', nodeId: U.selectedNode }, target: { ref: 'operation_result', operationId: '99999999-8888-7777-6666-555555555555' } },
    },
  ];
  const r = AgentOperationsBatchSchema.safeParse(ops);
  assert.equal(r.success, false, 'edge 引用批次外 operationId 应被拒绝');
});

test('REJ-12: 200 响应携带非空 confirmation 必须失败（needsConfirmation=false 语义）', () => {
  const r = AgentCommandResponseSchema.safeParse({
    ...agentCommandResponse200,
    confirmation: { confirmationId: U.confirmationId, summary: 'x', costEstimate: { min: 0.1, max: 0.2, currency: 'USD' }, operations: [], expiresAt: '2026-08-05T10:05:00.000Z' },
  });
  assert.equal(r.success, false, 'needsConfirmation=false 时 confirmation 非空应被拒绝');
});

test('REJ-13: 202 响应携带非空 operations/results 必须失败（仅预览语义）', () => {
  const r = AgentCommandResponseSchema.safeParse({
    ...agentCommandResponse202,
    operations: agentOperations,
  });
  assert.equal(r.success, false, 'needsConfirmation=true 时 operations 非空应被拒绝');
});

test('REJ-14: storagePath 含 uploads/ 前缀必须失败（桶内相对路径语义）', () => {
  const r = PresignUploadResponseSchema.safeParse({
    ...presignUploadResponse,
    storagePath: `uploads/${U.uploadId}/image.png`,
  });
  assert.equal(r.success, false, 'storagePath 必须为桶内相对路径（不含 bucket 名）');
});

// ---------- v1.4 终审阻塞项反向测试：全路径批次语义 / 一一对应 / 类型匹配 / 非空 / 256KB / JSON ----------
test('REJ-15: 200 响应 operations 含跨批非法引用必须失败（批次语义全路径接入）', () => {
  const r = AgentCommandResponseSchema.safeParse({
    ...agentCommandResponse200,
    operations: [
      {
        type: 'create_node',
        operationId: U.opNode,
        payload: { nodeType: 'generation_job', jobRef: { ref: 'operation_result', operationId: U.opJob } },
      },
    ],
    results: { [U.opNode]: { type: 'create_node', nodeId: U.nodeId } },
  });
  assert.equal(r.success, false, '200 响应中 jobRef 指向批次外 operationId 应被拒绝');
});

test('REJ-16: 200 响应重复 operationId 必须失败', () => {
  const r = AgentCommandResponseSchema.safeParse({
    ...agentCommandResponse200,
    operations: [
      { type: 'create_node', operationId: U.opNode, payload: { nodeType: 'text' } },
      { type: 'create_node', operationId: U.opNode, payload: { nodeType: 'text' } },
    ],
    results: { [U.opNode]: { type: 'create_node', nodeId: U.nodeId } },
  });
  assert.equal(r.success, false, '200 响应中重复 operationId 应被拒绝');
});

test('REJ-17: 200 响应 results 缺少某 operation 的 result 必须失败（一一对应）', () => {
  const r = AgentCommandResponseSchema.safeParse({
    ...agentCommandResponse200,
    results: {
      [U.opJob]: { type: 'create_job', jobId: U.jobId },
      [U.opNode]: { type: 'create_node', nodeId: U.nodeId },
      // 缺少 opEdge 的 result
    },
  });
  assert.equal(r.success, false, 'results 缺少 operation 的 result 应被拒绝');
});

test('REJ-18: 200 响应 results 多余 key 必须失败（一一对应）', () => {
  const r = AgentCommandResponseSchema.safeParse({
    ...agentCommandResponse200,
    results: {
      ...agentCommandResponse200.results,
      [U.edgeId]: { type: 'create_edge', edgeId: U.edgeId },
    },
  });
  assert.equal(r.success, false, 'results 出现 operations 之外的 key 应被拒绝');
});

test('REJ-19: 200 响应 result 类型与 operation 类型不匹配必须失败', () => {
  const r = AgentCommandResponseSchema.safeParse({
    ...agentCommandResponse200,
    results: {
      [U.opJob]: { type: 'create_job', jobId: U.jobId },
      // opNode 是 create_node，返回 create_job 类型
      [U.opNode]: { type: 'create_job', jobId: U.jobId },
      [U.opEdge]: { type: 'create_edge', edgeId: U.edgeId },
    },
  });
  assert.equal(r.success, false, 'result 类型与 operation 类型不匹配应被拒绝');
});

test('REJ-20: create_* 操作返回 ack 必须失败（必须返回真实 ID）', () => {
  const r = AgentCommandResponseSchema.safeParse({
    ...agentCommandResponse200,
    results: {
      [U.opJob]: { type: 'ack' },
      [U.opNode]: { type: 'create_node', nodeId: U.nodeId },
      [U.opEdge]: { type: 'create_edge', edgeId: U.edgeId },
    },
  });
  assert.equal(r.success, false, 'create_job 返回 ack 应被拒绝');
});

test('REJ-21: 空的"已执行"200 响应必须失败（needsConfirmation=false 不得为空）', () => {
  const r = AgentCommandResponseSchema.safeParse({
    message: '无事发生',
    needsConfirmation: false,
    confirmation: null,
    operations: [],
    results: {},
  });
  assert.equal(r.success, false, '已执行响应 operations 为空应被拒绝');
});

test('REJ-22: 202 的 confirmation.operations 含非法批次引用必须失败', () => {
  const r = AgentCommandResponseSchema.safeParse({
    ...agentCommandResponse202,
    confirmation: {
      ...agentCommandResponse202.confirmation,
      operations: [
        {
          type: 'create_node',
          operationId: U.opNode,
          payload: { nodeType: 'generation_job', jobRef: { ref: 'operation_result', operationId: U.opJob } },
        },
      ],
    },
  });
  assert.equal(r.success, false, 'confirmation.operations 中 jobRef 指向批次外应被拒绝');
});

test('REJ-23: 请求体超过 256KB 必须失败（UTF-8 字节）', () => {
  const big = 'x'.repeat(300 * 1024);
  const r = AgentCommandRequestSchema.safeParse({
    ...agentCommandRequest,
    preferences: { defaultVideoModel: big },
  });
  assert.equal(r.success, false, '请求体超过 256KB 应被拒绝');
});

test('REJ-24: JsonSchema 拒绝非 JSON 值（undefined）', () => {
  const r = JsonSchema.safeParse(undefined);
  assert.equal(r.success, false, 'undefined 非 JSON 可序列化值应被拒绝');
});

test('REJ-25: JsonSchema 按 UTF-8 字节数限制（多字节字符超 100KB 拒绝）', () => {
  // 5 万个中文字符：UTF-8 约 150KB > 100KB，但字符数仅 50k < 100k
  const big = '中'.repeat(50_000);
  const r = JsonSchema.safeParse(big);
  assert.equal(r.success, false, 'JSON 字段按 UTF-8 字节数应超过 100KB 限制');
});

test('REJ-26: JsonSchema 拒绝 NaN', () => {
  const r = JsonSchema.safeParse(NaN);
  assert.equal(r.success, false, 'NaN 不是 JSON 值应被拒绝');
});

test('REJ-27: JsonSchema 拒绝 Infinity', () => {
  const r = JsonSchema.safeParse(Infinity);
  assert.equal(r.success, false, 'Infinity 不是 JSON 值应被拒绝');
});

test('REJ-28: JsonSchema 拒绝嵌套 undefined（{ a: undefined }）', () => {
  const r = JsonSchema.safeParse({ a: undefined });
  assert.equal(r.success, false, '嵌套 undefined 会被 JSON.stringify 静默丢弃，必须显式拒绝');
});

test('REJ-29: JsonSchema 拒绝 Date 实例', () => {
  const r = JsonSchema.safeParse(new Date('2026-08-05T00:00:00Z'));
  assert.equal(r.success, false, 'Date 不是声明的 JSON 数据结构应被拒绝');
});

test('REJ-30: JsonSchema 拒绝 Map / Set', () => {
  assert.equal(JsonSchema.safeParse(new Map([['k', 'v']])).success, false, 'Map 应被拒绝');
  assert.equal(JsonSchema.safeParse(new Set([1, 2])).success, false, 'Set 应被拒绝');
});

test('REJ-31: JsonSchema 拒绝循环引用', () => {
  const a: Record<string, unknown> = {};
  a.self = a;
  assert.equal(JsonSchema.safeParse(a).success, false, '循环引用应被拒绝');
});

test('REJ-32: JsonSchema 拒绝 bigint / function / symbol', () => {
  assert.equal(JsonSchema.safeParse(1n).success, false, 'bigint 应被拒绝');
  assert.equal(JsonSchema.safeParse(() => 1).success, false, 'function 应被拒绝');
  assert.equal(JsonSchema.safeParse(Symbol('s')).success, false, 'symbol 应被拒绝');
});

test('POS-13: JsonSchema 接受合法 JSON 值（含 DAG 共享引用）', () => {
  const shared = { tag: 'shared' };
  const dag = { a: shared, b: shared, arr: [null, true, false, 42, 'str', [1, 2], { deep: 'ok' }] };
  const r = JsonSchema.safeParse(dag);
  assert.equal(r.success, true, '合法 JSON 值（含重复引用但无环）应通过');
});

function Uuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
