# Prelude 开发计划

> **依据**：[design.md](design.md)。按 M1 → M2 → M3 推进，每个里程碑验收通过后再进入下一个。
> **原则**：pi 已有的能力不自建；代码只做设计中列为"支撑"的部分；方法论写在 Skill 里，不写成代码流程。

---

## 0. 成功标准

1. **M1**：在 canary 上说一句"测一下这个服务"，模型从头到尾自主完成，交付一份带复验结论的报告。耗时和 token 明显少于旧实现（旧实现第 5 次运行：一个意图 25 分钟，处理约 590 万 token）。
2. **M2**：测试结束后经验和工具通过工具写入知识库，并由 git 同步到远程；第二次测同类系统时，模型读取并用上了这些经验，命中更快。
3. **M3**：在网站、安卓、Windows 桌面、安全扫描四类目标上各跑通一次，类别经验能跨项目晋升（candidate → confirmed）。

## 1. 已核实的 pi 事实（pi 1.4.0）

> 只能使用 `@earendil-works/*` 包；旧的 `@mariozechner/*` 停在 0.73.1。以安装后 `node_modules/@earendil-works/pi-coding-agent/` 下的 `dist/**/*.d.ts`、`docs/`、`examples/` 为准。发现与本节不一致时，回写本节。

| 能力 | API / 事实 | 用途 |
|---|---|---|
| 扩展 | `export default function (pi: ExtensionAPI)`，jiti 直接加载 TS；`package.json` 中 `pi.extensions` | 入口 |
| 命令 | `pi.registerCommand` / `registerFlag` / `registerShortcut` | `/test`、`/prelude-init`、`/prelude-sync` |
| 提示词 | `before_agent_start` 中修改 `event.systemPromptOptions.sections.<key>`；修改结果出现在 `session.messages[0].sections`，**不在** `session.systemPrompt` | 测试模式说明 |
| Skill 路径 | `resources_discover` 返回 `{ skillPaths }` | 挂载知识库 Skill |
| 工具 | `defineTool` / `pi.registerTool`，参数用 TypeBox；枚举用 `StringEnum`（pi-ai）；写文件的工具设 `executionMode: "sequential"`；`promptGuidelines` 每条都要写出工具名 | 写入工具 |
| 闸门 | `tool_call` 可以修改 input，或返回 `{ block, reason }`；handler 抛错时 fail-closed；codemode / MCP 发起的调用同样会经过 | 安全边界 |
| UI | `ctx.ui.select / confirm / input / notify / setStatus / setWidget`；`ctx.hasUI`、`ctx.mode`（tui / rpc / json / print） | 冲突询问、进度 |
| 执行命令 | `pi.exec(command, args, options)` | 调 git |
| 空闲 | `agent_settled` 表示不会再自动续轮；`agent_end` **不是**最终空闲 | 结束检查与同步 |
| 子会话 | `createAgentSession({ cwd, modelRuntime, model, tools, customTools, resourceLoader, sessionManager, settingsManager })`，之后 `bindExtensions({})`、`prompt()`、`dispose()`；`ModelRuntime.create({ authPath, modelsPath })` 读同一个 agentDir | 独立审查 |
| 资源隔离 | `DefaultResourceLoader({ noExtensions, noSkills, noPromptTemplates, noContextFiles, extensionFactories })` | 审查会话不加载用户资源 |
| 会话关闭 | `session.dispose()` **不会**触发 `session_shutdown`，需要时自行 `session.extensionRunner.emit({ type: "session_shutdown", reason })` | 审查会话收尾 |
| 测试替身 | `fauxProvider()`；`ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false })` 后 `runtime.registerNativeProvider(faux.provider)` | e2e |
| sandbox-runtime | `SandboxManager` 是全局单例，`wrapWithSandbox(cmd, shell, customConfig)` 可按命令传入配置 | macOS/Linux 隔离 |
| 提示词小节 | `sections.<key>` 由 pi 包上同名标签，扩展不要自己再包；`skills` 小节列出可用 Skill，可在 `before_agent_start` 里过滤 `systemPromptOptions.skills` | 测试模式外隐藏 test-pilot |
| 工具可见性 | `defaultActive: false` 的工具注册后不激活，用 `setActiveTools` 加入；模型看到的工具来自 system 消息的 `toolsAdded` / `toolsRemoved` | 只在测试模式加 Prelude 工具 |
| 子会话工具 | `createAgentSession({ tools })` 是白名单，`customTools` 里的工具也要列进去 | 审查会话 |
| `noSkills` | `DefaultResourceLoader({ noSkills: true })` 仍加载 `resources_discover` 返回的 `skillPaths` | e2e |
| 命令发消息 | 命令里的 `pi.sendUserMessage` 不等待它启动的运行；print/json 模式在命令返回后立即销毁会话，所以 `/test <目标>` 在这两种模式下要等到 `agent_settled` 再返回。SDK 会话的 `ctx.mode` 默认是 `"print"` | `/test` 无人值守 |
| RPC 对话框 | RPC 模式 `hasUI` 为真，支持 `select` / `confirm` / `input`，但不支持 `ctx.ui.custom` | questionnaire 回退为逐题询问 |
| `pi.exec` | 进程起不来（找不到解释器）时返回 `code: 1`，和"脚本以 1 退出"无法区分 | 复验重跑改用自己的 spawn |
| print 模式 | `pi -p` 即使只执行命令也要求有可用的模型凭据 | — |
| 安装 | npm 11 解析 vitest 的可选 peer 时崩溃，需要 `.npmrc` 设置 `legacy-peer-deps=true` | — |
| 运行时 | Node ≥ 22.19；Windows 上 bash 依赖 Git Bash，另有 `powershell` 工具；Git Bash 会把 `pi -p "/cmd"` 的 `/cmd` 改写成路径，需 `MSYS_NO_PATHCONV=1` | — |

