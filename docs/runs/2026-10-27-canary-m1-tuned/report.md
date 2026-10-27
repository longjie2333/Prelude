# canary（http://localhost:4100）下单接口并发超卖测试报告

## 结论

对 canary 库存/订单服务（OpenAPI 见 `/openapi.json`）做了功能与并发测试，重点验证下单与优惠券领取在并发下是否超卖/超领。共确认 **7 个已复验缺陷**，最严重的是 P0 级并发竞态：`POST /orders` 在 20 并发下把 10 件库存卖出 20 件（全部 201，无 409），`POST /coupons/{code}/claim` 在配额 5 时并发领取 20 次全部成功——两者都是读-判断-写非原子导致的超发，且库存/配额账目与实际成功次数不一致。此外下单与取消并发会互相覆盖库存（丢失更新）、`GET /products` 分页确定性丢掉最后一个商品、`POST /products` 对含 emoji 的合法 UTF-8 名称返回 500 且缺少类型/范围校验。

**核心问题回答：会超卖，且是必现的严重缺陷（5/5 轮复现）。**

主要假设（接收阶段已问过一次，其余自行决定并记录在此）：
- 按用户选择，`localhost:4100` 视为一次性测试环境，可随意写入/重置；并发强度上限为低（≤20 并发、每轮几十个请求）。
- 接口无需鉴权，匿名可用。
- 预期值依据均来自 `/openapi.json` 的契约与响应 schema（守恒、唯一性、"stock/remaining never goes below zero"、"Every product appears on exactly one page"、"Any UTF-8 text"），未凭业务猜测。
- 未做安全测试、未做破坏性删除、未做长时压测。
- 判断服务为内存态（`/reset` 回到种子数据），未验证持久化行为。

## 已复验缺陷

按严重程度排序。

### f-001 POST /orders 并发下单超卖：20 个并发请求全部成功，库存 10 卖出 20 件且库存只扣减 1~2 次（critical）

- 现象：`POST /reset` 后 p1 库存 10，并发 20 个 `POST /orders {productId:"p1",qty:1}`，20 个全部返回 201、0 个 409；随后库存为 8~9（只扣 1~2 次），`GET /orders` 中 placed 订单量为 20。5/5 轮复现。
- 预期：openapi.json 中 `POST /orders` 声明 "Stock is decremented by qty; stock never goes below zero"，超量请求应返回 409；不变量为 成功订单量 ≤ 初始库存、最终库存 = 初始库存 − 成功订单量。实际是典型 check-then-act 竞态。
- 复现步骤：reset → 并发 20 个下单 → 统计 201/409 并读库存与订单 → 断言守恒。复现脚本 `.prelude/work/repro-oversell.mjs`。
- 证据：`.prelude/work/evidence/oversell-run1.txt`。
- 复验：复现 3/3；审查结论 confirmed——断言直接源自 openapi 契约，脚本 5 轮输出与证据一致，同时违反"成功量 ≤ 库存"和"库存 = 初始 − 成功量"。

### f-002 POST /coupons/{code}/claim 并发超领：配额 5 被并发领取 20 次全部成功（critical）

- 现象：reset 后 SAVE10 `{quota:5,remaining:5}`，并发 20 个 claim 全部 201、0 个 409；remaining 仅降到 3~4。串行对照正确：第 1~5 次 201（remaining 4→0），第 6、7 次 409 `quota exhausted`。5/5 轮复现。
- 预期：openapi.json 中 claim 契约 "remaining never goes below zero"，成功领取数必须 ≤ quota 且 remaining = quota − 成功数。实际超发 4 倍。
- 复现步骤：reset → 并发 20 个 claim → 统计并读 `GET /coupons/SAVE10` → 断言。复现脚本 `.prelude/work/repro-coupon-claim.mjs`。
- 证据：`.prelude/work/evidence/coupon-run1.txt`。
- 复验：复现 3/3；审查结论 confirmed——quota 运行时读取而非硬编码，串行对照排除了配额本身问题，确证并发读-判断-写竞态。

### f-003 下单与取消并发时库存丢失更新：5 个新订单只扣了 1 件（账目 99，应为 95）（high）

