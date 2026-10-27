# AGENTS.md

本仓库实现 **Prelude**：一个 pi 扩展。测试人员只给一个测试目标，模型自主完成测试并交付报告，测完后复盘，把经验和工具写进跨项目共享的知识库（git 仓库）。

- 设计：[docs/design.md](docs/design.md)
- 实施计划与已定决策：[docs/plan.md](docs/plan.md)

旧实现 pi-testmode（多角色 Mission、SQLite、模板图）已删除，可以在提交 `f5d01c7` 中查看。plan §2 列出了值得取回的部分。

## 核心原则（design §2）

- **判断交给模型，代码只做支撑**：知识持久化与 git、独立复验、安全边界、进度展示。不要把测试方法、适用判断写成代码流程。
- **一个上下文做到底**：不要重新引入多角色调度。
- **跨项目知识库只经扩展工具写入**（`kb_*`），由代码调用 git；闸门拦截模型对 `~/.prelude/kb/` 的直接写入。
- **经验必须有证据**：证据引用本次已复验的 finding；`candidate` → `confirmed` 需要 ≥2 个不同 project，由代码判定。
- **负反馈是用错了地方**：修订时追加"不适用条件"，不删除原内容。

## 技术栈

- TypeScript（ESM，不编译），pi 用 jiti 加载 `src/index.ts`；`tsc` 只做类型检查。Node ≥ 22.19。开发机为 Windows。
- pi 1.4.0，只用 `@earendil-works/*`；旧的 `@mariozechner/*` 停在 0.73.1，不要引入。API 以 `node_modules/@earendil-works/pi-coding-agent/` 下的 `dist/**/*.d.ts`、`docs/`、`examples/` 为准；与 plan §1 不一致时回写 §1。
- pi 各包和 `typebox` 是 peer 依赖（`"*"`，由宿主 pi 提供）；dev 依赖锁精确版本。
- 存储只用 JSON / JSONL 文件，不用数据库。
- 测试用 vitest。格式化用 Biome，只开 formatter，并排除 Markdown（Skill 和提示词由人编写，不要被改写）。

## 目录与命令

包就是仓库根目录（D-10），结构见 plan §4。在仓库根目录执行：

```bash
npm install          # .npmrc 的 legacy-peer-deps=true 不能删：npm 11 解析 vitest 可选 peer 时会崩溃
npm run typecheck
npm run format
npm test             # unit + faux e2e，不调用真实模型
npm run canary       # 靶场，默认 http://localhost:4100
node scripts/run-canary.mjs   # 真实模型运行（消耗额度，先征得用户同意）；结果整理进 docs/runs/
                              # 设 PRELUDE_HOME=<临时目录>，不要碰用户真实的 ~/.prelude；RUN_KB_REMOTE=<bare 仓库>
                              # RUN_BASELINE=1：不加载 Prelude 的对照组（M3-5）
```

手动试用：`pi -e <仓库路径>`。在 canary 上做真实运行时，从仓库外的空目录启动 pi（测试模式下闸门对模型隐藏 `canary/`，D-12）。

在 Git Bash 里用 `pi -p "/命令"` 时先设 `MSYS_NO_PATHCONV=1`，否则 `/命令` 会被改写成 Windows 路径，作为普通提示词发给模型。

## 约定

- **工具**：用 `defineTool`，参数是 TypeBox schema；枚举用 `StringEnum`（pi-ai），不用 `Type.Union` 字面量；写文件的工具设 `executionMode: "sequential"`；每条 `promptGuidelines` 都要写出工具名。
- **错误**：前置条件不满足就 `throw new Error(...)`。闸门 handler 出错一律拦截（fail-closed）。
- **git**：只在 `src/kb/git.ts` 中调用（自己 spawn，`GIT_TERMINAL_PROMPT=0`，D-17），命令都带 `-C <kb目录>`；不读取、不保存凭据；冲突必须交给用户选择。测试用临时 bare 仓库当远程，不连真实远程。
- **日志**：`src/` 里不用 `console`；需要追溯的事件写 `audit.jsonl`（哈希链），入参只记摘要。
- **改编官方示例**：文件头写明来源，例如 `Adapted from @earendil-works/pi-coding-agent@1.4.0 examples/extensions/plan-mode/index.ts`。
- **注释**：文件头写一段职责说明并引用编号（`plan M2-3`、`design §6.2`、`D-5`）；代码内注释只写"为什么"。
- **Skill 即代码**：`skills/test-pilot/` 和工具的 `description` 决定真实模型的行为，faux 测试测不出效果变化。改了它们，交付说明里写明"未经真实模型验证"，或征得用户同意后执行一次真实运行。
- **文档语言**：`docs/` 用中文；代码注释和 commit message 用英文。

## 改动流程

- 新增函数或工具前，先搜现有代码和 plan §2（pi 已有的能力不自建）。
- 设计问题先查 design.md；仍定不了，就在 plan §3 追加一条 `D-n`（决策 + 理由），和代码放在同一个提交。
- 修 bug 先找根因，并补回归测试。
- 交付时说明改了什么、为什么、跑了哪些命令及结果、哪些没有验证。

## 边界

Always：
- 交付前 `npm run typecheck` 和相关测试通过。
- 新的设计决策记入 plan §3；发现 pi API 与 plan §1 不符时更新 §1。

Ask first：
- 新增或升级依赖；修改 `package.json` 脚本、`tsconfig.json`、`.npmrc`、`.gitignore`。
- 修改已发布的工具名、参数或经验的 JSON schema。
- 删除文件；执行真实模型运行（会消耗用户的额度）；`git push`（对本仓库）。

Never：
- 读取、打印或提交凭据：`~/.pi/agent/auth.json`、`.env*`、API key、git 凭据。
- 让模型直接写 `~/.prelude/kb/`、`.prelude/scope.json`、`.prelude/audit.jsonl`，或放宽闸门对它们的保护。
- 提交运行时数据：`.prelude/work/`、`evidence/`、`runs/`、`audit.jsonl`。
- 跳过、删除或放宽断言来让失败的测试通过。
- 把 canary 的 `bugs.json` 或 `server.mjs` 里的缺陷说明放进模型能看到的地方（Skill、提示词、知识库）。

## 多模型协作

- 直接在 `main` 上本地提交，交接信息写在 commit message 里。格式为 `type(scope): summary (任务编号)`，type 取 `feat` / `fix` / `refactor` / `test` / `docs` / `style` / `chore`。正文写原因、逐条改动、仍未完成的项（`Not met: …`）。
- 跨会话的长期状态写在 plan §10 和最新的 `docs/runs/*/README.md` 中，不要只留在对话里。
- 命令、目录或约定变了，在同一个提交里更新本文件。