## 2. 复用清单

| 来源 | 用法 |
|---|---|
| pi 内置工具 `read / bash / powershell / edit / write / grep / find / ls` | 模型的全部执行能力。测试模式下**不收窄**主会话的工具 |
| Agent Skills + `resources_discover` | 方法论、类别经验和工具的载体与按需加载 |
| 内置 MCP / `tool_search` / `codemode` | 用户已配置的 MCP（例如浏览器自动化）照常可用 |
| 官方示例 `plan-mode/` | 改编为模式开关、状态栏和 `appendEntry` 状态恢复 |
| 官方示例 `permission-gate.ts`、`protected-paths.ts` | 改编为闸门 |
| 官方示例 `sandbox/` | 改编为 macOS/Linux 的 OS 级隔离 |
| 官方示例 `questionnaire.ts` | 接收阶段一次性提问 |
| 官方示例 `status-line.ts`、`widget-placement.ts` | 进度展示 |
| 旧实现（提交 `f5d01c7` 中的 `pi-testmode/`） | 可以取回改写：`src/kernel/{command,paths,scope,policy}.ts`（命令分析、Windows 路径规范化、授权范围、闸门规则；去掉 Mission 和风险分级相关部分）、`canary/`（靶场 SUT 及真值 `bugs.json`）、`test/helpers.ts` 中的 faux 接入方式。取回时用 `git show f5d01c7:<path>` |

**不再使用**：多角色 Mission、SQLite、模板图与统计、分诊和门禁算法、curator。

