# canary 下单接口并发超卖测试报告

- 目标：http://localhost:4100（Canary inventory/order service v1.0.0，接口文档 `/openapi.json`）
- 日期：2026-10-27
- 授权范围：`localhost:4100` 的 `functional` + `load`

## 结论

测了 canary 的库存/订单/优惠券接口，重点是 `POST /orders` 在并发下是否超卖。**会超卖**：库存扣减是"读-改-写"式非原子操作，库存 1 的商品并发 10 单全部返回 201，卖出 10 件；同样的缺陷在优惠券领取接口上表现为配额超发（quota=5 却发放了 20+ 次）。共 5 个已复验缺陷（1 个 critical、2 个 high、2 个 medium）和 1 条建议。此外 `GET /products` 分页恒定漏掉最后一个商品（total 比实际能翻出的多 1），属于高影响的数据可见性缺陷。整体判断：**该服务不能用于任何有真实库存或真实权益的场景**，直到库存与额度的扣减改为原子操作。

接收阶段的假设（用户已确认的写在前面，其余为自己决定）：

- 用户确认：并发强度按"中等（20–50 个并发请求）"；可以随时 `POST /reset` 重置数据；除下单超卖外顺带覆盖同类库存/配额一致性问题。
- 自己决定：该服务无鉴权、无账号体系，故不做越权测试；`POST /reset` 是唯一的状态重置手段，每个复现脚本运行前都先调用它；判定标准以 `/openapi.json` 的契约原文为预期依据（`POST /orders` 的 "stock never goes below zero"、`GET /products` 的 "Every product appears on exactly one page"、`Product.stock` 的 `minimum: 0`、`NewProduct.name` 的 "Any UTF-8 text"）。
- 强度偏差（如实说明）：用户选的是 20–50 并发。主结论均在此范围内得出（多数用 10–20）。另有一次探测把 p3（库存 100）的并发开到 200 单以观察规模效应，仅 1 轮、未用于任何缺陷结论。

## 已复验缺陷

### f-001 并发下单超卖：库存 1 的商品并发 10 单全部 201，库存守恒被破坏（critical）

- 现象：`POST /orders` 的库存扣减不是原子操作。把 p5 库存置为 1 后并发发 10 个 `{"productId":"p5","qty":1}`，全部返回 201 Created，`GET /orders` 里有 10 个 `placed` 订单共卖出 10 件，而商品只有 1 件；库存最终停在 0。规模上同样成立：库存 3 并发 20 单 → 20 个 201、卖出 20 件；库存 100 并发 200 单 → 200 个 201、卖出 200 件；库存 25、qty=2、并发 50 单 → 50 个 201、卖出 100 件。并发降到 2 也稳定复现（10/10 轮都是 `201,201`）。
- 预期：`/openapi.json` 中 `POST /orders` 明确写着 "Place an order. Stock is decremented by qty; stock never goes below zero."，并定义 `409 Insufficient stock`。即库存 N 时成功下单的总数量不得超过 N，守恒关系「剩余库存 + 已售数量 = 初始库存」必须成立。实测 p5 初始 1、售出 10、剩余 0，守恒值 10 ≠ 1。
- 连带效应：超卖订单被取消时按订单 qty 回补库存，会把库存补到超过初始值。实测库存 1 → 并发 10 单（接受 8 单）→ 全部取消 → 库存变成 **8**，凭空产生 7 件库存（`repro-cancel-inflates-stock.mjs`，证据 `evidence/cancel-inflates.log`）。这会让账实不符被进一步放大。
- 对照（证明不是断言写错）：顺序下单时服务是正确拒绝的 —— 库存 2 顺序下 4 单 → `201,201,409,409`；同一订单并发取消 10 次 → 1 次 200 + 9 次 409，库存只回补一次。所以问题只在并发写路径。
- 复现步骤：`POST /reset {"stock":{"p5":1}}` → 并发 10 次 `POST /orders {"productId":"p5","qty":1}` → 10 个响应全 201，`GET /orders` 有 10 个 placed 订单，`GET /products/p5` 库存 0。
- 复现脚本：`.prelude/work/repro/repro-oversell.mjs`
- 证据：`.prelude/work/evidence/oversell-1.log`、`oversell-rounds.log`、`oversell-minimal2.log`、`cancel-inflates.log`
- 复验：复现 3/3（exit 1，201 数量分别为 9/10/10）。审查结论 confirmed：预期来自契约原文而非抄输出；脚本在目标不可达或前置状态不符时 exit 0，仅在 `accepted > STOCK` 时失败；顺序对照路径证明正确实现不会误报。

