# 真实模型冒烟运行：canary × DeepSeek-V4.1-Flash（2026-10-26）

> 计划 §13 要求的里程碑交付物：一份真实模型在 canary 上的运行报告。本次运行覆盖 M1 链路和 M2 复用；M3 的演化验收依赖多次受控运行，只在 faux e2e（`test/e2e/m3.test.ts`）中验证。
>
> 共 5 次运行。**最新有效结果是第 5 次**（预算记账改为"新增 token"之后），见下一节；第 3 次及更早的内容保留在后面作为历史。

## 第 5 次运行（预算记账修正后，当前结果）

改动（决策 I-28）：Mission 预算不再累计每轮重发的完整上下文，而是只计**新增 token** = 本轮提示比上一轮"提示 + 输出"多出的部分（新的工具结果、steer、压缩摘要）+ 本轮输出。原口径保留为 `processed`，用于成本报告。第 3 次运行的会话记录显示，原口径把同一段上下文重复计了 8–13 倍。默认预算按第 3 次的实测（每个 Mission 新增 11k–46k）重新设定为约 2 倍：scout 60k、executor 100k、verifier 80k、toolsmith 100k、curator 80k。

| | 意图 1：下单超卖 | 意图 2：优惠券超领 |
|---|---|---|
| 命中级别 | H0 | **H2**（命中意图 1 沉淀的 `tpl://project/concurrency.shared-quota.oversell-race`） |
| Mission | scout 1、executor 2、verifier 2、curator 1 | executor 1、verifier 1 |
| 超预算中止 | 无（scout 自行以 partial 提交） | 无 |
| test_run | 97 | 17 |
| 已复验缺陷 | **7**，未确认 0（B1 超卖，5/5 复现；另含优惠券超领、批量数量、丢失更新等变体） | **1**，未确认 0（优惠券超领） |
| 新增 token | 294,742（含 curator） | 127,090（**43%**） |
| processed token | 5,890,559（含 curator） | 853,099（**14%**） |
| 耗时 | 24.8 分钟 | 17.3 分钟 |

报告：[意图 1](run5/i-20261026-0029fb.md)、[意图 2](run5/i-20261026-9d7d70.md)；数据：[run5/summary.json](run5/summary.json)。意图 1 报告的 Missions 表（279,250 新增）生成于 curator 运行之前；意图 2 报告里的成本对比行和上表都包含 curator。

### 对照验收条件（第 5 次）

| 验收 | 结果 | 说明 |
|---|---|---|
| M1-1 派发后待命、完成后唤醒 | ✅ | 未出现 `mission_status` 轮询 |
| M1-2 真实模型发现 B1 并已复验 | ✅ | 7 条缺陷全部经独立 verifier 确认 |
| M1-3 越界操作被拦截并审计 | ✅ | 16 次拦截，9 次审批请求均被拒绝 |
| M1-4 判决只来自 `test_run` | ✅ | |
| M2-1 首次 H0，产出 draft 模板 | ✅ | curator 用了 15k / 80k |
| M2-1 至少 1 个 verified 能力 | ⚠️ 未覆盖 | 本次没有 Mission 申请能力，没有能力需要验证。第 4 次运行中有一个能力 47/47 通过却被拒，原因已修复（见下表第 10 条） |
| M2-2 同类意图命中 H2/H3 | ✅ | H2，executor 激活了该模板 |
| M2-2 成本 ≤ 首次 50% | ✅ | 新增 token 43%，processed 14% |

### 第 4、5 次运行发现并已修复的问题

| # | 问题 | 发现于 | 修复 |
|---|---|---|---|
| 9 | 预算按重发上下文累计，verifier 普遍"超预算"（第 3 次的根因） | 第 3 次数据 | 改为新增 token（I-28），并按实测重设默认值 |
| 10 | **一致性评分把 verifier 故意做的故障探测也算进去**：`http-burst-client` 的 47 项检查全部通过，却按 7/11 被拒；同类原因也导致第 3 次两个能力未通过 | 第 4 次 | 只统计 pass/defect 声明引用的 `test_run`（`conformanceScore`）；对第 4 次重算为 2/2 |
| 11 | curator 40k 预算读运行目录文件用光，没调用 `template_propose`，第二个意图因此退回 H0 | 第 4 次 | 预算 80k；角色提示要求以摘要为输入、尽早提交 |
| 12 | 作弊检测要求被 import 的辅助模块（`lib.mjs`、`oracle.mjs`）也"能失败" | 第 5 次 | 只检查被 `test_run` 直接调用的入口脚本 |
| 13 | verifier 在 `integrity_issues` 里写"None found…"或小的注意事项，被当成作弊，把可信度置 0 | 第 5 次 | 字段说明和 verifier 提示写明：每一条都会作废反馈，没有问题就省略 |

