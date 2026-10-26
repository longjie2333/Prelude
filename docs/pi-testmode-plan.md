# pi-testmode 开发计划

> **依据**：[agent-core.md](agent-core.md) v0.2（设计）＋ pi 1.4.0 实测（`@earendil-works/*`）
> **用途**：交接给实施模型。按 M1 → M2 → M3 顺序推进，每个里程碑验收通过再进入下一个。
> **原则**：能用 pi 官方已有能力就不自建；只写 Core 独有的部分（意图、Mission 调度、模板图、反馈演化、SQLite 知识库）。

---

## 0. 目标与成功标准

**做什么**：一个 pi 扩展包 `pi-testmode`。用户在 pi 中进入测试模式（`/test`），用自然语言下达测试意图。

- 主会话只负责解析意图、检索模板、派发 Mission，派发后结束本轮，进入待命。
- Mission 在独立的子会话中执行，完成后由事件唤醒主会话，主会话汇总报告。
- 知识（模板图、能力注册表、经历、反馈）存储在 SQLite 中。

**成功标准**（全部可在仓库内的靶场 SUT `canary/` 上复现）：

1. **M1**：测试意图能派发 Mission，主会话进入待命；Mission 完成后自动唤醒主会话出报告。报告中的缺陷都经过独立复验。进程崩溃或网络中断后，Mission 可以恢复，且不会重复执行已完成的副作用。
2. **M2**：第二次提出同类意图时，命中模板（H2/H3），Token 成本 ≤ 首次的 50%。主会话上下文中从不出现任何能力正文。
3. **M3**：靶场切换为最终一致模式后，误报产生的是一条**例外**，而不是模板被改写或删除；原有基石案例的判定保持不变。

---

## 1. 已核实的 pi 事实（pi 1.4.0，2026-10）

> 来源：从 npm 解包 `@earendil-works/pi-coding-agent@1.4.0` 等包，阅读 `docs/`、`examples/` 和 `dist/**/*.d.ts`。
> **注意**：旧的 `@mariozechner/*`（停在 0.73.1）已迁移，只能使用 `@earendil-works/*`。若 API 与本节不一致，以已安装版本的 `.d.ts` 为准，并回写本节。

| 能力 | API | 本项目用途 |
|---|---|---|
| 扩展加载 | `export default function (pi: ExtensionAPI)`，jiti 直接加载 TS；包通过 `package.json` 的 `pi.extensions` 声明 | 包入口 |
| 模式切换 | `pi.registerCommand` / `registerFlag` / `registerShortcut` + `pi.setActiveTools(names)` | `/test`、`--test` |
| 提示词注入 | `before_agent_start` 中修改 `event.systemPromptOptions.sections.<key>`（官方推荐，优于整体替换） | 测试模式职责说明 |
| 上下文过滤 | `context` 事件返回 `{ messages }` | 退出测试模式后清除残留 |
| 自定义工具 | `pi.registerTool({ name, description, parameters(TypeBox), promptSnippet, promptGuidelines, execute, exposure, annotations, outputSchema, executionMode })`；返回 `terminate: true` 可跳过自动续轮 | 元工具 |
| 拦截工具调用 | `tool_call` 可修改 input 或返回 `{ block, reason }`；handler 抛错时 **fail-closed**；对 MCP 和 codemode 发起的调用同样生效 | 策略闸门 |
| 唤醒主会话 | `pi.sendMessage({customType, content, display, details}, { triggerTurn: true, deliverAs: "followUp" })` | Mission 完成通知 |
| 空闲信号 | `agent_settled`：不会再自动续轮。注意 `agent_end` **不是**最终空闲 | 判定空闲 |
| 子会话 | `createAgentSession({ cwd, modelRuntime, model, tools, excludeTools, customTools, resourceLoader, sessionManager, settingsManager })`；之后调用 `session.bindExtensions({})`、`prompt()`、`abort()`、`dispose()` | Mission Agent |
| 资源隔离 | `new DefaultResourceLoader({ cwd, agentDir, noExtensions, noSkills, noPromptTemplates, noContextFiles, additionalSkillPaths, extensionFactories, systemPrompt, appendSystemPrompt })` | Mission 只看到绑定的能力 |
| 内置扩展 | SDK 会话**不会**自动加载内置扩展，需显式加入：`createMcpExtension({ loadConfig })`、`createToolSearchExtension()`、`createCodemodeExtension({ mode })` | Mission 中的 MCP 与渐进披露 |
| MCP 暴露级别 | `exposure: direct \| codemode \| deferred \| hidden`；工具名为 `mcp__<server>__<tool>`；`deferred` 由 `tool_search` 按需声明 | D3 渐进披露 |
| 嵌套调用 | `ctx.modelRegistry.streamSimple(model, context)`：单次 LLM 调用。`ctx.executeTool(name, args)`：嵌套工具调用，同样经过 `tool_call` / `tool_result` 闸门 | 归因与提议；复用内置工具 |
| 会话存储 | `SessionManager.create(cwd, sessionDir)`（JSONL）/ `SessionManager.inMemory()`；`SettingsManager.inMemory()`、`applyOverrides()` | Mission 对话记录 |
| 会话持久化与恢复 | 每条记录**同步**追加写入 JSONL（`appendFileSync`），加载时跳过损坏行（比如崩溃时只写了一半的末行）。**只有出现第一对 user + assistant 消息后才会首次落盘**。用 `SessionManager.open(path)` 重新打开，用 `branch(entryId)` 回退叶子；`appendMessage()` 可写入 toolResult | 崩溃恢复（M1-14） |
| 孤儿工具调用 | pi-ai 发请求前，会给"有调用、无结果"的调用自动补一条 `No result provided` 的错误结果；`stopReason` 为 error 或 aborted 的 assistant 消息不会被重放 | 恢复后请求不报错，但模型可能重跑该调用（见 M1-14） |
| 网络重试 | `retry.enabled`（默认 true）、`retry.maxRetries`（默认 3）、指数退避（`baseDelayMs` 2000，`maxAgentDelayMs` 60000）；`retry.provider.maxRetries` 默认 0 | 应对 LLM 服务商的瞬时故障 |
| Skills | 遵循 Agent Skills 标准。系统提示只放 name、description、路径，正文由模型用 `read` 按需读取 | 能力封装 |
| 测试替身 | `@earendil-works/pi-ai`：`fauxProvider()`、`fauxAssistantMessage`、`fauxToolCall`、`fauxText` | 确定性 e2e |
| 运行时 | Node ≥ 22.19；Windows 上内置 `powershell` 工具 | — |
| 模型运行时 | `ModelRegistry` 的 runtime 是私有字段，Mission 需自行调用 `ModelRuntime.create({ authPath, modelsPath })`（读取同一个 `agentDir`） | Mission 鉴权 |
| faux 接入（M1 实测） | `ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false })` 后调用 `runtime.registerNativeProvider(faux.provider)`，模型取 `faux.getModel()`；`setResponses` 可传函数，按请求上下文路由 | e2e |
| 会话关闭（M1 实测） | `session.dispose()` **不**触发 `session_shutdown`；只有 `AgentSessionRuntime.dispose()` 和会话替换会触发。SDK 宿主需自行 `session.extensionRunner.emit({ type: "session_shutdown", reason })` | e2e、Mission 收尾 |
| 恢复续跑（M1 实测） | `SessionManager.open(path, runDir, cwd)` 后先 `appendMessage(toolResult)` 再 `createAgentSession({ sessionManager })`，可以直接续跑；已写入结果的调用不再被合成 `No result provided` | M1-14 |
| sandbox-runtime（M1 实测 API） | `SandboxManager` 是全局单例，但 `wrapWithSandbox(cmd, shell, customConfig)` 接受逐条命令的配置，多个 Mission 可共用一次 `initialize` | M1-7 |
| 安装（M1 实测） | npm 11 解析 vitest 可选 peer 时崩溃（`reading 'edgesOut'`），包内 `.npmrc` 设 `legacy-peer-deps=true` | — |
| Skill 精确绑定（M2 实测） | `DefaultResourceLoader({ noSkills: true, additionalSkillPaths })` 仍加载 `additionalSkillPaths`，因此 Mission 只看到绑定的 Skill；主会话可在 `before_agent_start` 里把 `systemPromptOptions.skills` 置空来隐藏用户 Skill | M2-5、M2 验收 3 |
| MCP 描述改写（M2 实测） | 上游描述会原样出现在两处：工具声明（system 消息的 `toolsAdded`）和 `tool_search` 的结果文本。前者用任一常驻工具的 `prepareLoadout` 返回 `descriptions` 替换，后者在 `tool_result` 中替换；`mcp_servers` 段在 MCP 扩展之后注册的 `before_agent_start` 中覆盖。`pi.getAllTools()` 返回 MCP 工具的完整定义（description / parameters / annotations / namespace），可据此计算定义哈希 | M2-7 |
| MCP 试连（M2 实测） | Mission 内加载 `createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) })` 后，`pi.registerMcpServer()` 注册的服务器会被连接，工具出现在 `getAllTools()`；`unregisterMcpServer()` 断开 | M2-7 Toolsmith |