### f-002 优惠券配额并发超发：quota=5 的 SAVE10 并发 20 次领取全部 201（high）

- 现象：`POST /coupons/{code}/claim` 的额度扣减同样不原子。SAVE10 `quota=5 / remaining=5`，并发 20 次领取 → 20 个请求全部 201，而 `GET /coupons/SAVE10` 的 remaining 只从 5 变成 4（19 次扣减被覆盖丢失）。之后继续顺序领取还能再成功 4 次，整轮实际发放 24 次，远超 quota 5。4 轮实测超额分别为 15/15/15/15，另一组 4 轮为 19/21/19/19。并发降到 2 也稳定复现（每次 `201,201` 而 remaining 只 -1）。
- 预期：`/openapi.json` 中该接口写明 "Claim one use of a coupon. remaining never goes below zero."，并定义 `409 Quota exhausted`。即最多成功领取 remaining 次，且守恒「成功领取次数 = 初始 remaining − 当前 remaining」必须成立。顺序路径是正确的：5 次 201 后 remaining=0，第 6 次起 409。
- 复现步骤：`POST /reset {}` → 并发 20 次 `POST /coupons/SAVE10/claim` → 20 个 201；`GET /coupons/SAVE10` 返回 `remaining=4`（应为 0）；随后顺序领取还能成功 4 次。
- 复现脚本：`.prelude/work/repro/repro-coupon-oversell.mjs`
- 证据：`.prelude/work/evidence/coupon-oversell.log`、`coupon-rounds.log`
- 复验：复现 3/3（exit 1，20 次全部 201，remaining 分别 4/3/4）。审查结论 confirmed：排除了"读取滞后"（burst 后还能顺序成功 4 次才 409）与"语义误解"（顺序路径 5 次后归零），脚本以上限取自实测 remaining 而非写死常量。

### f-003 GET /products 分页漏掉最后一个商品：total=7 但只能翻出 6 个，p7 只能单查（high）

- 现象：分页列表永远比 `total` 少返回一条 —— 最后创建（id 最大）的那个商品在所有页里都不出现，但 `GET /products/{id}` 能正常读到。种子状态 `total=7` 却只能翻出 p1..p6，p7 `Whatsit`(stock 40) 只能单查；新建 1 个商品后 `total=8`、列表返回 7 条，新建的那个缺席；连续新建 6 个后 `total=13`、列表返回 12 条（p1..p12），p13 缺席。`size=1/2/3/4/5/6/7/100` 全部一致，5 轮重复稳定。
- 预期：`/openapi.json` 中 `GET /products` 的描述是 "A page of products. Every product appears on exactly one page."。遍历 `page=1..pages` 的并集必须覆盖 `total` 个商品、每个恰好出现一次。实测并集大小 = `total − 1`。
- 影响：依赖列表的客户端（商品列表页、导出、缓存刷新）会永久看不到最新创建的商品，直到再有新商品创建；结合 `POST /products` 返回 201，形成"创建成功但列表读不到"。p7 在列表里完全不存在也是同一原因。
- 复现步骤：`POST /reset {}` → 用 `size=3` 遍历 `page=1..pages` 收集 id → 并集 6 个而 `total=7` → `GET /products/p7` 返回 200 `{"id":"p7","name":"Whatsit","stock":40}` 证明商品真实存在。
- 复现脚本：`.prelude/work/repro/repro-list-drops-product.mjs`
- 证据：`.prelude/work/evidence/list-drops.log`、`list-order.log`
- 复验：复现 3/3（exit 1，三次输出一致：total=7 / unique=6 / 缺失 p7）。审查结论 confirmed：缺失 id 由 `total` 推导而非写死，且必须经 `GET /products/{id}` 200 才判缺陷，正常实现不会误报。

