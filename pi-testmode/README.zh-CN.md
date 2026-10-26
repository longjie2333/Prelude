# pi-testmode

[English](README.md) | 中文

一个 pi 扩展，把 pi 会话变成测试编排器。在测试模式下，你用自然语言说出测试意图；主会话把它记录下来，检索匹配的测试模板，派发 Mission（在隔离的进程内子会话中运行），然后进入待命，结果到达时再被唤醒。缺陷只有经过独立的 Verifier 复现后才计入。每次运行都会反馈到模板图中：模板得到强化，出现反例时增加例外而不是被改写，新能力经过获取、验证后用哈希锁定。设计：[../docs/agent-core.md](../docs/agent-core.md)；计划：[../docs/pi-testmode-plan.md](../docs/pi-testmode-plan.md)。

状态：M1–M3 里程碑已实现，并由 faux 模型测试覆盖。在靶场上的真实模型运行及遗留问题：[../docs/runs/](../docs/runs/2026-10-26-canary-deepseek/README.md)。

## 使用

```bash
npm install
pi -e ./pi-testmode            # 或：pi install ./pi-testmode
```

| 命令 | 作用 |
|---|---|
| `/test`（`--test`，Ctrl+Alt+T） | 切换测试模式 |
| `/test-missions` | 恢复、重新派发或放弃因崩溃而中断或阻塞的 Mission |
| `/test-kb` | 模板及其状态、统计、例外和待验证的假设 |
| `/test-why <tpl>` | 模板为什么适用（或不适用）于最近一次情境，以及它的演化史 |
| `/test-promote <tpl>` | 把稳定的项目层模板晋升到全局层（门禁 + 你的确认） |
| `/test-garden [--apply]` | 去重、例外折叠、容量检查、逃生口、快照 |
| `/test-calibrate [bugs=B1,B2] [hours=24]` | 对照靶场真值计算精确率和召回率；出现漂移时暂停学习 |

会接触被测系统的 Mission 需要授权范围文件 `<project>/.pi/testmode/scope.json`。它由你维护，Agent 永远无法写入：

```json
{
  "targets": [{ "host": "localhost:4100", "envs": ["local"], "allowed": ["functional", "load"] }],
  "egress_allowlist": ["registry.npmjs.org"]
}
```

没有这个文件时，只运行 R0/R1（只读）的 Mission。

## 在靶场上试用

```bash
npm run canary                      # http://localhost:4100，开启缺陷 B1、B2、B3
BUGS=none npm run canary            # 修复后的版本
CONSISTENCY=eventual BUGS=B4 npm run canary
```

然后在 pi 的测试模式下输入："测一下 canary 的下单接口在并发下会不会超卖"。再针对另一种资源提一次（"优惠券并发领取会不会超领"），应当命中第一次运行沉淀出的模板。

## 隔离

策略闸门在主会话和每个 Mission 中都会运行：只允许写入本 Mission 的 run 目录；保护 `scope.json`、数据库和扩展本身；首次安装依赖和连接 MCP Server 需要审批（R2），访问未知主机也需要审批（R4）；每次调用都记入审计。这个闸门不是安全边界。

在 macOS 和 Linux 上，Mission 的 `bash` 在 `@anthropic-ai/sandbox-runtime` 中运行，网络白名单取自授权范围。Windows 没有 OS 级沙箱，报告中会写明 "tool-layer policy only"（仅工具层策略）。需要在 Windows 上强隔离时，请用官方的 [Docker 方案](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md) 运行 pi。

## 开发

```bash
npm run typecheck
npm run format           # Biome，只做格式化
npm test                 # unit + e2e（faux provider，不需要网络和凭据），约 1 分钟
```

e2e 测试用脚本化的模型驱动真实的进程内 pi 会话：`loop`（M1 全链路）、`crash`（工具执行中途强杀后恢复）、`m2`（H0 → 模板草案 + 已验证的 Skill → 以 37% 的成本命中 H2）、`mcp`（MCP Provider、改写后的描述、哈希锁）、`m3`（agent-core §14 端到端）。设置 `TESTMODE_DEBUG=1` 可把它们生成的报告和审计记录写到磁盘。

`npm install` 使用 `legacy-peer-deps`（见 `.npmrc`）：否则 npm 11 在解析 vitest 的可选 peer 依赖时会崩溃。