第 5 次的学习记录是在修复 12、13 之前算的，所以 3 个 executor 中有 2 个可信度为 0。用当前评估器重算（`node smoke/reevaluate.ts`），辅助模块误报消失；剩下的只是两条修复前写下的 verifier 备注。

### 仍未解决

- **processed 成本随轮数增长**。预算改为新增 token 后，Mission 能跑更多轮：第 5 次意图 1 的 processed 是第 3 次的约 3 倍（589 万对 197 万）；第 4 次一个 executor 用了 78k 新增 token，但 70 轮共处理 248 万 token。这才是提供方计费的量。要控制金额，需要另设按 `processed` 或美元的上限（`Budget.costUsd` 已支持，但这个代理不报价格）。
- **能力获取路径**本次未被触发；第 10 条修复后尚未在真实运行中验证。
- 授权范围写的是 `localhost:4100`，脚本里只出现 `localhost`（端口在别处拼接）时会按范围外主机拦截（R4）。这是偏保守的误报，未改。
- macOS/Linux 沙箱路径仍未实际运行。

---

以下为第 1–3 次运行（修正前）的记录。

## 设置

| 项 | 值 |
|---|---|
| 模型 | `magpie/trae-cn/deepseek-v4.1-flash`（116K 上下文，经本地代理 `127.0.0.1:3425`）。同一代理上的 `agent/gpt-6-astra` 返回 HTML 页面而不是 API 响应，不可用 |
| 宿主 | 真实 `pi` 1.4.0 CLI，RPC 模式，`-ne -e ./pi-testmode`，Windows（仅工具层策略，无 OS 沙箱） |
| SUT | canary，`:4100`，开启 B1、B2、B3；同步一致性 |
| 工作目录 | 临时项目目录（智能体看不到 `canary/bugs.json`）；`scope.json` 只授权 `localhost:4100` 的 functional + load |
| 人工审批 | 无人值守：驱动脚本对每个审批对话框回答 **Deny** |
| 驱动 | [`pi-testmode/smoke/run-smoke.mjs`](../../../pi-testmode/smoke/run-smoke.mjs)；进度从 `project.db` 只读轮询 |

两个意图依次提交：

1. 测一下 canary 的下单接口在并发下会不会超卖
2. 再看看 canary 的优惠券 SAVE10 在并发领取时会不会超领

共运行三次。第 1、2 次各自暴露了阻断性缺陷，被中止、修复后重跑；第 3 次是有效运行。三次的原始数据都在本目录。

## 第 3 次运行结果（有效）

| | 意图 1：下单超卖 | 意图 2：优惠券超领 |
|---|---|---|
| 命中级别 | H0 | **H2**（命中意图 1 沉淀的项目模板） |
| Mission | scout 1、toolsmith 2、verifier 2（1 个复验、1 个一致性检查）、executor 2、curator 1 | executor 6、verifier 5 |
| test_run | 27 | 46 |
| 已复验缺陷 | **B1 超卖：confirmed**（executor 5/6 复现，verifier 8 次重放中 6 次失败） | 0 confirmed；9 条声明为 inconclusive/refuted |
| Token | 1,966,720 | 2,184,267（意图 1 的 **111%**） |
| 耗时 | 15.6 分钟 | 38.6 分钟 |

完整报告：[意图 1](run3/i-20261026-6c3b10.md)、[意图 2](run3/i-20261026-706817.md)；结构化数据：[run3/summary.json](run3/summary.json)。

### 对照验收条件

| 验收 | 结果 | 说明 |
|---|---|---|
| M1-1 派发后待命、完成后唤醒 | ✅ | 主会话派发后结束本轮；每个结果唤醒一次；全程未调用 `mission_status` 轮询 |
| M1-2 真实模型至少发现 B1 并标注已复验 | ✅ | 意图 1 报告 "Verified defects (1)"，confirmed by 独立 verifier；对照组（串行下单）通过 |
| M1-3 越界操作被拦截并审计 | ✅ | 26 次拦截入审计：只读 scout 的写请求（R2/R3 升级被拒）、整盘扫描 `find /`（4 次）、运行目录外写入、改 `scope.json` 的命令 |
| M1-4 判决只来自 `test_run` | ✅ | 所有 defect/pass 声明都引用了 `test_run`；无引用的声明被 `mission_submit` 拒绝 |
| M2-1 首次 H0，产出 draft 模板 | ✅ | `tpl://project/concurrency.shared-resource.conservation-invariant`（draft），边界由内核从指纹推出 |
| M2-1 至少 1 个 verified 能力 | ❌ | Toolsmith 登记了 2 个候选 Skill（`http-concurrent-load`、`run-dir-writer`），都没有通过一致性检查升为 verified（一个检查超预算，一个检查未给出 pass 声明） |
| M2-2 同类意图命中 H2/H3 | ✅ | 意图 2 为 H2，6 个 executor 都激活了该项目模板 |
| M2-2 成本 ≤ 首次 50% | ❌ | 111%。原因见下文"预算记账" |
| 报告的诚实性 | ✅ | 意图 2 的 verifier 始终没有确认缺陷，报告把结论写成"强可复现证据，但未经验证器确认"，没有把它算进已复验缺陷 |