### f-004 库存缺少校验：接受负数、小数和字符串，可把商品写成永久不可售的负库存（medium）

- 现象：库存字段没有类型/范围校验。`POST /products {"name":"x","price":1,"stock":-5}` → 201 且返回 `stock=-5`；`{"stock":1.5}` → 201 且 `stock=1.5`；`{"stock":"3"}` → 201 且字符串被隐式转成数字 3。`POST /reset` 的库存覆盖同样不校验：`{"stock":{"p1":-3}}` → 200，随后 `GET /products/p1` 返回 `stock=-3` 并长期驻留（此后下单一律 409 insufficient stock）。小数库存会算出 `0.5` 这样的非法剩余量。
- 预期：`/openapi.json` 的 `Product.stock` 定义为 `{"type":"integer","minimum":0}`，`POST /orders` 也承诺 "stock never goes below zero"；写入库存的两个入口（新建商品、重置覆盖）都不应产生违反该 schema 的数据。对照：`POST /products {}` 会正确返回 400 `name required`，说明校验框架存在，只是 stock 没接进去。
- 复现步骤：`POST /reset {}` → `POST /products {"stock":-5}`（201，stock=-5）→ `POST /products {"stock":1.5}`（201，stock=1.5）→ `POST /products {"stock":"3"}`（201，stock=3）→ `POST /reset {"stock":{"p1":-3}}` 后 `GET /products/p1` 得 stock=-3。
- 复现脚本：`.prelude/work/repro/repro-invalid-stock.mjs`
- 证据：`.prelude/work/evidence/invalid-stock.log`
- 复验：复现 3/3（exit 1，输出逐行一致）。审查结论 confirmed：负数与小数两条核心违规成立；审查指出字符串 `"3"` 被服务端转成数字 3，脚本本身未将其计为违规（描述略超脚本主张范围，不影响结论）。

### f-005 商品名含 emoji 时 POST /products 返回 500 并泄露内部错误细节（medium）

- 现象：`POST /products` 的商品名含 emoji 时返回 500，并把内部实现细节写进响应体：`{"error":"internal error","detail":"slugify: unexpected surrogate pair"}`。触发例：`"☕"`、`"🎉"`、`"Emoji 😀 ok"`、`"中文🎉名字"`、`"👨‍👩‍👧 family"` 全部 500。对照：`Café`、`中文`、`日本語`、`مرحبا`、`Ωμέγα` 等非 emoji 的 UTF-8 名称都能正常 201。
- 预期：`/openapi.json` 中 `NewProduct.name` 的描述是 "Any UTF-8 text"，emoji 是合法 UTF-8；`POST /products` 只声明 201/400，无 500。合法输入得到 5xx 违反契约（盲区清单「合法输入不应得到 5xx」）。错误体泄露内部函数名（slugify）与内部异常文案，属信息泄露。
- 影响：商品名/营销文案带 emoji 是电商常态，直接创建失败；客户端无法区分输入问题与服务端故障，重试也不会成功；内部细节可被用于探测实现。
- 复现步骤：`POST /reset {}` → `POST /products {"name":"☕","price":1,"stock":1}` → 500 + `detail:"slugify: unexpected surrogate pair"`；对照 `{"name":"Café 中文 Ünïcode"}` → 201。
- 复现脚本：`.prelude/work/repro/repro-emoji-name-500.mjs`
- 证据：`.prelude/work/evidence/emoji.log`、`chars.log`
- 复验：复现 3/3（exit 1）。审查结论 confirmed，并纠正一处措辞：描述里"任何需要 UTF-16 代理对表示的字符"过宽 —— `𝔘`/`𝔘𝔫`（同样需要代理对）返回 201，实际触发面是 emoji 而非所有代理对字符。

