---
name: rest-api
description: "Prelude interface 类别经验：HTTP/JSON services tested through their REST endpoints, usually documented by an OpenAPI/Swagger document: inventory/order/booking/ledger style backends and other stateful APIs where clients create resources and mutate counters, quotas or balances. Excludes browser-driven web apps and non-HTTP interfaces."
---

<!-- 由 Prelude 根据 lessons/*.json 生成，不要手改；修改经验用 kb_lesson_revise。 -->

# rest-api

HTTP/JSON services tested through their REST endpoints, usually documented by an OpenAPI/Swagger document: inventory/order/booking/ledger style backends and other stateful APIs where clients create resources and mutate counters, quotas or balances. Excludes browser-driven web apps and non-HTTP interfaces.

## 经验

### 把 OpenAPI 的 schema 和描述文本当作可执行断言，而不只是请求模板

- 适用：接口文档是唯一的行为契约来源（OpenAPI/Swagger），且其 schema 与描述文本里含有可判定的不变量：minimum/maximum、required、枚举、以及 "every item appears on exactly one page"、"never goes below zero" 这类明文断言
- 不适用：没有接口文档，预期值只能靠猜——此时不要用这条，改为记录行为观察而非缺陷；文档本身没有可判定的不变量描述（只有 summary，没有 schema 约束）；接口明确声明为实验性/无契约（如 /debug 端点）
- 做法：把文档里的每一句明文断言都变成一条可执行断言，而不是只看接口通不通：(1) 分页接口要遍历所有页，比对并集唯一 id 数与 total，并对缺失 id 调单条 GET 证明它确实存在（排除分页窗口伪影）；(2) 创建接口要把返回对象按响应 schema 校验一遍（如 stock 的 minimum 为 0、price 必须是 number），服务端把非法输入 201 出来比直接拒绝更隐蔽；(3) name/文本字段按文档声明的字符集测非 ASCII，务必用 Node fetch 直接发 UTF-8，不要用 shell 传中文（Git Bash 会破坏编码导致误判），并专门测 astral-plane/emoji 字符（UTF-16 代理对）——这类输入常让 slugify 之类的字符串处理抛 500 并泄露内部实现细节。合法输入得到 5xx 一律记为缺陷。
- 证据：4 条，来自 2 个项目（les-0108）

### 计数器类写接口必须做并发不变量测试，顺序调用会掩盖超卖

- 适用：一个 HTTP API 的写操作会消耗或退还一个计数器（库存、配额、座位、余额），接口文档声明了"不得为负/不得超卖"并有对应的 409 类拒绝码
- 不适用：目标是只读接口或文档没有声明计数器不得为负；服务端对同一资源加了串行化（如每资源锁/单写者队列），顺序与并发结果一致——先做 2 并发验证再下结论；接口用幂等键或版本号做乐观并发控制且响应明确返回冲突——此时应断言冲突码而非库存不变量
- 做法：顺序调用一次确认守卫存在（库存耗尽后应返回 409），然后用 Promise.all 同时发 N 个相同请求，断言两个不变量：successes*qty <= 初始值，且 初始值-最终值 == successes*qty。并发数 2~10 通常就够——超卖在 2 并发即出现，加大并发只放大幅度不改变结论。不要只测下单：同一根因常同时出现在领券/占座等"检查+扣减"接口上，应分别记为独立缺陷（不同接口需分别修复）。还要做交错探测：把退还操作（cancel/refund，+qty）与消耗操作（-qty）并发发出，检查 最终值+仍持有量 == 初始值；只守 409 检查的修复不会关闭这类丢失更新。
- 证据：4 条，来自 2 个项目（les-85a9）

## 待验证

只在一个项目中被证实过。用之前先确认适用条件；本次再次证实就用 kb_lesson_revise 追加证据，遇到反例就追加不适用条件。

无。

## 工具

- `scripts/interleave-probe/`：Companion to `rest-api/scripts/race-probe/`. `race-probe` fires N *identical* consuming
- `scripts/race-probe/`：Generic detector for **lost-update / oversell** bugs on HTTP APIs that keep a counter
