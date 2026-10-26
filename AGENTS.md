# AGENTS.md

本仓库实现 pi-testmode：一个 pi 扩展，把 pi 会话变成测试编排器（意图 → 后台 Mission → 独立复验 → 报告 → 模板演化，知识存 SQLite）。设计规范是 [docs/agent-core.md](docs/agent-core.md)，实施计划和全部已定决策在 [docs/pi-testmode-plan.md](docs/pi-testmode-plan.md)。

## 技术栈

- TypeScript（ESM，不编译）：pi 用 jiti 直接加载 `src/index.ts`；`tsc` 只做类型检查。Node ≥ 22.19（`node:sqlite`），开发机为 Windows。
- pi 1.4.0，包名只用 `@earendil-works/*`。旧的 `@mariozechner/*` 停在 0.73.1，不要引入。pi 的 API 以 `pi-testmode/node_modules/@earendil-works/pi-coding-agent/` 下的 `dist/**/*.d.ts`、`docs/`、`examples/` 为准；与 plan §1 不一致时回写 §1。
- pi 包和 `typebox` 是 peer 依赖（`"*"`，宿主提供），dev 依赖锁精确版本；唯一运行时依赖是 optional 的 `@anthropic-ai/sandbox-runtime`。
- 测试：vitest 4（`pool: "forks"`，超时 60s）。格式化：Biome 2.6.2，只开 formatter（linter 和 import 排序关闭）。没有 CI。

## 目录（代码都在 `pi-testmode/`）

| 位置 | 放什么 |
|---|---|
| `src/kernel/` | 策略闸门、命令分析、风险分级、scope、审批、预算。纯规则，不调 LLM |
| `src/orchestrator/` | 主会话工具（`intent_record` … `report_finalize`）、派发、复验判定、报告 |
| `src/missions/` | Mission 运行器（`createAgentSession`）、崩溃恢复、结果信封、`roles/*.md` 角色提示词 |
| `src/harness/` | `test_run`、`artifact_freeze`、内容寻址证据 |
| `src/knowledge/` | 模板 schema（TypeBox）、适用判定、检索、渲染、种子、知识表读写 |
| `src/capabilities/` | Skill 校验、Provider 登记与哈希锁、MCP 绑定 |
| `src/learning/` | M3：evaluator、triage、attributor、curator、gate、gardener、calibration |
| `src/store/` | `db.ts`（SQLite 包装）、`repos.ts`（M1 表）、`migrations/{project,global}/NNN_*.sql` |
| `src/mode.ts` | 测试模式开关、命令、钩子（改编自 plan-mode） |
| `canary/` | 靶场 SUT，零依赖；`bugs.json` 是真值 |
| `test/unit/`、`test/e2e/` | vitest；e2e 用 faux 模型驱动真实进程内 pi 会话 |
| `smoke/` | 真实模型冒烟运行脚本 |
| `docs/runs/` | 真实模型运行报告 |

逐文件说明见 plan §5。新增或移动模块时同步更新 §5 的目录树。

## 命令

在 `pi-testmode/` 下执行：

```bash
npm install                                       # .npmrc 的 legacy-peer-deps 不能删：npm 11 解析 vitest 可选 peer 会崩溃
npm run typecheck                                 # tsc --noEmit，约 10s
npm run format                                    # Biome 格式化 src/ test/ canary/ smoke/（不含 .md）
npm run format:check                              # 只检查，不改文件
npx vitest run test/unit/policy.test.ts           # 单个文件
npx vitest run test/unit/policy.test.ts -t "frozen artifacts"   # 单个用例
npm run test:unit                                 # 约 6s
npm test                                          # 全量 unit + e2e，约 1 分钟，无网络、无凭据
npm run canary                                    # 靶场 http://localhost:4100；BUGS=none / CONSISTENCY=eventual BUGS=B4
```

在仓库根目录手动试用：`pi -e ./pi-testmode`。

- 每次改动后跑 `npm run format`、`npm run typecheck` 和受影响的测试文件。改到 `kernel/`、`missions/`、`orchestrator/`、`learning/`、`store/` 或角色提示词时跑 `npm test`，交付前也跑一次全量。
- 当前基线是全部通过（13 个文件、97 个用例）。遇到失败先在未改动的代码上复现：原本就失败的，在交付说明里写明，不要顺手改测试让它通过。
- 格式由 Biome 决定，不用手动调。它管不到的写法照抄周围代码：相对导入带 `.ts` 后缀；纯类型导入用 `import type`（`verbatimModuleSyntax` 会强制）。
- Biome 排除了 Markdown：它会改写 `roles/*.md` 的 frontmatter，而这些文件是给模型看的提示词。
- `TESTMODE_DEBUG=1 npm test` 会把 e2e 的报告和审计写到 `pi-testmode/tmp/`（已被 gitignore）。新增调试输出用 `test/helpers.ts` 的 `debugFile(name)`。