意外收获：scout 在只读侦察中独立发现了 **B2（最后一页少一条）**，作为观察写进了报告，未计为已复验缺陷。

## 本次运行发现并已修复的问题

真实模型暴露了 faux 测试覆盖不到的问题。以下都已修复，并补了回归测试（全部 93 个测试通过）：

| # | 问题 | 发现于 | 修复 |
|---|---|---|---|
| 1 | **复验判定要求全部一致**：竞态缺陷 8 次里 6 次复现、2 次没复现，被判为 inconclusive；主会话因此反复派发 executor，第 1 次运行陷入循环 | 第 1 次 | `verifyClaim` 改为复现率 ≥0.6 即 confirmed（core §7.5 `reproducibility pass >= 0.6`），一次都没复现才 refuted |
| 2 | **Mission 预算被主会话设得过小**（40k–90k）：记账按每轮完整上下文累计，executor 在跑第一个 `test_run` 前就耗尽 | 第 1 次 | 请求预算下限为角色默认值的一半（I-27），工具说明写明记账口径 |
| 3 | **到达 100% 立即中止**：scout 在调用 `mission_submit` 的同一轮被中止，发现全部丢失 | 第 2 次 | 100%–125% 之间只提示"立即提交"，超过 125% 才中止 |
| 4 | **无界整盘扫描**：toolsmith 执行 `find / -maxdepth 6`，阻塞 Mission 15 分钟以上；中止后 `find.exe` 成为孤儿进程 | 第 1、2 次 | 整盘/家目录扫描列为危险命令；Mission 的 bash/powershell 超时上限 120 秒 |
| 5 | `curl -D -`（输出响应头）被误判为带请求体的写请求 | 第 2 次 | 区分大小写：`-d/-F/-T` 才算请求体 |
| 6 | 只在运行目录内 `mkdir` 被当作 R2 未知副作用，只读 scout 无法建目录 | 第 1 次 | 只含 `cd`/`mkdir`/`touch`（且都在运行目录内）和只读步骤的命令为 R0 |
| 7 | **作弊检测误报**：`exit $fail`、`sys.exit(main())` 被认为"无法失败"，把合法测试的可信度置 0，学习几乎全部失效 | 第 3 次 | 有运行记录证明脚本以非零退出过即视为可失败；静态检查识别计算出的退出码、`raise`、`set -e`。对第 3 次的数据重算：6 个 executor 都不再误报，可信度 0.5–0.7 |
| 8 | **重定向误判**：引号内的 `accepted $N > capacity 5`、`(q,r)=>{...}`、注释里的 `->` 被当作写文件，`test_run` 被拦了 4 次 | 第 3 次 | 解析前先抹掉引号内文本和注释；排除 `=>`、`->`、`>=`、`2>&1` |

## 仍未解决

- **预算记账口径**。`message_end` 的 usage 把每轮重发的上下文都算进 token 数，一个 15 轮的 Mission 很容易超过 20 万。第 3 次运行中 4 个 verifier 因此超预算、没能提交，这是意图 2 没有 confirmed 缺陷、成本也超标的直接原因。下一步应把缓存命中的输入和重复上下文从预算中扣除（或按增量计），然后重跑以检验 M2 成本条件。
- **能力获取没有闭环**。两个候选 Skill 都没升为 verified，意图 2 也就没有能力可绑定。一致性 verifier 同样受预算问题影响。
- **H0 时主会话的派发策略**。主会话在一个意图内派发了多轮 executor（意图 1 共 2 个，意图 2 共 6 个），没有在第一次复验结论后停手。待预算问题解决后再观察。
- **macOS/Linux 沙箱路径**仍未实际运行（开发机为 Windows）。

## 复现

```bash
cd pi-testmode
SMOKE_MODEL=magpie/trae-cn/deepseek-v4.1-flash node smoke/run-smoke.mjs
node smoke/reevaluate.ts <输出目录>     # 用当前评估器重算已有运行
```

需要先在 pi 中 `/login` 一个可用的提供方；输出写到系统临时目录，`summary.json` 汇总意图、Mission、test_run、审计和学习记录。