- 现象：reset 后 p3 库存 100，串行建 5 个 qty=1 订单（→95），再并发执行"取消这 5 单 + 新建 5 单"；10 个请求全部成功（取消全 200、新单全 201），最终库存 99，而按账目应为 95。5/5 轮稳定。
- 预期：无论交错顺序，`stock = stock0 − sum(placed 订单 qty)` 必须成立（下单扣减、取消回补）。实际是 place 与 cancel 两条路径的非原子读-改-写互相覆盖。
- 复现步骤：reset → 串行建 5 单 → 并发（取消 5 单 + 新建 5 单）→ 读库存与订单 → 断言守恒。复现脚本 `.prelude/work/repro-cancel-order-race.mjs`。
- 证据：`.prelude/work/evidence/cancel-order-race-run1.txt`。
- 复验：复现 3/3；审查结论 confirmed——expected 由运行时 placed 订单计算，99 恰等于"5 次取消全生效、5 次下单仅 1 次生效"，与丢失更新吻合。

### f-006 POST /products 对含 emoji 的合法 UTF-8 名称返回 500（slugify: unexpected surrogate pair）（high）

- 现象：`POST /products {"name":"widget 🎉","stock":1}` 返回 500 `{"error":"internal error","detail":"slugify: unexpected surrogate pair"}`；`"🎉"`、`"a🎉b"` 同样 500。日文/带音标拉丁/西里尔/希伯来名称均正常 201。
- 预期：`NewProduct.name` 描述为 "Any UTF-8 text"，`POST /products` 只声明 201 与 400，合法 UTF-8 不应触发 5xx；且 500 泄露内部实现细节。
- 复现步骤：reset → 逐个用含 emoji 的名称创建商品 → 任一 5xx 即失败。复现脚本 `.prelude/work/repro-emoji-500.mjs`。
- 证据：`.prelude/work/evidence/emoji-500-run1.txt`。
- 复验：复现 3/3；审查结论 confirmed——非 emoji UTF-8 对照 201，排除了环境问题，定位到代理对处理缺陷。

### f-004 GET /products 分页丢商品：total=7 但翻遍所有页只能拿到 6 个，最后一个商品不可见（medium）

- 现象：`GET /products` 声称 `total=7`，但 size∈{2,3,4,5} 下遍历所有页并集恒为 6 且无重复，末页恒空（size=3 时 itemsPerPage=[3,3,0]）；种子商品 p7（Whatsit）可 `GET /products/p7` 读到 200，却不出现在任何一页。307 个商品时同样恒缺 1 个。
- 预期：openapi.json 中 `GET /products` 声明 "Every product appears on exactly one page"，遍历 page=1..pages 的并集必须等于 total、无重复无缺失。
- 复现步骤：reset → 对多个 size 遍历所有页收集 id → 断言并集大小 = total 且 p7 可达。复现脚本 `.prelude/work/repro-pagination.mjs`。
- 证据：`.prelude/work/evidence/pagination-run1.txt`。
- 复验：复现 3/3；审查结论 confirmed——确定性缺陷，列表与详情对同一商品存在性矛盾。

### f-007 POST /products 输入校验缺失：price 传字符串被存成 null，stock 传负数被接受，均违反 Product schema（medium）

- 现象：`{"name":"probe-price","price":"abc","stock":1}` → 201 且落库/返回 `price:null`；`{"name":"probe-neg","stock":-3}` → 201 且返回 `stock:-3`。两者 `GET /products/{id}` 一致。
- 预期：Product schema 声明 `price:number`、`stock:{type:integer,minimum:0}`，且 `POST /products` 声明 400 Invalid input；非法类型/越界值应被拒绝（400）或按默认值处理，不应创建出违反自身 schema 的持久化对象。
- 复现步骤：reset → 分别用非法 price、负 stock 创建 → 读回校验 schema。复现脚本 `.prelude/work/repro-product-schema.mjs`。
- 证据：`.prelude/work/evidence/product-schema-run1.txt`。
- 复验：复现 3/3；审查结论 confirmed——断言有 schema 依据，正确实现返回 400 时脚本会通过。

### f-005 POST /reset 的 stock 覆盖不校验：可设置负库存（-5）或非整数（null），违反 Product.stock schema（low）

- 现象：`POST /reset {"stock":{"p1":-5}}` → 200，随后 `GET /products/p1` 返回 `stock:-5`；`{"stock":{"p1":"abc"}}` → 200，随后 `stock:null`。此时该商品后续下单恒 409。
- 预期：`Product.stock` 为 `{type:integer,minimum:0}`，`/reset` 的 stock 覆盖应拒绝非整数/负值或钳制到 0，不应让服务进入违反自身 schema 的状态。
- 复现步骤：reset 覆盖负值 → 读回；再覆盖非整数 → 读回；最后 reset 恢复。复现脚本 `.prelude/work/repro-reset-negative-stock.mjs`。
- 证据：`.prelude/work/evidence/reset-negative-run2.txt`。
- 复验：复现 3/3；审查结论 confirmed——断言基于文档契约；审查员指出描述中"POST /orders 恒返回 409"为附带说明，核心违约已独立证实（见"未复现项"备注）。

