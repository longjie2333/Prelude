# canary（http://localhost:4100）下单接口并发超卖测试报告

日期：2026-10-27　目标：测下单接口在并发下会不会超卖

## 结论

canary 是"库存/订单"演示服务（OpenAPI 3.0.3，无鉴权）。**下单接口在并发下会严重超卖**：2 件库存接受 10 笔订单，库存只扣 1 件；根因是"检查库存 → 扣减库存"的读-改-写没有原子化。同一类非原子写入还出现在优惠券领取（配额 5 发 10 份）和取消/下单交错（5 件商品凭空多出 4 件），三者需要分别修复。另有 3 个非并发缺陷：分页永远漏掉最后一个商品、`POST /products` 接受非法输入并持久化、名称含 emoji 时 500 并泄露内部实现细节。

共 6 个已复验缺陷（1 critical / 2 high / 3 medium），1 条建议被复验拒绝。

假设（接收阶段已确认的部分之外，我自己决定的）：
- 用户确认：测试环境、可写可 `/reset`、并发 ≤10 几轮、同时测同根因的其它"检查+扣减"接口并按接口分别记缺陷、不授权安全类探测。故本次未做注入/越权/扫描类尝试。
- 预期值全部取自 `/openapi.json` 的明文断言（"stock never goes below zero"、"remaining never goes below zero"、"Every product appears on exactly one page"、`Product.stock` 的 `minimum: 0`、`NewProduct.name` 的 "Any UTF-8 text"）与由此推出的守恒不变量，未采用实际输出。
- 用 `/reset` 的 `{"stock":{...}}` 覆盖来构造小库存，使超卖在少量并发下就暴露；每轮探测前都复位，改状态的探测一律串行执行。

## 已复验缺陷

### f-001 并发下单超卖：POST /orders 非原子"检查+扣减"，2 件库存接受 10 笔订单（critical）

- 现象：p1 库存置为 2，同时发 10 个 `POST /orders {"productId":"p1","qty":1}`，**10 个全部 201**（各生成一个订单 o1..o10），库存只从 2 变成 1。3/3 轮一致。2 并发即可复现（2 笔全成功、库存只减 1）；qty=3 打 stock=3 时 6 笔全成功、承诺 18 件。
- 预期：`POST /orders` 文档写 "Stock is decremented by qty; stock never goes below zero"，409 = "Insufficient stock"。故最多 floor(2/1)=2 笔可成功、其余 409，且 `初始 - 最终 == 成功数 × qty`。实际承诺 10 件、只扣 1 件。
- 复现步骤：`POST /reset {"stock":{"p1":2}}` → `GET /products/p1` 确认 stock=2 → Promise.all 发 10 个 `POST /orders qty=1` → 统计状态码（10×201、0×409）→ `GET /products/p1`（stock=1）。复现脚本 `.prelude/work/orders-oversell.mjs`。
- 证据：`.prelude/work/evidence/orders-oversell-run1.log`、`.prelude/work/openapi.json`。
- 复验：复现 3/3；审查结论 confirmed——断言直接来自契约原文，正确实现（串行/加锁）会 2×201 + 8×409 而通过；输出中 10×201 与库存几乎不动直接违反"每单扣 qty"。附带指出描述里"最终 stock=1"是可变的（重跑时为 0），不影响结论。

### f-002 并发领券超发：POST /coupons/{code}/claim 配额 5 却成功发放 10 份（high）

- 现象：`POST /reset` 后 SAVE10 remaining=5，同时发 10 个 `POST /coupons/SAVE10/claim`，**10 个全部 201**，remaining 只从 5 降到 4。3/3 轮一致。
- 预期：claim 文档写 "Claim one use of a coupon. remaining never goes below zero"，409 = "Quota exhausted"。成功次数不得超过初始 remaining，且 `初始 - 最终 == 成功次数`。实际超发 5 份、计数只减 1。
- 复现步骤：`POST /reset {}` → `GET /coupons/SAVE10`（remaining=5）→ Promise.all 发 10 个 claim → 状态码 10×201/0×409 → `GET /coupons/SAVE10`（remaining=4）。复现脚本 `.prelude/work/coupon-claim-race.mjs`。
- 证据：`.prelude/work/evidence/coupon-claim-run1.log`、`.prelude/work/openapi.json`。
- 复验：复现 3/3；审查结论 confirmed——契约来源明确，断言正确实现下必然通过，3 轮结果与描述一致。顺序调用时守卫正常（remaining=0 后连发 10 个并发 claim 全部 409），说明这是与 f-001 独立的另一处非原子实现，需分别修复。

### f-006 取消与下单交错丢失更新：库存守恒被破坏，5 件商品凭空多出 4 件（high）