真实模型冒烟运行：`SMOKE_MODEL=<provider>/<model> node smoke/run-smoke.mjs`。它使用用户 pi 登录的凭据，耗时 40–60 分钟、消耗数百万 token，**先征得用户同意**。它在临时目录里建隔离项目，所以被测 Agent 看不到 `canary/bugs.json` 和本文件；不要改成在本仓库里直接跑。结果用 `node smoke/usage.mjs <out>`（逐 Mission 的 token）和 `node smoke/reevaluate.ts <out>`（用新 evaluator 重评旧运行）分析，报告写到 `docs/runs/<日期>-<名称>/`。

## 项目约定

- **判决只来自 `test_run` 的退出码**，不来自模型的措辞。需要"判定"的新逻辑读 `test_runs` 表；复验结论由 `verifyClaim`（`missions/envelope.ts`）按复现率计算。
- **内核确定性**：适用判定、风险、门禁、分诊、指标都写成纯函数。LLM 只出现在角色对话和 `streamSimple` 单次判断中，输出先过 TypeBox 校验再入库。风险等级只由 `kernel/risk.ts` 算出，不能做成工具参数。理由：内核必须可回放，模型不能给自己授权。
- **工具**：用 `defineTool`，参数是 TypeBox schema，枚举用 `StringEnum`（`@earendil-works/pi-ai`）而不是 `Type.Union` 字面量（Google 系模型不支持）；写库的工具设 `executionMode: "sequential"`；每条 `promptGuidelines` 都写出工具名（pi 把它们平铺，不带前缀）。参考 `src/orchestrator/tools.ts` 的 `createIntentRecordTool`。新增工具还要：
  1. 在 `src/kernel/policy.ts` 的 `TESTMODE_TOOL_EFFECTS` 登记 effect 和 tier。不登记的话，它会被当成没有注解的 MCP 工具（有副作用）；
  2. Mission 工具加进 `missions/runner.ts` 里注册 Mission 工具的 `tools` 数组（只注册角色 `tools:` 里列出的），并写进对应 `roles/<role>.md` 的 `tools:`；主会话工具加进 `mode.ts` 的注册列表和 `TESTMODE_TOOLS`（测试模式下启用的工具）。
- **错误**：前置条件不满足就 `throw new Error(...)`，多条问题用 `- ` 列出（见 `createIntentRecordTool`）；工具执行了但结论是错误时，返回 `textResult(..., { isError: true })`（见 `harness/tools.ts`）。闸门 handler 出错一律拦截（fail-closed），不要用 `catch` 放行。
- **日志**：`src/` 不用 `console`。需要追溯的事件写 `audit(store, {...})`（只追加，触发器禁止改删），输入只记 `digest()`，不记原文。
- **SQL 归属**：每张表的读写由拥有它的模块提供，写成导出的具名函数，业务流程只调用这些函数，不内联 SQL。M1 的表在 `store/repos.ts`（如 `closeIntent`），M2 的知识表在 `knowledge/store.ts`，M3 的表在各自模块里（如 `learning/stats.ts` 的 `getStats` / `bumpStats` 负责 `template_stats`）。反例：`learning/pipeline.ts:196` 在流程里直接 `UPDATE intents`，而 `intents` 归 `repos.ts` 管。`learning/` 里现有的内联 SQL 是遗留写法，改到时顺手提成函数，不要照着写新的。
- **SQLite**：通过 `Store` 的 `run/get/all/tx`，命名参数用 `$name`。多步写入放进同一个 `store.tx`（反馈、统计、Delta 必须同一事务，plan I-19）。改 schema 只新增 `migrations/<layer>/NNN_*.sql`，不改已有迁移（迁移只按版本号执行，改了旧文件不会重跑）。
- **公共工具**：`src/util.ts`（`sha256`、`digest`、`newId`、`textResult`、`errorMessage`、`truncate`）、`src/kernel/paths.ts`（`canonicalPath`，处理 Windows 大小写和分隔符）、`src/paths.ts`（运行时目录）、`src/types.ts`（Role、状态、RiskTier、Cost）。
- **改编官方示例**：先查 plan §2 的复用清单。改编的文件头写来源，例如 `src/mode.ts` 的 `Adapted from @earendil-works/pi-coding-agent@1.4.0 examples/extensions/plan-mode/index.ts`。
- **注释**：文件头一段说明职责，并引用 plan / agent-core 的编号（`plan M1-6`、`decision I-10`、`agent-core §10.3`）；代码内注释只写"为什么"，尤其是被真实运行逼出来的规则（见 `capShellTimeout`）。
- **提示词即代码**：`roles/*.md` 和工具的 `description` 决定真实模型的行为，faux 测试测不出效果变化。改了它们要在交付说明里写"未经真实模型验证"，或征得同意后跑冒烟运行。faux 路由（`test/e2e/faux.ts` 的 `identify`）解析 `<mission>` 段的 `role:` 行，改 `renderMissionSpec` 格式时同步改它。
- **测试**：unit 用 `test/helpers.ts` 的 `tempProject()`（临时目录 + 真实 SQLite）和 `policyCtx()`；e2e 为每个角色写 faux 脚本（`createRouter`），canary 用 `startCanary()` 起在随机端口。修 bug 加回归测试。
- **文档语言**：`docs/` 用中文；`pi-testmode/README.md`、代码注释、commit message 用英文。

