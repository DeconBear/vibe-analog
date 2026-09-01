# actoviq-agent-sdk 0.4.22 集成问题

本文记录本项目从 `actoviq-agent-sdk@0.4.7` 升级到 `0.4.22`（npm 包已更名 Hadamard，类型前缀 `Actoviq*` → `Hadamard*`）后的集成测试结论。测试基线为 Node.js 22.20.0。

## 1. `validateInput` 未在本地工具执行链中调用（0.4.7 已有，仍未修复）

- 严重度：高
- 现象：`tool()` 定义的 `validateInput` 存在于公开类型中，但 `createLocalToolAdapter().execute()` 仍仅执行 schema parse、tool execute 和 output parse。
- 影响：依赖 `validateInput` 的能力、安全或业务门禁在真实 tool loop 中不会生效。
- 本项目绕过：`view_schematic_for_layout` 在 `execute` 首行重复执行视觉能力硬校验；`validateInput` 仅保留为前置提示和未来兼容。

## 2. OpenAI 兼容适配器丢弃 tool-result 中的图片（0.4.7 已有，仍未修复）

- 严重度：高
- 现象：Anthropic 风格 `tool_result.content` 为数组时，OpenAI 适配器（`openai-model-api.js`）只连接其中的 `text`，忽略 `image` block。
- 影响：工具虽然成功返回 PNG，OpenAI/DeepSeek 兼容视觉模型的下一轮请求仍看不到图片。
- 本项目绕过：注入项目侧 `ModelApi` 包装器（`src/vision/openAiVisionModelApi.ts`），把 tool-result 内的图片提升为紧随其后的独立 `user` 图片消息，再委托 SDK OpenAI adapter。

## 3. skill 的 `allowedTools` 不会过滤有效工具目录（0.4.7 已有，语义未变）

- 严重度：中高
- 现象：agent 的 `allowedTools` 会参与工具过滤，而 skill 的同名字段只生成 allow permission；skill 仍默认继承 SDK 默认工具。
- 本项目绕过：视觉 skill 显式设置 `inheritDefaultTools: false`，并只注册 `view_schematic_for_layout`；质量报告由 host 嵌入 stage packet。

## 4. ~~`maxToolIterations: 0` 不能覆盖非零全局值~~ （0.4.21 已修复）

- 现象：运行时已改用 `?? options.maxToolIterations`（`agentClient.js`），`0` 现在可以正确覆盖全局非零值。
- 本项目处理：报告 agent 继续保留 `maxToolIterations: 0` + `inheritDefaultTools: false` 双保险。

## 5. 空工具数组仍会继承默认工具（0.4.7 已有，语义未变）

- 现象：`tools: []` 表示"不追加工具"，不是"没有工具"；只有 `inheritDefaultTools: false` 才能关闭继承。
- 本项目处理：所有内置无工具 agent 都建立专用 profile，并设置 `inheritDefaultTools: false`。

## 6. provider 错误原文被持久化到 agent-executions 审计存储（0.4.21 首次发现，0.4.22 仍存在）

- 严重度：高（凭据卫生）
- 现象：SDK 把每次 run 的原始 error 事件（含 provider 响应正文）写入 `<sessionDirectory>/agent-executions/<sessionId>.json`。部分代理/网关会在 4xx 文本里回显 Authorization 头或 api key，密钥随之落盘且不会清理。
- 影响：本地磁盘残留明文凭据；`~/.hadamard` 或自定义 homeDir 下的审计文件长期保留。
- 本项目绕过：`electron/agent/sanitizedModelApi.ts` 在 `ModelApi` 边界包装 provider 调用，把抛出的错误消息中的 `sk-/ark-/ak-` 前缀令牌、`bearer` 头和 `api_key=` 形态的键值先脱敏再交给 SDK。
- SDK 建议：`recordRuntimeEvent` 落盘前对 error.message 复用 `redactMemorySecrets` 同款（或更强、含 ark 前缀）的脱敏。

## 7. CodeAct 外层 CodeCell 调用在 default 权限模式下被拒（0.4.21 首次发现，0.4.22 仍存在）

- 严重度：中（对嵌入式 CodeAct 是阻断性的）
- 现象：SDK 内置 `CodeCell` 工具声明 `isDestructive: () => true`；`decideHadamardToolPermission` 在 `permissionMode: 'default'` 且未配置 `approver` 时直接拒绝所有 destructive 工具，错误文本为 "default mode requires approval for mutating tools, but no approver is available."。桌面端没有交互式 approver，CodeAct 主循环第一步即失败。
- 本项目绕过：`createAgentSdk` 传入 `permissions: [{ toolName: '*', behavior: 'allow' }]`。安全模型不受影响：工具目录由 `allowedTools` 白名单约束，且电路变更审批仍由 `apply_circuit_command` 的 pending-stage 事务（approvalPolicy=manual）承担。
- SDK 建议：为嵌入式 CodeAct 提供 `approver` 之外的显式声明开关（如 agent 定义级 `actionSpaceApproval: 'auto'`），或在 CodeCell 文档中说明必须搭配 approver/allow 规则。

## 8. CodeAct host 子调用的事件形状与原生 ReAct 不一致（0.4.21 首次发现，0.4.22 仍存在）

- 严重度：低（文档/易用性）
- 现象：从 Python cell 发起 host 工具调用时，嵌套执行器只发 `tool.call`（不发 `tool.result`）；结果侧由 `tool.code_dispatch`（phase=settle）事件承载，其 `summary` 上限 240 字符。外层 CodeCell 自身的 `tool.result` 是序列化的 cell JSON。
- 影响：宿主要正确渲染进度需要同时处理三种事件；`project_id` 之类需要从截断 summary 里解析。
- 本项目处理：`desktopAgentService.ts` 把嵌套 `tool.call` 映射为 UI tool-call、`tool.code_dispatch` settle 映射为 UI tool-result，并跳过 CodeCell 自身的 `tool.result`。
- SDK 建议：让嵌套调用补发 `tool.result`，或在文档中明确 CodeAct 事件协议。

## 建议加入 SDK 的验收测试

1. `validateInput` 拒绝后 tool execute 和 provider 后续轮次均不得发生。
2. OpenAI 两轮工具调用中，第二轮同时包含原 tool call 结果及可解码的 PNG `image_url`。
3. skill 设置工具白名单后，有效 provider tools 必须与白名单完全一致。
4. agent 的 `maxToolIterations: 0` 必须覆盖全局非零值。（0.4.21 已具备行为）
5. `tools: []`、`inheritDefaultTools: false` 及两者组合的工具目录快照测试。
6. provider 401 响应正文回显密钥时，agent-executions 落盘文件不得包含该密钥。
7. 无 approver 的 `permissionMode: 'default'` + `agentMode: 'codeact'` 组合下，CodeCell 能执行（或给出可操作的配置错误）。