- 现象：p1 库存 5，顺序下 5 笔 qty=1 卖光（stock=0，placedQty=5）。然后同时发 5 个 `POST /orders/{id}/cancel`（各 +1）和 5 个新 `POST /orders qty=1`（各 -1），全部成功（5×200 + 5×201）。终态 stock=4、placedQty=5，**`stock + placedQty = 9 ≠ 5`**，凭空多出 4 件。5/5 轮复现；初始库存 10 的变体也出现过 +1 偏差。
- 预期：`POST /orders` 声明 "Stock is decremented by qty"、`POST /orders/{id}/cancel` 声明 "Cancel an order and return its quantity to stock"。对单一商品、无其它流量，任何静止时刻必须满足 `stock + 未取消订单 qty 之和 == 初始库存`；任何交错顺序下正确实现都应满足（本场景应为 stock=0、placedQty=5）。实际 cancel 的 +1 覆盖了 order 的 -1。
- 复现步骤：`POST /reset {"stock":{"p1":5}}` → 顺序下 5 笔 qty=1 至 stock=0 → Promise.all（5 个 cancel + 5 个新下单）→ `GET /products/p1` 与 `GET /orders` → 断言 `stock + placedQty == 5`。复现脚本 `.prelude/work/cancel-order-race.mjs`。
- 证据：`.prelude/work/evidence/cancel-order-race-run3.log`、`.prelude/work/openapi.json`。
- 复验：复现 3/3；审查结论 confirmed——守恒式是两条契约的必然推论，脚本只断言守恒与 stock≥0，setup 失败即 exit 0 不会假报，终态数值与描述一致。**这是与 f-001 不同的代码路径**：只修"下单前的 409 检查"不会关闭它，需要库存加减都原子化/加锁。
- 对照（通过）：单独并发 cancel 不同订单（5 个 cancel 同时 → stock 正确回到 5）、同一订单 10 并发 cancel（1×200 + 9×409，stock 正确回到 10）、顺序 cancel 与重复 cancel（409 "already cancelled"）均正确。

### f-003 GET /products 分页漏掉最后一个商品：total=7 但任何页都取不到 p7（medium）

- 现象：reset 后目录有 7 个商品（p1..p7 直接 GET 全 200）。用 size ∈ {1..7} 遍历 `pages` 页，并集恒为 6 个（缺 p7）；`pages` 仍按 7 计算，最后一页恒为空。size=7 时 page1 只有 6 条而 `total=7`、`pages=1`，p7 无处可取。新建商品后同样漏最后一个（建 p8、p9 后 size=100 返回 total=9 但只有 8 条）。
- 预期：`GET /products` 的 200 描述为 "A page of products. **Every product appears on exactly one page**"，`total` 是总数、`pages = ceil(total/size)`。遍历全部页应恰好得到 total 个不同商品。实际总有 1 个商品不出现在任何页。
- 复现步骤：`POST /reset {}` → 对 p1..p30 逐个 `GET /products/{id}` 建立真值集合 → 对 size 1..7 取 page=1 得 `pages`，遍历全部页收集 id → 断言并集去重数 == total 且包含真值集合。复现脚本 `.prelude/work/products-pagination.mjs`。
- 证据：`.prelude/work/evidence/products-pagination-run1.log`、`.prelude/work/openapi.json`。
- 复验：复现 3/3；审查结论 confirmed——真值集合不依赖分页接口，断言有文档依据，size=7/total=7/pages=1/6 条自相矛盾。

### f-004 POST /products 接受非法输入：stock=-5、price=null、stock=null 均 201 并持久化，违反 Product schema（medium）

- 现象：`{"name":"...","price":1,"stock":-5}` → 201 且 `stock:-5`；`{"price":"abc"}` → 201 且 `price:null`；`{"stock":"x"}` → 201 且 `stock:null`。三种对象随后都能 `GET /products/{id}` 读回。`stock:-5` 的商品之后下单永远 409，无法通过正常路径修正。
- 预期：`POST /products` 声明 400 = "Invalid input"，201 返回 `Product`；`Product` 的 `price` 必须为 `number`（required）、`stock` 必须为 `integer` 且 `minimum: 0`。非法输入应 400，绝不能 201 出违反自身响应 schema 的对象。
- 复现步骤：`POST /reset {}` → 依次 POST 三个非法 body → 检查状态码与返回体是否满足 `Product` schema → `GET /products/{id}` 确认已持久化。复现脚本 `.prelude/work/products-create-schema.mjs`。
- 证据：`.prelude/work/evidence/products-create-schema-run1.log`、`.prelude/work/openapi.json`。
- 复验：复现 3/3；审查结论 confirmed——脚本用"201 则必须符合 Product，否则必须 400"的双分支，任何正确实现都会通过；`NewProduct.stock` 虽未设 minimum，但此时服务端无论如何无法给出合规的 201 Product，问题真实。

