# @tapflow/contracts

TapFlow 契约单一事实源（Design Frozen v1.4，Implementation Frozen 待 gpt 复验）。

## 用法

前端/后端统一从包名导入，禁止各自定义重复类型：

```ts
import {
  AgentCommandRequestSchema,        // 校验 Agent 命令请求
  AgentCommandResponseSchema,       // 校验 200/202/accept 响应
  CanvasOperationSchema,            // 画布操作（服务端完整版）
  ClientOperationSchema,            // 画布操作（客户端提交版）
  AgentOperationsBatchSchema,       // 批次语义校验（jobRef/edge 引用必须指向本批）
  OperationResultSchema,            // 操作结果（jobId/nodeId/edgeId）
  PresignUploadRequestSchema,       // 上传预签名请求
  CompleteUploadRequestSchema,      // 上传完成请求
  JobStatusEventSchema,             // Job 状态事件
} from '@tapflow/contracts';

// 类型（从 Schema 推导）
import type {
  CanvasOperation, ClientOperation, OperationResult,
  AgentCommandRequest, AgentCommandResponse,
  PresignUploadRequest, CompleteUploadResponse,
  JobStatus, JobStatusEvent, ErrorResponse,
} from '@tapflow/contracts';

// 文档示例（契约测试用，也可作前端 mock 数据）
import { agentOperations, agentCommandResponse200 } from '@tapflow/contracts/examples';
```

## 开发

```bash
npm install            # 根目录（workspace）
npm test               # 契约测试（node --test，38 项）
npm run typecheck -w @tapflow/contracts   # tsc --noEmit
```

## 约定

- 版本：`v1.4`（Design Frozen）。变更须升版本号并在 SOP/contracts 对应文档记录。
- 依赖：`zod ^3.25`（已验证环境；**不要升级 zod v4**，API 有破坏性变更）。
- 契约测试失败 = 不能合入；文档示例与 `examples.ts` 必须一致，均由测试强制。
- 语义校验由 `AgentOperationsBatchSchema` 的 superRefine 保证（operationId 唯一、jobRef → 本批 create_job、edge 引用 → 本批 create_node）。
- `AgentCommandResponseSchema` 全路径接入批次语义：200/accept 的 `results` 与 `operations` 一一对应且类型匹配（create_* 返回真实 ID，其余返回 `ack`）；`needsConfirmation=false` 已执行响应不得为空；202 的 `confirmation.operations` 同样校验。
- 请求体上限 256KB（AgentCommand / applyOperations）；`JsonSchema` 按 UTF-8 字节数 ≤ 100KB 且必须为 JSON 可序列化值。