## 3. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D-1 | 测试在用户当前会话中完成，不另派 Mission | 速度慢的根本原因是交接（design §1） |
| D-2 | 运行状态、发现、审计改用 JSON / JSONL 文件 | 用户决定；不再有需要事务的知识表 |
| D-3 | 跨项目知识库只经扩展工具写入，由代码调用 git | 用户决定；防止模型直接改坏共享知识 |
| D-4 | 每条经验存成一个独立的 JSON 文件；`SKILL.md` 由代码生成 | 减少合并冲突；保证格式与晋升规则由代码执行 |
| D-5 | `candidate` → `confirmed` 需要 ≥2 个不同 project 的证据，project id 由扩展填写 | 不需要人工审核时，这是防止一次结果被过度泛化的唯一保护 |
| D-6 | 结束时的合并冲突不阻塞报告，留到下次进入模式时询问 | 用户结束时可能已经不在场；改动在自己的分支上不会丢失 |
| D-7 | 复验分两步：代码重跑复现脚本 k 次，再由新上下文的只读模型审查 | 代码判断"是否复现"，模型判断"脚本是否真的证明了问题"；审查不看测试过程 |
| D-8 | 审计 JSONL 每行带前一行的哈希 | 文件做不到只追加，用哈希链让篡改可以被发现 |
| D-9 | 包名和目录统一用 `prelude`：全局目录 `~/.prelude/`，项目目录 `.prelude/` | 与用户指定的 `.prelude` 一致 |
| D-10 | 包放在仓库根目录，不再放 `prelude/` 子目录；闸门的"扩展目录只读"只在测试模式生效，且不包括项目自己的 `.prelude/` | 用户决定。扩展目录就是本仓库时，平时开发和本项目的 `.prelude/work/` 都要能写 |
| D-11 | `scope.json` 仍然只能由人维护：模型写入一律拦截；访问范围外的主机时弹窗，用户选"加入 scope.json"后由代码写入；`/test` 的目标里出现的主机在开始时一并询问；没有 UI 时一律拒绝 | 授权来自用户的明确选择，又不必让用户手写 JSON |
| D-12 | 测试模式下对模型隐藏 `canary/` 整个目录（读、shell 提到它都拦截），不只 `bugs.json` | `server.mjs` 的注释和代码同样写明了缺陷 |
| D-13 | `finding_record` 记录时把复现脚本和证据按 sha256 复制进 `evidence/`；复验跑冻结副本；`runs/`、`evidence/` 只经工具写入；代码重跑未复现的缺陷不再交给审查（结论 `not-reproduced`） | 复验的必须是当时记录的东西，模型之后改文件或改 findings.jsonl 都不能影响结论 |
| D-14 | 复现脚本约定：观察到问题才以非 0 退出；连不上目标、准备失败、意外异常以 0 退出 | 否则任何脚本错误都会被算成"复现"；审查只能兜底，不能依赖 |
| D-15 | 审查子会话的 token 用量写进审计 `verification` 事件的 `detail.reviewUsage` | 子会话没有会话文件，否则成本对比漏掉审查部分 |

## 4. 代码结构

```
<仓库根目录>/            # D-10
├── package.json        # pi.extensions: ["./src/index.ts"]；peer：@earendil-works/*、typebox 用 "*"；dev 依赖锁 1.4.0
├── .npmrc              # legacy-peer-deps=true
├── src/
│   ├── index.ts        # 注册命令、工具、钩子；createPrelude(options) 供测试注入
│   ├── context.ts      # 会话内共享状态：当前项目与运行、本会话的批准、审查用的模型
│   ├── paths.ts        # .prelude/、~/.prelude/、扩展目录的路径
│   ├── run.ts          # runs/<id>/state.json、findings.jsonl，证据冻结（D-13）
│   ├── mode.ts         # /test 开关、测试模式说明、状态恢复
│   ├── init.ts         # /prelude-init：项目 .prelude/、AGENTS.md 段落（M2-1 补全局配置、知识库克隆）
│   ├── questionnaire.ts # 改编自官方示例，测试模式下激活
│   ├── progress.ts     # test_progress、finding_record、状态栏与组件区
│   ├── verify.ts       # verify_findings：复现重跑 + 审查子会话
│   ├── report.ts       # report_finalize：报告骨架检查、结束检查
│   ├── kb/
│   │   ├── git.ts      # 调用 git：fetch / merge / commit / push、冲突识别、工作区校验
│   │   ├── sync.ts     # 进入与结束时的同步流程、冲突询问
│   │   ├── lessons.ts  # 经验的 schema、读写、晋升、修订
│   │   ├── tools.ts    # 工具入库（selfcheck）
│   │   ├── render.ts   # 由 lessons 生成各类别的 SKILL.md
│   │   └── api.ts      # kb_lesson_add / kb_lesson_revise / kb_tool_add / kb_category_add
│   ├── guard/          # gate.ts 规则、extension.ts 钩子、scope、路径、命令分析（从旧实现取回后改写）
│   ├── audit.ts        # 哈希链 JSONL
│   └── util.ts
├── skills/
│   └── test-pilot/     # 方法论 Skill（随扩展发布，初始化时复制进知识库）
├── canary/             # 靶场 SUT（从旧实现取回）
├── scripts/
│   └── run-canary.mjs  # 真实模型运行驱动：RPC 模式、无人值守、汇总耗时与 token
└── test/               # unit/、e2e/（faux）
```