### f-005 POST /products 遇 emoji（代理对）返回 500 并泄露内部实现细节（medium）

- 现象：name 含 emoji 时 `POST /products` 返回 500 且 body 为 `{"error":"internal error","detail":"slugify: unexpected surrogate pair"}`——把内部函数名与内部错误信息直接给到客户端。`"🔥"`、`"emoji 🔥 in the middle"`、`"😀😀"` 均如此。对照：`Größe Ünïcode`、`日本語の商品`、`𝔘𝔫𝔦` 均 201，说明不是整体 UTF-8 处理问题，而是 UTF-16 代理对处理缺失。
- 预期：`NewProduct.name` 的 schema 描述为 "**Any UTF-8 text**"，`POST /products` 只声明 201/400，没有 5xx。emoji 是合法 UTF-8，合法输入不得 5xx；即使不支持也应 400，且错误体不应泄露内部实现。
- 复现步骤：`POST /reset {}` → 依次 POST name 为 BMP 非 ASCII、CJK、单个 emoji、含 emoji 的句子、多个 emoji 的 body → 记录状态码与 body。复现脚本 `.prelude/work/products-emoji-500.mjs`。
- 证据：`.prelude/work/evidence/products-emoji-500-run1.log`、`.prelude/work/openapi.json`。
- 复验：复现 3/3；审查结论 confirmed——预期有文档依据，脚本允许 400 作为可接受替代（断言不过强），BMP 对照排除了环境/编码问题。

## 建议

无。唯一一条建议 f-007（`GET /products` 的 `page`/`size` 越界值被静默钳制/回落、未返回 400）在复验中被拒，见"未复现项"。

## 未复现项

- **f-007（suggestion，rejected）**：`GET /products` 对 `size=0`/`size=101`/`size=1.5`/`page=0`/`page=-1`/`page=abc` 静默钳制或回落默认值。审查认为：(1) 该条没有复现脚本与运行日志，观测值未被捕获；(2) `GET /products` 的文档只声明 200，未声明 400，`minimum`/`maximum`/`integer` 是取值约束而非"越界必须报错"的错误契约，"应返回 400"属报告者偏好；(3) 描述内部矛盾（既说客户端无法区分，又承认响应回显了生效值）。作为 suggestion 不成立，故不计入建议。
- **单独并发 cancel 不同订单 / 同一订单 10 并发 cancel**：5 个不同订单并发 cancel → stock 正确回到 5（3/3）；同一订单 10 并发 cancel → 1×200 + 9×409，stock 正确回到 10（3/3）。未发现缺陷，属正常实现。
- **cancel+下单交错的温和变体（初始库存 4，setup qty=2 + 新单 qty=1，8 轮）**：8/8 轮守恒成立（stock 3 + placed 1 = 4）。同一根因在更宽的并发窗口下才稳定暴露，最终以 f-006 的 5+5 场景复现，故不单列。
- **多商品并发（p2 与 p5 同时各 5 单，p5 只有 3 件）**：10 笔全 201，p2 5→3、p5 3→2，未触碰的 p1/p3 不变——超卖范围限于被下单的商品，但 p5 明显超卖，属 f-001 同根因，不单列。

## 测了什么

- 接口面：`GET /health`、`POST /reset`（含 stock 覆盖）、`GET /products`（分页）、`GET /products/{id}`、`POST /products`、`GET /orders`、`POST /orders`、`POST /orders/{id}/cancel`、`GET /coupons/{code}`、`POST /coupons/{code}/claim`；全部来自 `/openapi.json`。
- 并发不变量（核心）：下单超卖（f-001）、领券超发（f-002）、取消与下单交错守恒（f-006）、单独并发 cancel、同订单重复并发 cancel、多商品并发、并发 qty=3 打 stock=3（最终 stock≥0 未破）。
- 盲区清单覆盖：
  - 并发与重复提交 → f-001 / f-002 / f-006，以及重复 cancel 的 409 正确性。
  - 边界与异常路径 → qty=0/-1/1.5/"2"/1e30、缺字段、空 body、坏 JSON（`invalid JSON` 400）、未知商品 404、未知券 404、未知订单 404；`POST /products` 非法 price/stock → f-004。
  - 输入编码与国际化 → 非 ASCII/CJK/emoji/astral，用 Node fetch 直接发 UTF-8（未用 shell 传中文）→ f-005。
  - 错误提示与恢复 → 合法输入得 5xx 记为 f-005；错误体泄露内部细节一并记入 f-005。
  - 状态流转 → cancel 幂等性（重复 cancel 409 "already cancelled"）、已取消订单不再占用库存。
  - 性能退化 / 大数据量分页 → 分页窗口正确性 f-003（未做耗时压测，见"没测什么"）。
  - 权限越权 → 不适用：服务无鉴权、无角色（用户未授权安全测试）。
  - 可访问性 → 不适用：无 UI。
  - 配置与环境差异 → 不适用：单一本地环境，用户未提供其它环境。