## 建议

无（本次未记录 suggestion 类发现）。

## 未复现项

- 并发取消同一订单导致库存多次回补（`probe`，未记录为发现）：脚本 `.prelude/work/repro-cancel-race.mjs` 连续 5 轮，每轮 20 个并发 cancel 同一订单，结果均为 cancel200=1、cancel409=19、最终库存精确回到初始值，未观察到重复回补。判定为行为正确，不记录为缺陷。
- 并发创建商品丢数据/撞 id（`probe`，未记录为发现）：脚本 `.prelude/work/probe-product-create-concurrency.mjs`，20 并发创建全部 201、id 唯一、按 id 均可读、total 一致，未复现。
- 下单参数边界（`probe`，未记录为发现）：`.prelude/work/probe-order-boundaries.mjs`，qty=0/-1/1.5/字符串/null/缺失、未知商品、非法 JSON 均正确返回 400/404，且不改库存，未复现问题。
- 分页参数越界（`probe`，未记录为发现）：`size=-1`、`size=1e3` 被静默当成 1（返回 size:1、pages:7），`size=101` 被钳到 100，`page` 非法值回退到 1。行为虽不严格（违反 `size` 的 minimum/maximum 语义），但未造成数据错误，仅作观察，不单独记录为缺陷。
- f-005 描述中"负库存时下单恒 409"这一附带细节：复验审查指出描述与脚本分支不完全对应，但核心违约（reset 接受负值/非整数）已独立证实，不影响 f-005 的 confirmed 结论。

## 测了什么

- 接口面：`GET /health`、`POST /reset`、`GET/POST /products`、`GET /products/{id}`、`GET /coupons/{code}`、`POST /coupons/{code}/claim`、`GET/POST /orders`、`POST /orders/{id}/cancel`（覆盖 openapi.json 全部路径）。
- 方法：Node 内置 `fetch` 编写的自包含脚本；写操作串行执行，读操作可并行；每轮先 `POST /reset` 保证可重复。强度按用户上限（≤20 并发、每轮几十请求）。
- 盲区清单覆盖情况：
  - 并发与重复提交：**f-001**（下单超卖）、**f-002**（领券超领）、**f-003**（下单/取消丢失更新）、并发重复取消（未复现）、并发建商品（未复现）。
  - 边界与异常路径：下单 qty 边界（通过）、建商品字段边界（**f-006**、**f-007**）、reset 覆盖（**f-005**）、分页参数（观察，未单列）。
  - 错误提示与恢复：合法 UTF-8 触发 5xx（**f-006**），非法 JSON/类型返回 400 且不泄露堆栈（除 emoji 的 detail 字段外）。
  - 状态流转：订单 placed→cancelled 串行正确（重复取消 409、未知订单 404）、取消回补库存正确。
  - 性能退化：307 个商品时遍历所有页耗时 35ms，无 N+1 或明显退化；分页正确性问题见 **f-004**。
- 工具：仅用 Node.js 内置能力与 curl，未安装任何依赖。

## 没测什么

- 安全测试（扫描、注入、越权、鉴权绕过）：用户未授权安全测试方向；接口本身无鉴权，未做水平/垂直越权探测。
- 破坏性操作：未删除数据、未做不可逆破坏；`/reset` 仅用于恢复种子数据。
- 长时/高强度压测：按用户选择限制在 ≤20 并发、每轮几十请求，未测高负载下的稳定性、吞吐与内存增长。
- 持久化与重启：判断服务为内存态，未验证进程重启、多实例部署、数据库一致性。
- 可访问性、国际化展示层：无 UI，不适用。
- 配置与环境差异：只有一个环境，无特性开关/多环境对比。
- 授权范围外主机：未访问 `localhost:4100` 之外的任何目标（scope 仅允许该主机 functional+load）。
- 依赖安装：未安装任何依赖，无需用户批准。

## 隔离级别

仅工具层策略（Prelude 的闸门），不是安全边界。测试在 Windows 上通过本机 Node/curl 访问 `localhost:4100`，未使用沙箱或虚拟机；所有探测限定在 `.prelude/scope.json` 授权的 `localhost:4100`（functional、load）范围内。