## 5. 工具清单

| 工具 | 说明 | 里程碑 |
|---|---|---|
| `test_progress` | 报告阶段切换（intake / profile / execute / verify / report / retro），更新状态栏 | M1 |
| `finding_record` | 记录一个发现：标题、严重程度、类型（defect / suggestion）、复现脚本路径、证据。写入 `runs/<id>/findings.jsonl` | M1 |
| `verify_findings` | 对全部未复验的发现执行 D-7，返回结论 | M1 |
| `report_finalize` | 检查报告是否包含必需小节，登记报告路径，执行结束检查（系统笔记、知识库同步） | M1 |
| `kb_lesson_add` | 新增经验。必填：类别、title、applies_when、guidance、证据（引用本次的 finding id） | M2 |
| `kb_lesson_revise` | 给已有经验追加反例，或改进 guidance、追加证据 | M2 |
| `kb_tool_add` | 从 `.prelude/work/` 入库一个工具（先运行 selfcheck） | M2 |
| `kb_category_add` | 新建类别：维度和描述 | M2 |

所有工具都设 `executionMode: "sequential"`，并写有带工具名的 `promptGuidelines`。

## 6. M1：单次测试闭环

**目标**：一句话交出去，最后拿到一份可信的报告。本阶段不涉及知识库。

| 编号 | 任务 | 要点 |
|---|---|---|
| M1-1 | 包骨架 | 按 §4 建目录；`npm run typecheck`、`vitest` 可运行；`pi -e <仓库路径>` 能加载 |
| M1-2 | 初始化（项目部分） | `/prelude-init`：<br>• 创建 `.prelude/` 和 `project.json`（随机 id）。<br>• 询问 `notes/`、`reports/` 是否纳入版本管理，据此生成 `.prelude/.gitignore`。<br>• 在 `AGENTS.md` 末尾追加或更新 Prelude 段落（用标记包围，可以重复执行）。<br>• 首次 `/test` 时如果没有初始化，自动进入此流程 |
| M1-3 | 模式与提示词 | `/test [目标]` 开启测试模式：<br>• `sections.prelude` 写入简短说明：按 `test-pilot` Skill 执行，接收阶段一次性提问，之后不再询问，用 `finding_record` 记录发现。<br>• 不收窄工具。<br>• 用 `appendEntry` 恢复状态 |
| M1-4 | 方法论 Skill | `skills/test-pilot/SKILL.md` 及 `references/`：<br>• 流程：design §4。<br>• 盲区清单。<br>• 各目标类型的接收问题模板：网站、接口、apk、exe、CLI。<br>• 报告模板与复现脚本约定（退出码非 0 = 复现）。<br>此阶段先从扩展自带的 Skill 路径加载，M2 改为从知识库加载 |
| M1-5 | 闸门 | 从旧实现取回改写：<br>• 范围外主机拦截（含 `localhost` 不带端口的情形，修掉旧的误报）。<br>• 危险命令拦截；首次安装依赖需审批。<br>• 保护路径：`scope.json`、`audit.jsonl`、`~/.prelude/kb/`、扩展目录。<br>• Windows 上在报告中标注"仅工具层策略" |
| M1-6 | 进度 | `test_progress`、`finding_record`，状态栏和组件区。`runs/<id>/state.json` 保存阶段和计数 |
| M1-7 | 复验 | `verify_findings`（D-7）：<br>• 复现脚本在 `.prelude/runs/<id>/verify/<finding>/` 下重跑 k=3 次，超时 120s。<br>• 审查子会话：只有 `read` / `bash`，不加载用户资源，结论写回 findings.jsonl。<br>• 子会话的 shell 调用同样经过闸门 |
| M1-8 | 报告与结束检查 | `report_finalize`：<br>• 检查报告包含这些小节：结论、已复验缺陷、建议、未复现项、测了什么、没测什么、隔离级别。<br>• 已复验缺陷与 findings.jsonl 一致。<br>• 提醒更新系统笔记 |
| M1-9 | 审计 | `audit.jsonl` 哈希链：记录工具调用（入参只记摘要）、拦截、审批、复验结论 |
| M1-10 | 测试 | **unit**：闸门、哈希链、findings 读写、报告检查。<br>**e2e（faux）**：走完一次完整流程，复验和报告结论正确。<br>**真实运行**：在 canary 上执行一次，结果写入 `docs/runs/` |