---

## 2. 官方能力复用清单（先查这里，再决定是否自己写）

### 2.1 直接使用，不修改

| 官方能力 | 承担 Core 中的职责 |
|---|---|
| 内置 **MCP 扩展**（`createMcpExtension`），自定义 `loadConfig` | Mission 只连接模板绑定的 MCP Server（D3）；`pi.registerMcpServer` 用于 Toolsmith 试连 |
| 内置 **tool_search**（`createToolSearchExtension`） | `deferred` 暴露的能力按需声明（D3） |
| 内置 **codemode**（`createCodemodeExtension`） | 重型工具输出在 QuickJS 沙箱里过滤，只回传摘要（D4） |
| 内置工具 `read / bash / powershell / edit / write / grep / find / ls` | Mission 的基础执行能力；bash 自带截断，并把全文写入 `full_output_path` |
| **Agent Skills** + `additionalSkillPaths` | 能力（Provider）的主要封装形式 |
| `SessionManager`（JSONL） | Mission 完整对话记录，可直接用 pi 自身工具查看和导出 |
| `ctx.modelRegistry.streamSimple` | 分诊、归因、合并提议等**单次** LLM 判断，不必开子会话 |
| `fauxProvider` | e2e 测试 |
| 官方容器化方案（[containerization.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)，Plain Docker / Docker Sandboxes） | Windows 上的强隔离方案 |

### 2.2 改编官方示例（复制进本包并参数化，文件头注明来源路径和 pi 版本）

| 官方示例（`examples/extensions/`） | 改编为 |
|---|---|
| `plan-mode/` | **测试模式骨架**：`/test`、flag、快捷键、`setActiveTools`、状态栏、`appendEntry` 恢复、`context` 过滤 |
| `permission-gate.ts` + `protected-paths.ts` | **策略闸门**：规则来自 `scope.json` 和风险分级；Mission 内没有 UI 时转交主会话审批 |
| `sandbox/`（`@anthropic-ai/sandbox-runtime`） | **Mission 的 OS 级 bash 隔离**（macOS/Linux）：配置由 Mission 的授权范围生成，不读 `.pi/sandbox.json` |
| `subagent/agents/*.md` 的格式 | **角色定义文件**：frontmatter 写 `name / description / tools / model`，正文是系统提示。只复用格式，不复用它的运行器（见 §2.4） |
| `structured-output.ts` | `mission_submit`：`terminate: true` 结束 Mission，交回结果信封 |
| `questionnaire.ts` | 意图澄清，仅在歧义会改变风险或范围时使用 |
| `status-line.ts` / `widget-placement.ts` / `message-renderer.ts` | 运行中 Mission 数、完成通知的渲染 |

### 2.3 明确不自建

- MCP 客户端、工具检索、输出截断、Skill 发现、会话文件格式、Provider 与鉴权：全部使用 pi 内置能力。
- 不写自定义 `http_request` 工具。HTTP 用 `bash`（curl）或 MCP，网络边界交给沙箱。
- 不写向量检索。MVP 用 SQLite FTS5 加维度倒排索引。

### 2.4 评估过但未采用

| 候选 | 不用的原因 |
|---|---|
| 官方 `subagent/` 的运行器 | 每次调用都起一个 `pi` 子进程，**阻塞**到子进程结束，不满足"派发后待命"；也无法注入内联策略扩展和共享 DB 句柄。改用 SDK 的 `createAgentSession`（同为官方 API） |
| `@earendil-works/pi-durable` | 后台子代理和任务图很契合，但它是**另一个宿主**，不是 pi CLI 扩展，README 也标注 *Experimental, API changes without notice*。崩溃恢复改由 pi 会话持久化加上本包的状态机和副作用日志实现（M1-14，I-8），runner 放在接口后面以便将来迁移（I-9） |
| `@earendil-works/pi-session-backend-sqlite-node` / `pi-storage-sqlite-node` | 用途是 pi-agent-core 的**会话**存储，不是通用知识库；后者停在 0.83。知识库直接用 `node:sqlite` |
| `gondolin/` 示例（micro-VM） | 只支持 macOS/Linux（QEMU / krun），与 Windows 环境不符；Linux 用户可作为替代沙箱 |
| 社区包 `pi-subagents`、`pi-mcp-adapter`、`pi-web-access` | 非官方。`pi-mcp-adapter` 已被内置 MCP 取代 |

### 2.5 联网检索（Scout 用）