## 改动流程

- 新增函数、类型或工具前先搜：`grep -rn "<关键词>" pi-testmode/src`，重点看上面"公共工具"、`store/repos.ts`、`knowledge/store.ts`，以及 plan §2（pi 已有能力不自建）。
- 设计问题先查 agent-core 对应章节；仍决定不了，在 plan §4 追加一条 `I-n`（决策 + 理由），和代码同一个提交，然后继续，不扩大范围。
- 行为不变的重构和功能改动分开提交，大范围的纯格式化改动也单独提交。跨 5 个以上文件、改动工具名/参数/结果信封、或改动 DB schema 的，算大重构，先给计划。
- 修 bug 先找到根因。例：verifier "预算耗尽"的根因是预算把每轮重发的上下文重复计入（I-28），修的是记账口径，而不是调大预算。
- 单行修复直接改，加测试即可，不需要写计划。
- 交付时说明：改了什么、为什么、跑了哪些命令及结果、哪些没验证（例如提示词改动没跑真实模型、macOS/Linux 沙箱路径从未实际执行）。

## 边界

Always：
- 交付前在 `pi-testmode/` 下 `npm run typecheck` 和相关测试通过。
- 新行为和修复的 bug 有测试；新的设计决策记入 plan §4。
- 发现 pi 的实际 API 与 plan §1 不符时，更新 §1。

Ask first：
- 新增或升级依赖（包括 pi 和 Biome 的版本）；打开 Biome 的 linter 或 assist，或修改 `biome.json` 的规则。
  - 升级时先确认 npm 源上有各平台的二进制包。本机的 npmmirror 当时还没同步 `@biomejs/cli-win32-x64@2.6.3`，所以锁在 2.6.2。
- 修改工具名、参数、结果信封（`EnvelopeSchema`）或已提交的 DB schema；新增迁移。
- 删除文件；修改 `package.json` 脚本、`tsconfig.json`、`vitest.config.ts`、`.npmrc`、`.gitignore`。
- 运行真实模型冒烟运行（花用户的钱）；`git push`。

Never：
- 读取、打印或提交凭据：`~/.pi/agent/auth.json`、`.env*`、provider API key。
- 让 Agent 写 `.pi/testmode/scope.json`（人工维护的授权范围），或放宽闸门对它、`*.db`、扩展目录、冻结工件的保护。
- 提交运行时数据：`.pi/testmode/` 下除 `scope.json` 以外的内容、`*.db`、`tmp/`、`TESTMODE_DEBUG` 的输出。
- 跳过、删除或放宽断言来让失败的测试通过；改已提交的迁移文件。
- 把 `canary/bugs.json` 的内容放进 Mission 能看到的地方（提示词、上下文、模板种子）。

## 多模型协作

- 没有 PR 流程，直接在 `main` 上本地提交，交接信息写在 commit message 里。格式：`type(scope): summary`，type 用 `feat` / `fix` / `refactor` / `test` / `docs` / `style`（只改格式）/ `chore`（工具和配置），scope 一般是 `pi-testmode`；summary 末尾带任务或决策编号，如 `(M3-1..M3-10)`、`(I-28)`。正文写原因、逐条改动（每条一行 `- `），以及仍未完成的项（`Not met: …`）。参考 `git log -3`。
- 跨会话的长期状态写在 plan §13（交接说明、未核实项）和最新 `docs/runs/*/README.md` 的遗留问题里，不要只留在对话中。
- 命令、目录或约定变了，在同一个提交里更新本文件。

## 相关文档

- [docs/agent-core.md](docs/agent-core.md)：设计规范（角色、模板模型、反馈演化、安全治理）
- [docs/pi-testmode-plan.md](docs/pi-testmode-plan.md)：§1 已核实的 pi 事实、§2 复用清单、§4 决策 I-1…I-28、§12 已知坑、§13 交接
- [pi-testmode/README.md](pi-testmode/README.md)：用户命令、scope.json、隔离级别
- [docs/runs/2026-10-26-canary-deepseek/README.md](docs/runs/2026-10-26-canary-deepseek/README.md)：最近的真实模型运行与遗留问题
- pi 自带文档：`pi-testmode/node_modules/@earendil-works/pi-coding-agent/docs/`（`extensions.md`、`sdk.md`、`mcp.md`）和 `examples/extensions/`