## 建议

### f-006 错误码与分页参数语义可更明确（low）

- 在哪里：`POST /orders` / `POST /coupons/{code}/claim` 的 409 响应；`GET /products` 的 `page`/`size` 参数；`GET /orders`。
- 什么问题：(1) 409 响应体只有一个自由文本 `error` 字段（`insufficient stock` / `quota exhausted`），没有可机器判断的 `code`，也没有 `Retry-After`，客户端无法区分"售罄不该重试"与"冲突可退避重试"。(2) `GET /products` 的非法 `page`/`size` 被静默归一化而不是报错：`page=0/-1/abc` → 200 且 `page=1`，`size=0/abc` → `size=3`，`size=101/999999` → `size=100`，`size=-3` → `size=1`，而 openapi 已声明 `page minimum 1`、`size 1..100`。(3) `GET /orders` 一次性返回全部订单，无任何分页参数，随订单量增长会变成无界响应。
- 为什么影响用户：抢购场景下 409 会大量出现，客户端拿不到"该退避还是该提示售罄"的信号；分页参数写错时服务端悄悄改值，调用方很难发现自己传错了（只能从回显的 `size` 反推）；订单列表无分页在长期运行或压测后可能拖垮客户端与网关。
- 建议怎么改：409 响应体加稳定可枚举的 `code`（如 `OUT_OF_STOCK` / `QUOTA_EXHAUSTED`）并说明是否可重试；`page`/`size` 越界直接返回 400 并说明合法范围（与 openapi 的 `minimum`/`maximum` 对齐）；`GET /orders` 复用 `/products` 的分页结构（`page/size/total/pages`）。
- 复验：confirmed（审查按描述逐条复现，三条事实均成立；纠正了"纯文本"措辞 —— 实际是只带 message 的 JSON；并指出"前端分页器页数错误"这一举例偏弱，因为响应回显了实际生效的 size）。

## 未复现项

以下现象在测试过程中出现过，但复验或进一步排查后**未能成立**，不作为缺陷：

- **"新建商品后立刻 GET /products/{id} 偶发 404"**：早期探测中出现过 2/50 次，但随后专门连测 300 轮、6 轮 ×50 次、10 轮 ×20 个商品并发 GET 均为 0 次失败，另做了 45 秒周期性轮询（200ms 一次）也未观察到。判定为早期多个探测脚本并发运行、互相调用 `/reset` 干扰所致，不是服务缺陷。
- **"`GET /orders` 里混入上一轮测试的订单 / 取消重置后的订单"**：经确认是我同时运行了两个探测脚本、彼此调用 `/reset` 与下单造成的串扰。单脚本顺序验证时 `POST /reset` 会正确清空订单列表并把订单号重置为 `o1`。
- **"同一订单并发取消会重复回补库存"**：10 次并发取消 → 1 次 200 + 9 次 409，库存只回补一次；顺序下单 20 笔后并发取消全部 20 笔，库存精确回到初始值。该路径实现正确。
- **"优惠券额度会周期性回补"**：早期一轮探测中第 8 次领取意外返回 201 并 remaining=4。随后 6 轮顺序探测、4 轮并发后探测、45 秒周期性轮询均未再出现，判定为早期探测串扰，不成立。

## 测了什么