优先接入官方 [pi-skills](https://github.com/badlogic/pi-skills) 仓库中的检索类 Skill，或用户已配置的检索类 MCP Server。只挂在 Scout 的 Mission 上，主会话不加载。

⚠ 本轮无法访问 GitHub，**pi-skills 中的具体 Skill 名称未核实**，实施时需要确认。都不可用时，Scout 退化为只读本地资料和包仓库元数据（`npm view` 等）。

---

## 3. Core → pi 映射

| Core 概念（agent-core.md） | pi 实现 |
|---|---|
| 主 Agent（§5.1） | 用户当前的 pi 会话进入测试模式。active tools 只保留只读工具和测试模式元工具 |
| Mission Agent（§5.2） | 每个 Mission 一个进程内子会话（`createAgentSession`），工具白名单由角色决定 |
| 派发后待命（§5.1） | `mission_dispatch` 立即返回 `terminate: true`；完成后由 `sendMessage(followUp, triggerTurn)` 唤醒 |
| 内核策略（§11） | 同一个 `tool_call` 闸门工厂，主会话和每个 Mission 都加载 |
| 元工具 D0（§9.1） | 主会话：testmode 工具；Mission：角色工具 |
| 模板卡片 D1 | `knowledge_search` 返回 ≤3 张卡片 |
| 模板正文 D2 | 派发时渲染进 Mission 的 `systemPromptOptions.sections` |
| 能力 D3 | Skill：`additionalSkillPaths` 只放绑定的 Skill。MCP：`createMcpExtension({ loadConfig })` 只返回绑定的 Server，`exposure: "deferred"`，配合 `tool_search` |
| 原始输出 D4 | bash 自带截断加全文文件；codemode 脚本内部过滤；证据文件按 sha256 存放 |
| 判决可执行化（§10.3 第 10 条） | 判决只能来自 `test_run` 的退出码和断言输出 |
| 知识库 K | SQLite：`project.db`，并 ATTACH `global.db` |
| 崩溃恢复 | pi 会话 JSONL（续跑），加上本包的 `missions` 状态机、`tool_journal`（副作用至多执行一次）和通知发件箱（M1-14） |
| OS 隔离 | macOS/Linux：改编的 sandbox 扩展。Windows：只有工具层策略，并在报告中写明隔离级别；建议改用官方 Docker 方案运行 pi |

---

## 4. 关键实现决策

| # | 决策 | 理由 |
|---|---|---|
| I-1 | 子会话在**进程内**运行（SDK），不另起子进程 | 能共享 SQLite 句柄，能注入内联策略扩展和自定义工具；`dispose()` 后工具与模板正文一并卸载。代价是共享事件循环，LLM 调用以 I/O 为主，可以接受 |
| I-2 | Mission 的 `DefaultResourceLoader` 设置 `noExtensions / noSkills / noPromptTemplates / noContextFiles: true`，只通过 `extensionFactories` 注入：policy、mission-tools，按需加入 MCP / tool_search / codemode / sandbox | 用户全局的 Skill、扩展、MCP 一律不进入 Mission，保证渐进披露；同时避免 Mission 递归加载 testmode |
| I-3 | SQLite 使用 `node:sqlite`（`DatabaseSync`），外包一层 `store/db.ts` | pi 1.4 要求 Node ≥ 22.19，`node:sqlite` 已无需 flag。实测 SQLite 3.51.3，FTS5（trigram）、JSON1、WAL 均可用。trigram 只匹配 ≥3 字符，中文双字词需要 LIKE 兜底 |
| I-4 | Mission 对话记录留在 pi 自己的 JSONL 中（`.pi/testmode/runs/<mission>/session.jsonl`）。SQLite 只存结构化数据和文件引用 | 不复制 pi 的会话格式 |
| I-5 | 适用判定、风险分级、门禁、分诊规则、指标计算都写成**确定性纯函数**。LLM 只做角色对话和少数判断（归因、提议），其输出必须通过 TypeBox 校验 | Core P10：内核不可学习 |
| I-6 | 测试模式下主会话**没有** bash / edit / write | "主 Agent 不执行测试"由工具层强制，而不是靠提示词约定 |
| I-7 | 项目层 → 全局层的晋升默认需要用户执行 `/test-promote` 确认（agent-core §17-1 的默认答案） | 全自动闭环只做到项目层，跨项目污染风险由人把关 |
| I-8 | 崩溃恢复的语义是**副作用至多执行一次**：<br>• 已完成的调用：重放日志里的结果，不重新执行。<br>• 只读或幂等的调用中途中断：可以安全重跑。<br>• 有副作用的调用中途中断：转为 `blocked`，交给人判断。<br>不追求 exactly-once | Mission 有预算上限，环境模板要求每个 Mission 使用独立的测试数据或租户，大部分操作天然幂等。真正需要人工判断的只剩"有副作用且做到一半"这一小类 |
| I-9 | `missions/runner.ts` 实现 `MissionRunner` 接口（start / resume / abort / status），编排器只依赖接口 | 将来 pi-durable 稳定后，只需替换实现 |
| I-10 | `test_run` 的副作用类别按契约记为**幂等**（环境模板要求 Mission 独占测试数据或租户）；但依赖安装和范围外主机照常审批，危险命令照常拦截 | 否则每次中断的 `test_run` 都会触发人工确认；需要人判断的只剩 bash/MCP 中做到一半的副作用 |
| I-11 | 复验结论由代码判定：Verifier 信封的 `verification` 条目引用它**自己的** `test_run`，对照声明所需判决（defect→fail，pass→pass），全部一致为 confirmed，全部相反为 refuted，其余 inconclusive | Verifier 的措辞不参与判定，与"判决只来自 test_run"一致 |
| I-12 | 自动派发的 Verifier 继承 Executor 的风险等级，不再单独审批 | 目标和操作与已授权的 Executor 相同；避免在后台完成回调中弹审批 |
| I-13 | 首轮回复前崩溃（会话未落盘）时，用**同一个** mission_id 重跑原 Spec，`resume_count` 加一 | 不产生孤儿 Mission 记录，报告里只出现一次 |
| I-14 | 能力验证分两步：Toolsmith 的 `provider_register` 只登记为 `candidate`；编排器随后派发**一致性 Verifier**（候选者直接写入其 `bindings`），由其 `test_run` 结果（通过率 ≥0.9、有 pass 声明、无 defect 声明、哈希未变）决定升为 `verified`。只有 verified/pinned 才会被绑定到普通 Mission | 构建者与验证者分离（core §9.4）；晋升由代码判定 |
| I-15 | Mission 是否唤醒主会话按**子树**判定：根 Mission 及其全部后代（Verifier、Toolsmith、一致性 Verifier）都停下后才发一次唤醒；Curator 永不唤醒 | 主会话每个结果只被唤醒一次，且不会看到"能力还在验证中"的半成品 |
| I-16 | 新模板的硬边界不由 LLM 决定：取基石指纹中**判别性维度**（sut.kind、interface.protocol、state.shared_resource、sut.stack、spec.format、interface.pagination，置信度 ≥0.5）；LLM 追加的硬条件必须对基石成立，否则丢弃。env.kind、goal.kind 不进硬边界 | "从窄处出生"且可复用；同时保证基石案例被自己的边界接纳 |
| I-17 | MCP 工具的模型可见描述一律由系统生成（能力语义 + 工具名 + 参数），**丢弃**上游描述，而不是尝试清洗 | 清洗无法证明完备；丢弃最简单且安全 |
| I-18 | 种子词表**不含** `consistency.model`；只有命中级别为相关策略时才定 H2/H3，仅因共享维度被召回的策略不影响命中级别 | 前者让 M3 验收能演示"从误报中发现新维度"；后者避免不相关的适用策略抬高命中级别 |
| I-19 | 统计、反馈、Delta 全部存在 `project.db`（包括针对全局模板的）；项目对全局模板的修订一律落到**项目层覆盖副本**（`overrides` 边） | 写反馈、更新统计、提交 Delta 必须在同一 SQLite 事务（M3-4）；跨 ATTACH 文件的提交在崩溃时不保证原子 |
| I-20 | 分诊新增 `V`（有效的未发现：预言灵敏性与特异性自检都通过）为正反馈；没有自检的 pass 归 `U`。灵敏性：已确认的缺陷本身即证据；否则需 Verifier 在 `oracle_checks` 中引用注入故障下失败的 `test_run` | core §10.2"两类未发现必须区分" |
| I-21 | 情境簇 = 指纹在模板条件所涉维度 ∪ {sut.kind, sut.stack, state.resource_kind, consistency.model} 上的投影。`state.resource_kind` 只分簇、不进硬边界 | 同一边界内不同资源类别要能形成不同簇（M3 验收 1），又不能让模板"出生"在单一资源上 |
| I-22 | 每次可信度 ≥0.5 的 S/V 都把该经历加为基石（每簇上限 5），而不只是"情境新颖"时 | 否则同簇复用永远凑不齐 stable 所需的 3 个基石；上限防止基石膨胀 |
| I-23 | 经历存**原始指纹**（含未激活维度），判定时再过滤到 active。SUT 模型 = 同一 SUT 最近一次 scout/executor 经历；意图类维度（goal、quality、env、resource_kind）不继承 | 维度激活后，旧基石仍能用当时记录的值与新失败区分（core §14 第 3–4 幕） |
| I-24 | 新维度激活条件：有维度假设（attributor 双评判一致）、至少一次置信度 ≥0.7 的观察、至少两个不同取值。派发时把待验证维度（`facet.propose` 与悬置 `except` 涉及的维度）写入 Mission 的 `probe`，由执行者在 `fingerprint` 中报告 | "探测"由执行任务顺带完成，不必为每个假设单派 Scout |
| I-25 | 触发的 `patch` 例外若指向模板，派发时把该模板一并激活；例外的支持度记在 `template_stats` 的 `exception:<id>` 行，不混入适用域内统计 | 例外结果才能被执行和计分（M3 验收 3）；B 类不污染 β |
| I-26 | 晋升门禁的"≥2 个项目"在单库内以"基石覆盖 ≥2 个不同 SUT"近似；`/test-calibrate` 基于时间窗内已关闭的意图计算，不自动跑固定意图集；Gardener 的去重合并为确定性"弃用较弱者 + redirects_to"，不调 LLM 改写内容 | 单个 project.db 看不到其他项目（组织层不在范围）；保持门禁与整理全部可复现 |
| I-27 | （真实模型冒烟运行后）复验以复现率 ≥0.6 判 confirmed；Mission 请求预算下限为角色默认值的一半，达到 100% 后仍可提交、125% 才中止；Mission 的 shell 调用超时上限 120 秒，整盘扫描列为危险命令；作弊检测以"有非零退出的运行"为准 | 见 [docs/runs/2026-10-26-canary-deepseek](runs/2026-10-26-canary-deepseek/README.md) 的问题 1–8 |
| I-28 | Mission 预算以**新增 token** 计：本轮提示超出上一轮"提示 + 输出"的部分加本轮输出；重发的上下文不再重复计入（原口径保留为 `processed`，用于成本）。默认预算按真实运行实测重设。一致性评分只统计 verifier 声明引用的 `test_run` | 原口径把同一上下文重复计 8–13 倍，verifier 普遍超预算；verifier 的故障探测本应失败，不能拉低被测能力的分数 |

---

## 5. 仓库结构与运行时数据

```
pi-testmode/
├── package.json             # 见下文
├── src/
│   ├── index.ts             # 入口：注册模式、命令、工具、钩子
│   ├── mode.ts              # 测试模式（改编自 plan-mode）
│   ├── paths.ts / types.ts / util.ts   # 运行时目录、共享类型、哈希与 id 等工具函数
│   ├── orchestrator/        # 主会话元工具（tools.ts）、编排器（派发、复验、一致性评分）、intent、questionnaire、report、verification
│   ├── missions/            # runner.ts（MissionRunner 接口 + createAgentSession 实现）、recovery.ts、envelope.ts、roles.ts、roles/*.md
│   ├── kernel/              # policy.ts（规则）、policy-extension.ts（闸门、审计、副作用日志）、command.ts、paths.ts、risk.ts、scope.ts、approvals.ts、budget.ts
│   ├── sandbox/             # 改编自官方 sandbox 示例
│   ├── harness/             # tools.ts（test_run、artifact_freeze）、process.ts、evidence.ts（内容寻址）
│   ├── store/               # db.ts、repos.ts（M1 表，含 audit 与 tool_journal）、migrations/{project,global}/*.sql
│   ├── knowledge/           # schema.ts（TypeBox）、store.ts（知识表）、applicability.ts、fingerprint.ts、retrieval.ts、render.ts、seeds/
│   ├── capabilities/        # registry.ts、skill-validate.ts、mcp-bind.ts、tools.ts
│   └── learning/            # evaluator、triage、attributor、curator、delta、gate、stats、lifecycle、gardener、calibration、promote、pipeline
├── canary/                  # 靶场 SUT（node:http，零依赖），见 M1-12
└── test/                    # vitest：unit/ 和 e2e/（fauxProvider）
```

**运行时数据**：

```
~/.pi/agent/testmode/global.db        # 全局层：模板、能力契约、维度词表
~/.pi/agent/testmode/skills/          # 全局层已验证的 Skill（<name>@<hash8>/）
<repo>/.pi/testmode/project.db        # 项目层：模板、经历、反馈、审计
<repo>/.pi/testmode/scope.json        # 授权范围：只能由人编辑，Agent 写入一律被闸门拦截
<repo>/.pi/testmode/runs/<mission>/   # Mission 工作目录、session.jsonl
<repo>/.pi/testmode/evidence/<sha256> # 证据文件
<repo>/.pi/testmode/skills/           # 项目层 Skill
<repo>/.pi/testmode/reports/          # 报告
```

> 以上目录都不在 pi 的自动发现路径里（例如 `.pi/skills`），所以用户的普通 pi 会话看不到 testmode 的 Skill；也不会触发 pi 的项目信任提示，因为 `.pi/testmode/` 不在受保护资源列表中。

**package.json**：

```json
{
  "name": "pi-testmode",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./src/index.ts"] },
  "engines": { "node": ">=22.19.0" },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "optionalDependencies": { "@anthropic-ai/sandbox-runtime": "0.0.26" },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "1.4.0",
    "@earendil-works/pi-agent-core": "1.4.0",
    "@earendil-works/pi-ai": "1.4.0",
    "@earendil-works/pi-tui": "1.4.0",
    "typebox": "1.3.27",
    "typescript": "5.9.3",
    "vitest": "4.1.11",
    "@types/node": "22.19.19"
  }
}
```

- **peer 依赖用 `"*"`**：这是 pi 官方约定（[packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)），由宿主 pi 提供这些包，扩展不打包。
- **dev 依赖锁定精确版本**：与 pi 1.4.0 自身使用的版本一致。
- **sandbox-runtime 放在 optional**：Windows 上安装失败也不阻塞。
- **本地开发**：`pi -e ./pi-testmode` 或 `pi install ./pi-testmode`。

---

## 6. 数据模型（SQLite）

> 表名和关键列如下，细节由实施者补全。所有写操作都走事务。`audit` 只追加（用触发器禁止 UPDATE 和 DELETE）。

| 表 | 关键列 | 里程碑 |
|---|---|---|
| `meta` | `schema_version` | M1 |
| `intents` | `id, raw, ir_json, status, report_path, created_at, closed_at` | M1 |
| `missions` | `id, intent_id, parent_id, role, objective, spec_json, status(queued/running/interrupted/completed/partial/blocked/failed/aborted), interrupt_reason(crash/network/shutdown), risk_tier, budget_json, cost_json, envelope_json, session_path, owner_pid, heartbeat_at, resume_count, notified_at, started_at, ended_at` | M1 |
| `tool_journal` | `mission_id, tool_call_id, tool, input_digest, effect_class(read_only/idempotent/side_effecting), status(started/finished), result_digest, result_ref, started_at, finished_at`；主键 `(mission_id, tool_call_id)` | M1 |
| `evidence` | `sha256 PK, mission_id, kind, path, bytes, created_at` | M1 |
| `test_runs` | `id, mission_id, command, cwd, exit_code, duration_ms, stdout_sha, stderr_sha, verdict(pass/fail/inconclusive/error), artifact_shas_json` | M1 |
| `frozen_artifacts` | `path, sha256, mission_id, frozen_at` | M1 |
| `approvals` | `id, mission_id, tier, subject, decision, scope(once/session/always), decided_at` | M1 |
| `audit` | `seq, ts, actor(main/mission:<id>), event, tool, input_digest, decision, reason` | M1 |
| `templates` | `id, layer(global/project), type, status, head_version, created_at` | M2 |
| `template_versions` | `template_id, version, spec_json, body_md, changelog, created_by_delta` | M2 |
| `templates_fts` | FTS5（trigram）：`title, summary, intent_patterns` | M2 |
| `edges` | `src, dst, kind(specializes/composes/refers/alternative_to/precedes/conflicts_with/redirects_to/derived_from/overrides/requires/implemented_by), attrs_json` | M2 |
| `facets` | `name, type, values_json, status(active/proposed), evidence_json` | M2 |
| `capabilities` | `id(cap:...), io_schema_json, semantics, conformance_suite_path` | M2 |
| `providers` | `sha256 PK, cap_id, kind(skill/mcp/cli), name, version, path_or_config_json, trust(quarantined/candidate/verified/pinned), conformance_score, provenance_json` | M2 |
| `episodes` | `id, mission_id, fingerprint_json, plan_json, deviations_json, outcome` | M2 |
| `template_uses` | `episode_id, template_id, version, role(applied/cited/retrieved_unused), slot` | M2 |
| `cornerstones` | `template_id, exception_id NULL, episode_id, fingerprint_json` | M2 |
| `feedback` | `id, episode_id UNIQUE, signals_json, credibility, triage_class, attribution_json`（`episode_id` 作为学习流水线的幂等键） | M3 |
| `template_stats` | `template_id, cluster_key, alpha, beta` | M3 |
| `deltas` | `id, op, target, payload_json, evidence_json, status(pending/committed/rejected/suspended), gate_report_json` | M3 |
| `calibration_runs` | `id, ts, precision, recall, details_json` | M3 |
| `snapshots` | `id, ts, path` | M3 |

**分层**：`global.db` 包含模板与能力相关的表（`templates*`、`edges`、`facets`、`capabilities`、`providers`、`template_stats`），**不含**经历和证据。查询时项目层覆盖全局层（`overrides` 边）。

---

## 7. 工具清单

**主会话（测试模式下的 active tools）**：`read, grep, find, ls` 加上以下工具。

| 工具 | 说明 | 里程碑 |
|---|---|---|
| `intent_record` | 把模型解析出的 Intent IR（agent-core §6.1）经 TypeBox 校验后落库，返回 `intent_id` | M1 |
| `questionnaire` | 改编自官方示例，只在歧义会改变风险或范围时使用 | M1 |
| `mission_dispatch` | 派发一个或多个 Mission，**立即返回**，`terminate: true` | M1 |
| `mission_status` | 查询信封摘要。对运行中的 Mission 返回"仍在运行，请结束本轮等待通知" | M1 |
| `report_finalize` | 生成报告并关闭意图；M3 起异步触发学习 | M1 |
| `knowledge_search` | 返回 ≤3 张模板卡片和命中级别 H0–H3 | M2 |

**Mission（按角色分配）**：

| 工具 | 角色 | 说明 | 里程碑 |
|---|---|---|---|
| 内置 `read / grep / find / ls` | 全部 | — | M1 |
| 内置 `bash`（Windows 上加 `powershell`） | Scout、Executor、Verifier、Toolsmith | 经过闸门和沙箱 | M1 |
| 内置 `write / edit` | Executor、Toolsmith | 只允许写本 Mission 的 run 目录 | M1 |
| `test_run` | Executor、Verifier | 执行测试命令；**唯一的判决来源**；stdout/stderr 存为证据 | M1 |
| `artifact_freeze` | Executor | 冻结测试脚本（记录 sha256）。此后对该路径的 write/edit 被闸门拦截 | M1 |
| `mission_submit` | 全部 | 提交结果信封（agent-core §5.3），`terminate: true` | M1 |
| `capability_request` | Scout、Executor | 提交能力缺口单（§9.5），记为偏离 | M2 |
| `skill_validate` / `provider_register` | Toolsmith | 校验并登记能力 | M2 |
| `template_propose` | Curator | 提交模板草案 | M2 |
| `delta_propose` | Curator | 提交结构化增量 | M3 |
| 内置 `tool_search` / `codemode` | 按模板绑定 | 只在绑定了 deferred 或 codemode 能力时启用 | M2 |

---

## 8. M1：内核与任务闭环（不含学习）

**目标**：在 `/test` 下跑通完整链路：意图 → Scout / Executor / Verifier → 待命 → 唤醒 → 报告。全部记录写入 SQLite，策略由代码在模型之外强制执行。

| 编号 | 任务 | 要点 | 参考 |
|---|---|---|---|
| M1-1 | 包骨架 | 按 §5 建立结构；`npm run typecheck`（`tsc --noEmit`）和 `vitest` 可运行；`pi -e ./pi-testmode` 能加载，`/test` 出现在命令列表中 | — |
| M1-2 | Store | `store/db.ts`：打开 `project.db` 并 `ATTACH global.db`，开启 `journal_mode=WAL`、`foreign_keys=ON`；按顺序执行 `migrations/*.sql`，写入 `meta.schema_version`；建立 §6 中 M1 的表；`audit` 加触发器禁止 UPDATE/DELETE。Node 不满足要求时给出明确报错 | §6 |
| M1-3 | 测试模式 | 改编 `plan-mode/`：<br>• 用 `/test`、`--test`、快捷键切换。<br>• 切换时调用 `setActiveTools`，保存切换前的工具集，退出时恢复。<br>• `before_agent_start` 写入 `sections.testmode`，内容是主会话职责：只理解、检索、派发、汇总；派发后结束本轮。<br>• 非测试模式下由 `context` 过滤 testmode 消息。<br>• 状态栏显示运行中 Mission 数。<br>• 用 `appendEntry("testmode-state")` 恢复状态 | core §5.1 |
| M1-4 | `intent_record` | 按 core §6.1 定义 Intent IR 的 TypeBox schema，校验后入库。<br>• 歧义会改变风险等级或范围（环境、破坏性、目标资产）时，主会话必须先用 `questionnaire` 询问。<br>• 其他歧义写入 `assumptions` | core §6.1 |
| M1-5 | 授权范围与风险分级 | `scope.json` 的 schema 照搬 core §11.1（targets / limits / data / egress_allowlist）；缺失时只允许 R0/R1。<br>`risk.ts` 是纯函数，输入 Mission 目标、操作类型和模板的 `risk_tier_floor`，输出 R0–R4。**风险等级不是 `mission_dispatch` 的参数**，只能由代码算出 | core §11.1 |
| M1-6 | 策略闸门 | 改编 `permission-gate.ts` 和 `protected-paths.ts`，做成工厂 `policyExtension(ctx)`，主会话和每个 Mission 都加载：<br>• write/edit 只允许写本 Mission 的 run 目录。<br>• 拒绝写入：`scope.json`、`*.db`、本扩展目录、`frozen_artifacts` 中的路径。<br>• bash/powershell 危险命令拦截；依赖安装命令（`npm i`、`pip install`、`npx`、`uvx` 等）首次出现时按 R2 审批。<br>• MCP 工具按 `annotations`（destructiveHint / openWorldHint）参与风险分级。<br>• **Mission 内没有 UI**：闸门调用编排器注入的 `approve(req)`。主会话有 UI 时弹 `ctx.ui.select`（一次 / 本会话 / 拒绝），否则一律拒绝。<br>• handler 出错时 fail-closed。<br>• 每次调用写 `audit`，参数只记摘要（sha256），不记原文 | core §11 |
| M1-7 | OS 隔离 | 改编官方 `sandbox/`，改为接受配置对象：<br>• `network.allowedDomains` 取 scope 的 `egress_allowlist`。<br>• `filesystem.allowWrite` 为 run 目录和系统临时目录。<br>• `denyRead` 至少包含 `~/.ssh`、`~/.aws`、`~/.pi/agent/auth.json`。<br>• 只在 macOS/Linux 启用；Windows 上不启用，在报告的"隔离级别"中注明，并在 README 中推荐使用官方 Docker 方案 | core §11.2 |
| M1-8 | Mission 运行器 | `missions/runner.ts` 调用 `createAgentSession`：<br>• `cwd` 设为项目根（只读访问被测代码）。<br>• `sessionManager = SessionManager.create(cwd, runDir)`。<br>• `settingsManager = SettingsManager.inMemory({ compaction: { enabled: true } })`。<br>• `modelRuntime = await ModelRuntime.create({ authPath, modelsPath })`，路径取用户的 `agentDir`。<br>• `tools` 按角色白名单设置；`resourceLoader` 按 I-2 配置。<br>• 系统提示 = 角色 `.md` 正文 + Mission Spec（core §5.3）。<br>• 调用 `bindExtensions({})` 触发 `session_start`。<br>• **结束条件**：调用了 `mission_submit` 视为成功；`prompt()` 返回但未提交，记为 `failed`；预算超限时 `abort()` 并记为 `partial`。<br>• 预算：订阅 `message_end` 的 usage 累计，80% 时 steer 提醒收尾，100% 时中止。<br>• 并发上限默认 3；MVP 不允许 Mission 再派发 Mission | core §5.2–5.4 |
| M1-9 | 派发 / 待命 / 唤醒 | `mission_dispatch`：<br>• 校验参数 → 计算风险 → 落库 → **不 await** 启动 runner → 返回 mission_id 列表和 `terminate: true`。<br>• `promptGuidelines`：*"After mission_dispatch, end your turn; do not call mission_status in a loop."*<br>完成后：<br>• 更新 DB，然后调用 `pi.sendMessage({ customType: "testmode-mission-done", content: <摘要>, details }, { triggerTurn: true, deliverAs: "followUp" })`。<br>• 500ms 内完成的多个 Mission 合并成一条消息。<br>• 用 `registerMessageRenderer` 渲染。<br>**会话替换**：<br>• 编排器只持有"当前主会话句柄"，在 `session_start` 更新，在 `session_shutdown` 清空，并 `abort()` 所有运行中的 Mission（记为 `aborted`）。<br>• 下次进入测试模式时列出被中止的 Mission，供用户决定是否重新派发。<br>• Mission 不持有主会话的 `pi` / `ctx`，只通过编排器回调 | core §5.1 |
| M1-10 | 复验 | Executor 信封中出现 `defect` 或 `pass` 声明时，编排器自动派发 Verifier：<br>• 只提供声明、冻结工件和证据，**不提供 Executor 的对话**。<br>• Verifier 在新的 run 目录中用 `test_run` 重放，得出 confirmed / refuted / inconclusive。<br>• 报告中只有 confirmed 的才计为缺陷 | core §10.3 |
| M1-11 | 报告 | `report_finalize` 生成 Markdown，内容包括：<br>• 结论；经复验的缺陷（最小复现、证据路径）。<br>• 未复现项及所用测试强度。<br>• 假设、未覆盖的目标、隔离级别、成本。<br>写入 `reports/`，意图标记为 closed | core §6.1 |
| M1-12 | 靶场 canary | `canary/`：用 `node:http` 实现的库存/订单服务，附 OpenAPI 文件和 `bugs.json`（真值）。缺陷由环境变量开关：<br>• **B1 超卖**：扣减为读-改-写，无锁。<br>• **B2 分页越界**：最后一页少一条。<br>• **B3**：名称含 emoji 时返回 500。<br>• **`CONSISTENCY=eventual`**：扣减进入队列，1–2s 后生效（M3 用）。<br>• **B4**：只在 eventual 模式下出现，补偿被重复执行，静置后才出现偏差（M3 用）。<br>每个缺陷可单独开关，供预言自检注入故障 | core §13、§14 |
| M1-13 | 测试 | **unit**：闸门规则、风险分级、scope 解析、迁移、证据哈希、信封校验。<br>**e2e**：用 `fauxProvider` 为主会话和各角色编排脚本化回复，断言"派发 → 主会话空闲（`agent_settled`）→ 唤醒 → 报告"链路和 `audit` 记录完整。faux provider 如何接入 `ModelRuntime`，以 1.4.0 的类型声明和 pi 自身测试为准。<br>**冒烟**：用真实模型跑一次 canary | — |
| M1-14 | 崩溃恢复 | 1. **状态机**：状态变更先写库再执行动作。运行中的 Mission 每 10s 更新一次 `heartbeat_at`，并记录 `owner_pid`。<br>2. **副作用日志**：由 M1-6 的闸门负责，不新增拦截点。`tool_call` 时写入 `started`，`tool_result` 时写入 `finished`，同时记录结果摘要和证据引用。`effect_class` 由代码判定：<br>　• read/grep/find/ls → 只读<br>　• 只写本 run 目录或本 Mission 专属测试租户 → 幂等<br>　• MCP 带 `destructiveHint` / `openWorldHint`、bash 访问外部主机、依赖安装 → 有副作用<br>　• 判定不了的一律按"有副作用"处理<br>3. **启动扫描**（`session_start`）：满足以下任一条件的 Mission 标为 `interrupted(crash)`：<br>　• `running` 且心跳超时（默认 60s）<br>　• `owner_pid` 对应的进程已不存在（用 `process.kill(pid, 0)` 探测）<br>心跳未超时、属于其他存活 pi 进程的 Mission 不能接管。<br>4. **恢复**（`MissionRunner.resume`）：<br>　(a) 用 `SessionManager.open(session_path)` 打开会话，找出当前分支上的孤儿工具调用，逐个对照日志：<br>　　• 无记录 → 不补结果，交给 pi-ai 的合成结果，让模型重试<br>　　• started + finished → 用 `appendMessage` 写入日志里的真实 toolResult，**不再执行**<br>　　• 只有 started，且为只读/幂等 → 写入"已中断，可安全重跑"<br>　　• 只有 started，且有副作用 → 写入"已中断，状态未知"，Mission 转为 `blocked`，请求人工确认。确认后先执行环境模板的 reset，再继续<br>　(b) 中断时正在运行的 `test_run`，判决记为 `inconclusive`，不进入反馈。<br>　(c) 追加一条恢复提示（哪些已完成、哪些已中断），然后 `prompt()` 继续。<br>　(d) `resume_count` 超过 2 次 → 转为 `failed`。<br>　(e) `session_path` 尚未落盘（崩溃发生在首轮回复之前）→ 直接重新派发同一个 Spec。<br>5. **网络中断**：<br>　• LLM 服务商：先走 pi 自带重试；重试用尽 → `interrupted(network)`，保留现场，网络恢复后可续跑，不计失败。<br>　• SUT 不可达：分诊为 E，见 M3-3。<br>　• MCP 断线：内置 MCP 会自动重连，重连后只自动重试只读/幂等调用。<br>6. **通知发件箱**：Mission 完成时在同一事务里写入 `completed` 和 `envelope`，通知成功后再写 `notified_at`。主会话 `session_start` 时，对"已完成但未通知"的 Mission 补发唤醒消息。<br>7. **用户入口**：进入测试模式时，列出 `interrupted` / `blocked` 的 Mission，由用户选择：恢复 / 重新派发 / 放弃。<br>8. **原子性**：证据先写临时文件，`rename` 为 sha256 文件名后再登记入库；启动时清理未登记的孤儿证据文件。SQLite 使用 WAL + `synchronous=NORMAL`。<br>9. **e2e**：测试进程内起一个子进程承载 SDK 会话，在工具执行中途 kill 子进程，然后重启，断言 M1 验收第 5 条。Windows 上同样要通过 | I-8、I-9 |

**验收**：

1. 输入"测一下 canary 的下单接口在并发下会不会超卖"后，主会话调用 `mission_dispatch`，本轮立即结束；Mission 运行期间不出现 `mission_status` 轮询；Mission 完成后主会话被唤醒并输出报告。
2. 用真实模型测 canary，至少发现 B1，且报告中标注为"已复验"。
3. 以下操作被拦截并记入 `audit`：写 run 目录之外的文件、修改 `scope.json`、访问白名单之外的主机（macOS/Linux）。首次 `npm i` 触发审批。
4. 不经过 `test_run` 的输出不能产生 pass 或 fail 判决。
5. 崩溃恢复（M1-14）：在工具执行中途强杀宿主进程后重启，需同时满足：
   - 已完成的调用不会重复执行；
   - 有副作用、执行到一半的调用转为 `blocked` 并请求确认；
   - 中断的 `test_run` 判决作废；
   - 主会话收到补发的唤醒消息。
6. 全部 unit 和 e2e 测试通过。

---

## 9. M2：模板图、能力获取与渐进披露

**目标**：
- 同类意图第二次出现时命中模板。
- 能力由 Toolsmith 获取并验证，只在绑定了它的 Mission 中可见。
- 每次成功后由 Curator 沉淀模板草案。

| 编号 | 任务 | 要点 | 参考 |
|---|---|---|---|
| M2-1 | 模板 schema 与种子 | `knowledge/schema.ts`：用 TypeBox 按 core §7.3 定义 `spec_json`，字段包括 applicability、io、slots、verdict、control、procedure、capabilities_required、evidence_contract、risk_tier_floor、pitfalls、recovery。<br>种子 6–8 个全局 `candidate` 模板：<br>• 预言：spec-assertion、conservation-invariant、implicit-5xx<br>• 技术：boundary-value、burst-same-key<br>• 感知：openapi-dependency-graph<br>• 环境：node-service-local<br>宁少而精 | core §7、§13 |
| M2-2 | 情境指纹 | Scout 信封增加 `fingerprint`（core §6.3）。维度必须来自 `facets` 中 `active` 的条目；新维度只能以 `proposed` 写入 | core §6.3 |
| M2-3 | 适用判定 | `knowledge/applicability.ts`：纯函数 `judge(spec, fingerprint) → { result: true\|false\|unknown, exception?, probes[] }`。<br>• 例外树按顺序匹配，第一个命中的生效。<br>• `unknown` 维度触发 `unknown_handling` 中的探测。<br>• 单测覆盖三值逻辑和例外顺序。M3 的基石回放复用此函数 | core §7.4 |
| M2-4 | `knowledge_search` | 召回：FTS5（≥3 字符）、LIKE（短词）、维度倒排、图邻域（父 / 兄弟 / composes）。<br>然后：`judge` 筛选 → 同一继承链取最具体的 → 按后验均值 × 匹配度排序（M3 改为 Beta 下界）。<br>返回 ≤3 张卡片（core §7.3 的 `card`）和命中级别 H0–H3。项目层覆盖全局层 | core §6.4、§8.6 |
| M2-5 | 模板激活 | `mission_dispatch` 增加参数 `template_ids`。runner 用 `knowledge/render.ts` 把模板正文、槽位展开结果和带 `expect` 的 procedure 渲染进 Mission 的 `sections.template`。<br>按模板的 `capabilities_required` 解析出 Provider：<br>• Skill → `additionalSkillPaths`<br>• MCP → `createMcpExtension({ loadConfig: () => ({ servers: <仅绑定的>, errors: [] }) })`，`exposure: "deferred"`，并在 `settingsManager.applyOverrides({ defaultTools: ["+tool_search"] })` 中启用 `tool_search`<br>• 声明了 codemode 的能力 → 加入 `createCodemodeExtension()`<br>**单测**断言：Mission 的 `resourceLoader.getSkills()` 只包含绑定的 Skill | core §9.3 |
| M2-6 | Toolsmith 与能力生命周期 | `capability_request` 创建缺口单，编排器派发 Toolsmith。Toolsmith 按 core §9.4 的顺序发现：私有白名单 → 官方 MCP Server / 已验证的 Skill 仓库 → 包仓库 → 封装 CLI → 自建 Skill。<br>• **隔离区**：产物先放在 `runs/<id>/quarantine/`。<br>• `skill_validate`：frontmatter 合规；扫描注入（去除零宽与双向控制字符，标记可疑的指令性语句）；生成权限清单。<br>• **一致性测试由 Verifier 编写**，不是 Toolsmith。<br>• 通过后 `provider_register`：计算内容 sha256，trust 从 candidate 升为 verified，移到 `skills/<name>@<hash8>/`，并建立 `implemented_by` 边。<br>• 引入外部依赖或下载时按 R2 审批。<br>• **使用前重新计算哈希，与登记值不一致则阻断** | core §9.4 |
| M2-7 | MCP 类 Provider | 用于 Web UI 等方向，例如供应商官方的浏览器自动化 MCP Server。<br>• Toolsmith 用 `pi.registerMcpServer` 在自己的 Mission 中试连。<br>• 记录完整工具定义（name / description / inputSchema / annotations）的哈希；连接时比对，不一致则阻断。<br>• 模型看到的描述由系统改写（core §11.2）。实现途径先验证 MCP 扩展是否支持覆盖描述；不支持时，用 `mission_submit` 等工具的 `prepareLoadout` 替换已声明工具的描述（extensions.md「Tool exposure」）。⚠ 需要实测 | core §9.4、§11.2 |
| M2-8 | Curator 与模板沉淀 | H0/H1 意图成功并关闭后，在后台派发 Curator，**不唤醒主会话**。<br>• 输入：episode 摘要、偏离、证据类型、指纹。<br>• 通过 `template_propose` 提交 spec，校验后以 `draft` 写入项目层。<br>• 初始边界 = 指纹在判别性维度上的取值；本次 episode 作为基石 | core §10.10 |
| M2-9 | Episode 与使用记录 | Mission 结束时写入 `episodes` 和 `template_uses`：<br>• `applied` / `cited`：由信封的 `used_templates` 申报，并与实际注入的模板比对。<br>• `retrieved_unused`：检索到但未注入的模板。<br>报告增加两项：使用的模板版本、新沉淀的模板和能力 | core §10.6 |

**验收**：

1. 在新仓库首次提出超卖意图：命中级别 H0，产出 1 个 draft 模板，以及至少 1 个 verified 能力（例如并发请求与状态读取脚本型 Skill）。
2. 第二次提出同类意图（换一个资源，例如优惠券配额）：命中 H2/H3，复用该模板和能力；Token 成本 ≤ 首次的 50%（报告中列出两次的成本）。
3. e2e 断言：
   - 主会话的系统提示和工具声明中**从不**出现任何能力正文、MCP 工具 schema 或用户全局 Skill。
   - Mission 中只出现该 Mission 绑定的 Skill 和 MCP Server。
4. 手动改动一个已登记 Skill 的文件后，下一次使用被阻断，并记入 `audit`。

---

## 10. M3：反馈分诊与模板演化

**目标**：
- 全自动反馈闭环。
- 负反馈先分诊，只有 B 类才修改边界。
- 一切知识变更都走结构化增量和门禁，禁止整体重写。

| 编号 | 任务 | 要点 | 参考 |
|---|---|---|---|
| M3-1 | Evaluator | 用代码从信封、Verifier 结果和 `test_runs` 计算信号：经复验的缺陷数、误报、可复现率、**预言自检**、成本、`credibility`。<br>预言自检：<br>• 灵敏性：在 canary 上打开对应 bug 开关，或在测试桩中注入故障。<br>• 特异性：无故障时 k 次重跑结果稳定 | core §7.1、§10.2 |
| M3-2 | 作弊检测 | 规则：冻结后的修改企图、无断言的测试、预期值来自 SUT 当前输出（由 Verifier 审查）。命中时 `credibility = 0`，并给元模板记一次负反馈 | core §10.3 |
| M3-3 | 分诊 | `learning/triage.ts` 按固定顺序判定：S → N → E/C → J/I/P → B/K，判定不了归为 **U**（不更新）。<br>• SUT 不可达、连接重置、DNS 失败、恢复后被作废的 `test_run` → **E** 或 N，**不计负反馈**，以免网络抖动被误学成"模板不适用"。<br>B 与 K 的区分用对比集算法：失败指纹对比全部基石指纹，求最小区分维度组合。<br>• 有区分维度 → B。<br>• 没有区分维度 → 用 `streamSimple` 让 LLM 提出新维度假设，写入 `facets(proposed)`，等待探测，本次归为 U | core §10.5 |
| M3-4 | 统计 | `template_stats` 按情境簇维护 Beta(α, β)。<br>• **幂等**：以 `episode_id` 为键（`feedback.episode_id UNIQUE`）。写入反馈、更新统计、提交 Delta 放在**同一事务**中，崩溃后重跑不会重复计数。<br>• 只更新 `applied` / `cited` 的模板，权重为 `credibility`。<br>• B 类不计入适用域内的 β，改为给对应例外的支持度 +1。<br>• 检索排序改为 Beta 后验下界 | core §10.6 |
| M3-5 | Delta 算子 | 实现 reinforce、generalize、except、narrow、specialize、revise、pitfall、deprecate、rebind、facet.propose。<br>Curator 通过 `delta_propose` 提交，载荷做 TypeBox 校验。**全部是增量，禁止整体重写 `spec_json`** | core §10.7 |
| M3-6 | 门禁 | `learning/gate.ts`：<br>• schema 校验与图不变式（core §8.7）。<br>• **基石回放**：对全部基石指纹重跑 `judge`，判定必须不变。<br>• 证据阈值：边界类 ≥2，内容类 ≥3；`stable` 模板提高阈值。<br>• 严重度不得提高权重。<br>• 结果为 committed（生成新版本）、suspended 或 rejected。<br>• 同一模板的 Delta 串行处理（事务 + `head_version` 乐观锁） | core §10.8 |
| M3-7 | 状态机与逃生口 | 状态迁移 draft → candidate → stable → deprecated → retired，条件按 core §10.8。<br>逃生口（任一满足即进入内容审查）：例外 > 8；已知适用区小于峰值的 1/2；适用域内失败率下界超过阈值 | core §10.8 |
| M3-8 | 分层与晋升 | 项目层模板通过 `overrides` 边覆盖全局层。<br>`/test-promote <tpl>`：先检查晋升门禁（≥2 个项目、≥3 个情境簇、脱敏检查、基石回放），通过后由用户确认 | core §8.5、I-7 |
| M3-9 | Gardener 与校准 | `/test-garden`：<br>• 近似重复检测：FTS 相似度加 spec 结构比对，由 LLM 提出合并 Delta，走门禁。<br>• 例外折叠；容量上限；把整个图快照成 JSON 写入 `snapshots`。<br>`/test-calibrate`：在 canary 上跑固定的意图集，用 `bugs.json` 真值计算 Verifier 与 Evaluator 的精确率和召回率，写入 `calibration_runs`。漂移超过阈值时告警，并暂停自动提交 | core §10.9、§10.3 |
| M3-10 | 查看命令 | `/test-kb`：列出模板及其状态、例外和统计。<br>`/test-why <tpl>`：解释该模板为什么适用或不适用于最近一次指纹，并显示演化史 | core §17-9 |

**验收**（在 canary 上编写场景脚本，对应 core §14）：

1. **强化**：同步模式下对 2 类资源各运行 2 次，模板从 candidate 升为 stable。
2. **边界**：切换到 `CONSISTENCY=eventual` 后出现误报：
   - 分诊依次排除 S / N / E / C / I / P，得出"新维度假设 `consistency.model`"（U）。
   - 探测后再出现 2 次同类情况，门禁通过 `except`（改用"静置后判定"的预言）。
   - 全部同步基石的判定不变；模板在适用域内的 β 不增加。
3. **例外结果**：打开 B4 后，修补后的预言抓到真实缺陷，分诊为 S，计正反馈。
4. **门禁**：手工构造一个会改变基石判定的 Delta，被 rejected，并附回放报告。
5. **作弊**：faux 脚本在冻结后修改断言，被拦截，`credibility = 0`。
6. 第 2、4、5 条的确定性部分写成 faux e2e，进入 CI。

---

## 11. 不在本计划范围内

组织层（只实现全局层和项目层）、影子版本、汤普森采样探索预算、向量检索、Mission 递归派发、多用户并发写入同一个库、副作用 exactly-once（M1-14 只保证至多一次，exactly-once 留待迁移到 `pi-durable` 后实现）、非 canary 的真实项目基准集。

---

## 12. 风险与已知坑

| 风险 | 对策 |
|---|---|
| pi 处于 1.x 早期，API 演进快 | dev 依赖锁定 1.4.0；以已安装版本的 `.d.ts` 和 `examples/` 为准；发现差异就更新 §1 |
| 会话替换（`/new`、`/resume`、`/fork`、`/reload`）会销毁扩展实例，旧的 `pi` / `ctx` 失效后调用会抛错 | 编排器只保存纯数据和"当前句柄"；`session_shutdown` 幂等地中止所有 Mission |
| `agent_end` 之后可能还有重试、恢复或排队工作 | 判断空闲只用 `agent_settled` |
| 同一条 assistant 消息中的工具调用默认并行执行 | 写库的工具设 `executionMode: "sequential"`，或在事务中完成 |
| `promptGuidelines` 会平铺进 Guidelines，不带工具名前缀 | 每条都写明工具名，例如 "Use mission_dispatch when…" |
| Google 系模型不支持 `Type.Union` 字面量 | 枚举一律用 `StringEnum`（pi-ai） |
| 工具结果需要截断 | 用内置截断工具；大输出写入证据文件，结果中只返回路径 |
| codemode 每个进程最多 2 个 worker | 多个 Mission 并行使用 codemode 时会排队；需要时设置 `PI_CODEMODE_MAX_WORKERS` |
| bash 闸门的主机检查只能尽力而为，**不是安全边界** | 网络和文件边界依赖沙箱或容器。Windows 上在报告中明确写出"仅工具层策略" |
| Windows 下 bash 依赖 Git Bash，另有 `powershell` 工具 | 闸门同时覆盖两者；路径统一规范化（大小写、分隔符、`realpath`） |
| `node:sqlite` 仍有 ExperimentalWarning | 只过滤这一条 warning；`store/db.ts` 隔离驱动，必要时可换成 better-sqlite3 |
| pi-ai 自动合成的 `No result provided` 结果会诱导模型重跑有副作用的调用 | 恢复时先按 `tool_journal` 写入真实结果或"状态未知"（M1-14） |
| PID 复用导致误判"进程存活" | 同时检查心跳是否超时，两项都满足才判定存活 |
| 多个 pi 进程打开同一项目 | 只接管心跳已超时的 Mission；`project.db` 写入依赖 SQLite 锁，加 `busy_timeout` |
| 崩溃前会话尚未落盘（首轮回复之前） | 直接重新派发原 Spec（M1-14 第 4(e) 条） |
| FTS5 trigram 不匹配 1–2 个字的查询 | 用 LIKE 兜底（已实测） |

---

## 13. 交接说明

- **顺序**：M1 → M2 → M3。每个里程碑的交付物包括：代码、通过的 unit 和 e2e 测试、一份真实模型在 canary 上的运行报告（放在 `docs/runs/`）。
- **提交**：任务编号（如 `M1-6`）写进 commit 信息。
- **改编官方示例**：文件头注明来源路径和 pi 版本，例如 `// Adapted from @earendil-works/pi-coding-agent@1.4.0 examples/extensions/plan-mode`，方便以后同步上游。
- **设计问题**：先查 [agent-core.md](agent-core.md) 的对应章节。仍无法决定时，在本文档 §4 追加一条 `I-n` 决策并写明理由，然后继续，不扩大范围。
- **未核实项**（实施时第一步确认）：
  - pi-skills 中检索类 Skill 的名称（§2.5）。
  - ~~MCP 工具描述的改写途径（M2-7）~~：已核实，见 §1 与 `test/e2e/mcp.test.ts`。
  - ~~`fauxProvider` 接入 `ModelRuntime` 的方式（M1-13）~~：已核实，见 §1。
  - sandbox-runtime 在 SDK 子会话中的加载方式（M1-7）：API 已核实（§1），以替换 `bash` 工具的内联扩展注入；**未在 macOS/Linux 上实际运行**（开发机为 Windows）。
  - ~~`SessionManager.open()` 续跑与 `appendMessage()` 写入 toolResult（M1-14）~~：已核实，见 §1 与 `test/e2e/crash.test.ts`。