**验收**：

1. 在 canary 上输入 `/test 测一下 http://localhost:4100 这个服务`，接收阶段至少问一次（或判断信息已足够），之后全程不再打断，最后交付报告。
2. 对照 `bugs.json`，报告中已复验的缺陷至少包含 B1、B2、B3 中的 2 个，误报（复验后被拒绝的）不进入"已复验缺陷"。
3. 耗时和 token 记入运行报告，与旧实现第 5 次运行对比。
4. 越界写入、修改 `scope.json`、访问范围外主机都被拦截，并记入审计。

## 7. M2：知识库与经验积累

**目标**：复盘后的经验和工具能安全地写入共享知识库，并由 git 同步；之后的测试能读到并用上。

| 编号 | 任务 | 要点 |
|---|---|---|
| M2-1 | 初始化（全局部分） | `/prelude-init` 补充以下步骤：<br>• 创建 `~/.prelude/config.json`，询问远程仓库地址。<br>• 生成分支名，并检查远程上是否已被占用。<br>• 克隆或初始化 `~/.prelude/kb/`；远程为空时推送初始结构（`skills/test-pilot/`、`README.md`）。<br>• 没有远程也能纯本地使用 |
| M2-2 | git 封装 | `kb/git.ts` 用 `pi.exec("git", ...)`：<br>• 所有命令加 `-C <kb>`，输出用 porcelain 格式。<br>• 冲突识别：`git diff --name-only --diff-filter=U`。<br>• 工作区校验：`status --porcelain` 非空且不是工具写入 → 还原（`checkout` + `clean` 仅限 kb 目录）并记入审计。<br>• 不读取、不保存凭据 |
| M2-3 | 同步流程 | `kb/sync.ts`，按 design §6.2：<br>• 进入 `/test`：fetch → merge。有冲突时逐个文件用 `ctx.ui.select` 询问（保留本地 / 采用远端 / 两者都保留 / 中止）。<br>• 结束（`agent_settled` 且报告已登记）：合并到 main → push。有冲突就保留在自己的分支上，记一个待处理标记。<br>• `/prelude-sync` 可以手动触发。<br>• 无 UI（print 模式）时遇到冲突一律中止合并，留待下次处理 |
| M2-4 | 经验读写 | `kb/lessons.ts`：<br>• TypeBox schema 按 design §5.2。<br>• 晋升（D-5）。<br>• 修订时保留旧文本。<br>• 写入 → `render.ts` 重新生成该类别的 `SKILL.md` → 在一次提交中完成。<br>• 文件锁 `~/.prelude/kb/.lock` |
| M2-5 | 写入工具 | `kb_lesson_add`、`kb_lesson_revise`、`kb_category_add`。证据中的 finding id 必须存在于本次运行的 findings.jsonl，且已复验 |
| M2-6 | 工具入库 | `kb_tool_add`：<br>• 要求有 `README.md` 和 `selfcheck`。<br>• 在临时目录运行 selfcheck，超时 120s，退出码为 0 才通过。<br>• 复制到 `skills/<类别>/scripts/<tool>/`，并在该类别 `SKILL.md` 的工具清单中列出 |
| M2-7 | 挂载 | `resources_discover` 返回 `~/.prelude/kb/skills/`。方法论 Skill 改为从知识库加载 |
| M2-8 | 复盘 | `test-pilot` 的复盘步骤：先读相关类别，再按 P4、P5 决定新增或修订经验，写系统笔记。`report_finalize` 检查本次是否执行了复盘（有无 kb 写入，或明确说明"无可沉淀"） |
| M2-9 | 测试 | **unit**：晋升规则、修订保留、渲染、冲突识别与工作区还原（使用临时 bare 仓库作为远程）。<br>**e2e**：两台"机器"（两个克隆、两个分支）各写一条经验，同步后都能看到；两边修改同一条经验时触发冲突询问 |

**验收**：