- 接口面（全部 8 个路径）：`GET /health`、`POST /reset`、`GET|POST /products`、`GET /products/{id}`、`GET /coupons/{code}`、`POST /coupons/{code}/claim`、`GET|POST /orders`、`POST /orders/{id}/cancel`。
- 并发与重复提交（盲区清单）：并发下单（N=2/4/5/10/20/30/50/60/200，qty=1/2/3/5/7）、并发领券（N=2/20）、并发取消同一订单（10 次）、并发取消多笔订单、并发创建商品（8 个同时）、并发创建+列表读取。
- 不变量检查：库存守恒（剩余 + 已售 = 初始）、配额守恒（成功次数 = 初始 remaining − 当前 remaining）、订单 id 唯一性与可见性、取消后库存回补精确性、`/reset` 后的状态一致性（库存/订单/订单号）。
- 边界与异常路径：`qty` 为 0/-1/-100/1.5/"1"/true/缺字段/1e9；`productId` 为空串/null/未知 id；`POST /products` 缺 name、空 name、数字 name、超长 name（5000 字符）、控制字符、`stock` 为负/小数/字符串/1e12；`page`/`size` 为 0/-1/-999/abc/101/1000/999999/-3；错误方法（GET/PUT/DELETE 打在写接口上）；坏 JSON；缺 `content-type`。
- 输入编码与国际化：中文、日文、阿拉伯文、RTL、组合字符（`x\u0301y`）、零宽字符、BOM、全角、数学字母（`𝔘𝔫𝔦𝔠𝔬𝔡𝔢`）、emoji 与 ZWJ 家庭 emoji。
- 分页完整性：`size=1/2/3/4/5/6/7/10/100` 全页遍历，检查并集大小、重复、缺失、`total`/`pages` 一致性。
- 状态流转：placed → cancelled、重复取消、取消未知订单、`/reset` 后取消旧订单、`/reset` 后订单号是否重排。
- 性能退化（部分）：并发 200 单的响应状态分布；无响应时间随数据增长的定量测量。
- 工具：Node v22 内置 `fetch`（无第三方依赖），手写 `.mjs` 探测与复现脚本；`curl` 做单点确认。脚本与草稿在 `.prelude/work/`，证据在 `.prelude/work/evidence/`。

## 没测什么

- **鉴权与越权**：该服务无鉴权机制（无 token/cookie/账号，openapi 也没有 securitySchemes），越权类探测不适用。
- **破坏性操作**：只使用 `/reset` 这一官方重置手段，没有尝试注入、扫描、模糊攻击、删除数据或篡改进程；安全测试不在本次授权范围内。
- **负载上限**：用户选定"中等（20–50 并发）"。主结论都在此区间得出；仅有一次把 p3（库存 100）开到 200 并发做规模观察，未做更大压力或长时间浸泡测试，未测吞吐、延迟分位数、连接耗尽、内存增长。
- **并发缺陷的触发概率与边界**：只确认"会发生"，没有量化不同并发数下的失败率（例如 N=2 几乎 100% 超卖、N=200 的分布），也没有测试带网络延迟/慢客户端/分批到达（非同时）的时序变体。
- **外部依赖与持久化**：状态全在内存，没有数据库/消息队列可观察；未测试进程重启后的数据行为（重启不属于授权操作，且会丢失重置能力）。
- **前端/UI**：无 UI，仅接口层。
- **订单与商品的其他业务语义**：`price` 无 `minimum`、未校验负价（openapi 也未声明 `minimum`，故未记为缺陷）；未测订单金额计算、支付、发货、超时取消等（服务未提供）。
- **并发创建商品时的 id 冲突与列表丢条**：只观察到"最后一个商品不在列表"这一稳定现象，未深挖并发创建场景下的 id 分配细节（实测并发创建 8 个商品 id 唯一）。

## 隔离级别

仅工具层策略（Prelude 的闸门），不是安全边界。测试只访问授权范围内的 `localhost:4100`（functional + load），未访问任何范围外主机；未在被测主机上安装任何依赖（全部使用 Node 内置 `fetch`）；未对被测服务做安装、重启或数据删除操作，状态重置只通过其官方 `POST /reset` 接口完成。被拒绝或未授权的操作没有换方式重试。
