# Prelude

Prelude 是一个 [pi](https://github.com/earendil-works/pi) 扩展：测试人员只说一句测试目标，模型在同一个会话里自主完成测试，交付一份**经过独立复验**的报告；测完后复盘，把经验和工具写进跨项目共享的知识库（一个 git 仓库），下次测同类系统时用上。

```
/test 测一下 http://localhost:4100 这个服务
```

- 设计：[docs/design.md](docs/design.md)
- 计划、已定决策与当前状态：[docs/plan.md](docs/plan.md)（§3 决策表，§10 状态）
- 真实运行记录：[docs/runs/](docs/runs/)

## 它做什么，不做什么

模型负责判断：接收信息、勾勒目标、确定方向、选工具或自己写、执行、写报告、复盘。方法论写在 Skill（[skills/test-pilot/](skills/test-pilot/SKILL.md)）里。

代码只做模型自己做不到的事：

| 能力 | 说明 |
|---|---|
| 独立复验 | 每个缺陷的复现脚本在干净目录重跑 3 次（退出码非 0 = 复现，≥ 60% 算复现），再交给一个看不到测试过程的新会话审查。只有两步都通过的才进报告的"已复验缺陷" |
| 报告检查 | 必需小节、每个发现放在和复验结论一致的小节、复盘内容和审计里的知识库写入一致 |
| 知识库 | 经验一条一个 JSON 文件；≥ 2 个不同项目的证据才升为 confirmed（代码判定）；修订保留原文；由代码提交、合并、推送 |
| 闸门 | 授权范围外的主机、危险命令、首次安装依赖、安全扫描器、在本机运行安装程序、写受保护文件，都在工具调用前拦截或询问；出错一律拦截 |
| 审计 | `.prelude/audit.jsonl`，每行带前一行的哈希 |
| 进度 | 状态栏显示阶段和发现数，组件区显示最近的发现和知识库同步状态 |

## 安装

需要 Node ≥ 22.19 和 pi 1.4.0。

```bash
git clone <本仓库> prelude
cd prelude
npm install
```

在 pi 里加载，任选一种：

```bash
pi -e /path/to/prelude
```

```bash
pi install /path/to/prelude
```

## 使用

在要测试的项目目录里启动 pi，然后：

```
/test <测试目标>
```

第一次运行时会自动初始化：

1. 在项目里建 `.prelude/`，问你系统笔记和报告是否纳入版本管理，并在 `AGENTS.md` 里加一段 Prelude 说明。
2. 问知识库的 git 远程地址（留空 = 只在本机）。克隆或初始化 `~/.prelude/kb/`，并为这台机器建一个自己的分支 `kb/<用户>-<主机>-<4位码>`。

之后模型会读方法论，**一次性**问完缺的信息（环境、账号、允许的操作），然后不再打断你，直到交付报告。运行中你仍然可以输入消息引导它：`Enter` 在当前一步结束后生效，`Alt+Enter` 在整个任务结束后生效。

### 授权范围 `.prelude/scope.json`

只能由人维护，模型写入一律被拦截。模型访问不在其中的主机时会弹窗问你，选"Add to scope.json"会以 `functional` 加入。

```json
{
  "targets": [
    { "host": "staging.example.com", "allowed": ["functional"] },
    { "host": "localhost:8443", "allowed": ["functional", "security-check"] }
  ],
  "egress_allowlist": ["registry.npmjs.org"]
}
```

| 字段 | 含义 |
|---|---|
| `targets[].host` | `host` 或 `host:port`；`*.example.com` 匹配子域名；`localhost`、`127.0.0.1`、`::1` 互相等价 |
| `targets[].allowed` | `functional`、`load`、`security-check`、`destructive`。安全扫描器（nuclei、ZAP、sqlmap、ffuf、nmap 等）只能对带 `security-check` 的目标运行，弹窗批准不会授予它 |
| `egress_allowlist` | 不算测试目标、但允许访问的主机（例如包仓库） |
| `isolated_host` | 设为 `true` 表示 pi 本身运行在一次性的 Windows Sandbox 或虚拟机里，允许在本机安装被测程序；默认在测试模式下拦截 |

### 命令

| 命令 | 作用 |
|---|---|
| `/test <目标>` | 开始一次测试；不带目标时开关测试模式 |
| `/prelude-init` | 重新初始化项目和知识库（例如改变笔记是否纳入版本管理） |
| `/prelude-sync` | 立即同步知识库：合入远程 main（有冲突逐个文件问你），再推送 |
| `/prelude-kb` | 列出知识库的类别和经验，标出长期未被证实和疑似重复的经验 |

测试模式下模型多了这些工具：`questionnaire`、`test_progress`、`finding_record`、`verify_findings`、`report_finalize`，以及有知识库时的 `kb_category_add`、`kb_lesson_add`、`kb_lesson_revise`、`kb_tool_add`。

### 产出

```
<项目>/.prelude/
├── project.json   # 项目 id
├── scope.json     # 授权范围（人工维护）
├── notes/         # 系统笔记（模型写）
├── reports/       # 测试报告
├── work/          # 模型的脚本和草稿
├── evidence/      # 冻结的复现脚本和证据（按 sha256 命名）
├── runs/<id>/     # state.json、findings.jsonl、复验输出
└── audit.jsonl    # 审计（哈希链）

~/.prelude/
├── config.json    # 知识库目录、远程、main 分支、本机分支
└── kb/            # 知识库：skills/test-pilot/ 和各类别 skills/<类别>/
```

`work/`、`evidence/`、`runs/`、`audit.jsonl` 永远不纳入版本管理。

## 限制

- **Windows 上只有工具层策略**（闸门在工具调用时检查命令），**不是安全边界**：命令分析是尽力而为，脚本内部的行为看不到。需要隔离时请在容器或虚拟机里运行 pi。macOS/Linux 的 OS 级隔离尚未接入。
- 打包程序（exe、msi）应放在 Windows Sandbox 或虚拟机中测，apk 放在模拟器或测试机上。
- 知识库里的 `test-pilot` 是初始化时从扩展复制的，扩展更新后不会自动同步。
- 方法论和工具说明决定真实模型的行为，单元测试测不出它们的效果；已验证的情况见 [docs/runs/](docs/runs/)。

## 开发

```bash
npm run typecheck
npm run format
npm test              # unit + 用 faux 模型的 e2e，不调用真实模型
npm run canary        # 靶场：带预置缺陷的库存/订单服务，http://localhost:4100
```

代码结构见 [docs/plan.md §4](docs/plan.md)，开发约定见 [AGENTS.md](AGENTS.md)。

### 真实运行与结果收集

无人值守的真实运行（会消耗模型额度）：

```bash
PRELUDE_HOME=/tmp/prelude-home node scripts/run-canary.mjs
```

`PRELUDE_HOME` 让运行使用临时的知识库，不碰你真实的 `~/.prelude`。其他环境变量（外部目标、对照组、知识库远程）见脚本文件头。

把一次测试的结果整理进 `docs/runs/`（报告、发现、阶段耗时、token、审计校验、知识库写入，并生成一份带"测试人员记录"空栏的 README）：

```bash
REDACT="密码1,密码2" node scripts/collect-run.mjs <项目目录> <名称>
```

## 状态

M1（单次测试闭环）、M2（知识库与 git 同步）完成，各有真实运行记录。M3（网站、安全、安卓、Windows 桌面与评测）的代码已完成，真实运行进行中，见 [docs/plan.md §10](docs/plan.md)。