1. 在 canary 上测完后，知识库新增至少 1 条 candidate 经验，自己的分支和 main 已推送到远程。
2. 换一个项目 id，再测 canary（模拟第二个系统）：模型读到了这条经验；如果它再次被证实，自动升为 confirmed。
3. 模型试图直接写知识库文件时被拦截；用 shell 绕过修改的内容，在下次写入前被还原并记入审计。
4. 制造冲突时，进入模式会询问；结束时的冲突不阻塞报告。

## 8. M3：多类目标与评测

**目标**：四类目标都能跑通，类别经验能跨项目积累；并用数据说明效果。

| 编号 | 任务 | 要点 |
|---|---|---|
| M3-1 | 网站 / UI | 接收问题和类别起点：浏览器自动化，优先使用用户已配置的 Playwright 类 MCP，或 Playwright CLI 脚本；截图作为证据；体验问题记为 suggestion |
| M3-2 | 安全 | 必须在 `scope.json` 中授权 `security-check`；扫描器（ZAP / nuclei 类）的原始结果不能直接算缺陷，需要有复现脚本 |
| M3-3 | 安卓 apk | 要求模拟器和 adb；接收阶段确认设备、安装方式和测试账号 |
| M3-4 | Windows 桌面 | 接收阶段确认隔离环境（Windows Sandbox 或虚拟机）；控件自动化（pywinauto 类），覆盖不到时用截图加视觉模型。最难的一类，允许只做到"能安装、启动并完成冒烟测试" |
| M3-5 | 评测 | 用 canary 和至少一个真实目标对比两种方式：①直接对模型说同样一句话；②Prelude。比较缺陷数、误报、耗时、token。结果写入 `docs/runs/` |
| M3-6 | 整理 | `/prelude-kb`：列出各类别的经验和状态，标出长期未被验证的经验和重复项。整理操作也通过 `kb_lesson_revise` 完成 |

**验收**：四类目标各有一份真实运行报告；至少一条经验因为跨项目证据升为 confirmed；评测结果显示 Prelude 在缺陷数或耗时上不差于直接对话。

## 9. 风险

| 风险 | 对策 |
|---|---|
| 模型不读该读的 Skill | `test-pilot` 的描述写清楚触发条件；`sections.prelude` 明确要求先读 `test-pilot` |
| 经验越写越多、互相矛盾 | 一条经验一个文件；修订必须写反例；M3-6 定期整理 |
| 自建工具换个输入就失效 | selfcheck 才能入库；README 记录已知失败 |
| shell 绕过闸门修改知识库 | 工作区校验和还原（M2-2）；git 历史可以回滚 |
| Windows 没有 OS 级隔离 | 报告中标注；建议使用官方 Docker 方案；打包程序放到 Sandbox 或虚拟机里运行 |
| 合并冲突频繁 | 一条经验一个文件；`SKILL.md` 是生成文件，冲突时直接重新生成 |
| pi API 变化 | dev 依赖锁 1.4.0，以 `.d.ts` 为准，更新 §1 |

## 10. 交接

**当前状态（2026-10-27）**：M1 完成。两次真实运行：[第 1 次](runs/2026-10-27-canary-m1/README.md)（44.9 分钟，未达成功标准 §0-1）、调整 Skill 与审查提示后的 [第 2 次](runs/2026-10-27-canary-m1-tuned/README.md)（13.9 分钟、processed token 为旧实现第 5 次的 33%，B1/B2/B3 全部复验确认，无误报）。验收 1–3 通过；验收 4 中改 `scope.json`、访问范围外主机两种情形只有 faux e2e 证据（真实运行中模型没有尝试）。每种配置只跑了一次，未测方差。macOS/Linux 的 OS 级隔离尚未接入。下一步：M2。

- 顺序 M1 → M2 → M3。每个里程碑交付：代码、通过的测试、一份真实运行报告（`docs/runs/<日期>-<名称>/`）。
- 新决策追加到 §3（D-n，写明理由），与代码放在同一个提交里。
- 旧实现中可以取回的部分见 §2，只取回、改写需要的部分，不要整体恢复。
- 方法论 Skill 和工具的 `description` 决定真实模型的行为，faux 测试测不出效果的变化。改了它们时，在交付说明里写明"未经真实模型验证"，或在征得用户同意后执行一次真实运行。