- 方法：以 `/openapi.json` 的明文断言为预期值来源；顺序调用先确认守卫存在（再并发证明其在竞态下失效）；每个缺陷都用 Node 内置 fetch 写自包含复现脚本，可重复（每次先 `/reset`），失败前置条件时以 0 退出；知识库工具 `rest-api/scripts/race-probe/` 用于第一轮超卖/超发探测。

## 没测什么

- **安全类测试**：越权、注入、扫描、畸形攻击载荷——用户明确不授权，未做任何尝试。
- **破坏性操作**：除 `/reset` 与常规写接口外，未删除数据、未修改服务端文件、未重启进程。
- **生产环境**：只有 localhost:4100 一个环境在授权范围内；未接触其它主机。
- **强度/容量**：并发上限按用户要求控制在 10 左右、每项 2~5 轮，未做规模曲线、长时间 soak、内存/CPU 观测；因此"更大并发下的失败率/分布"未量化（按方法论不量化已确认缺陷）。
- **非本次方向的接口面**：`/coupons` 列表（不存在，文档也无此路径）、`/reset` 的错误输入语义（如负数覆盖能成功）只作观察未深挖；`POST /products` 的超长 name（300 字符）只确认 201 未验证截断规则。
- **未覆盖的盲区**：多资源事务（下单 + 优惠券 + 台账的跨资源一致性）、异步/回调、缓存一致性、时区与本地化格式、客户端可访问性——系统里没有对应机制或没有 UI。
- **数据持久化/重启后状态**：未验证进程重启后订单/库存/券的落盘行为（不在授权操作内）。

## 隔离级别

Windows 上运行，隔离**仅工具层策略（Prelude 的闸门），不是安全边界**。所有探测仅通过 HTTP 访问授权范围内的 `localhost:4100`（functional、load），未安装任何依赖、未在被测主机上部署或修改程序；`/reset` 用于每轮复位，测试结束后已复位到种子状态（7 个商品、SAVE10 remaining=5、订单为空）。脚本与证据均在 `.prelude/work/` 下。

## 复盘

本次知识库写入：

- `rest-api` / **les-85a9**（"计数器类写接口必须做并发不变量测试，顺序调用会掩盖超卖"）→ `kb_lesson_revise` kind `evidence`（finding f-006）：本次 f-001 / f-002 / f-006 再次证实，且 f-006 正好落在它提醒的"交错探测"上（只守 409 检查的修复关不掉丢失更新）。来自第二个项目的证据使其升为已确认。
- `rest-api` / **les-0108**（"把 OpenAPI 的 schema 和描述文本当作可执行断言"）→ `kb_lesson_revise` kind `evidence`（finding f-005）：f-003（分页"every product appears on exactly one page"）、f-004（Product schema 的 minimum/type）、f-005（"Any UTF-8 text" + emoji 代理对 500）都是把文档明文断言变成可执行断言的直接产出。
- **未新增经验**：原本打算新增一条"库存守恒式要写成 `stock + 未取消订单量 == 初始量`，并在卖光后 cancel+下单 交错场景断言"的经验，但查 `les-85a9` 的 guidance 已明确写了"还要做交错探测：把退还操作（cancel/refund，+qty）与消耗操作（-qty）并发发出，检查 最终值+仍持有量 == 初始值；只守 409 检查的修复不会关闭这类丢失更新"——完全覆盖，故不重复新增，改为对该条追加证据（同上）。
- 新增工具 `kb_tool_add`（rest-api）：**`interleave-probe`**（源 `.prelude/work/interleave-probe/`，含 README 与 selfcheck）。现有 `race-probe` 只发 N 个相同的消耗操作，其 README 自己写明 "Interleaved operations (e.g. cancel + order racing each other) need a dedicated probe — this tool cannot model them"，而 f-006 正属于这一类。新工具把守恒式 `counter + heldQty == initial` 做成通用探测：先顺序占满，再同时发 burst 个 release 与 burst 个 consume，退出码 1 = 守恒被破坏。`selfcheck.mjs` 用两个本地 fixture（一个加锁、一个非原子 RMW）验证了正确实现退出 0、缺陷实现退出 1、目标不可达退出 0，并在真实 canary 上复现 f-006。
- 工具复用：`rest-api/scripts/race-probe/` 用于第一轮下单超卖与领券超发探测，两次都直接命中，省去了自写探测的成本。自写的 5 个缺陷复现脚本是本次系统专属的，不进知识库。
- 系统笔记：`.prelude/notes/canary-api.md` 已更新（接口行为、可判定的不变量、种子数据、`/reset` 的 stock 覆盖能力、Git Bash 路径改写坑）。
