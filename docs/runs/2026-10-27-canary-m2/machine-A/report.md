# canary 下单接口并发测试报告

## 结论

测了 canary 库存/订单服务（http://localhost:4100，OpenAPI 3.0.3）的下单接口及其相关写路径。**下单接口在并发下确实会超卖**：库存 2 时 10 个并发下单全部返回 201，服务只扣了 1 件库存（f-001，critical）；同一根因还导致并发领券超配额（f-002）、取消与下单交错时凭空造出库存（f-006）。另外发现列表丢最后一条产品（f-003）、创建产品接受非法值并返回违反自身 schema 的对象（f-004）、emoji 名称导致 500 并泄露内部实现细节（f-005）。共 6 个已复验缺陷，3 个 high 及以上，整体判断：核心库存一致性不可信，`x-consistency: sync` 响应头与实测不符。

主要假设（接收阶段没问到的部分，自行决定）：
- 只测功能与并发，不做破坏性操作（不删数据、不注入攻击载荷）；并发上限按用户选择的 50。
- 允许随意调用 `POST /reset` 重置种子数据（用户确认）。
- 业务规则只取 `/openapi.json` 的明文描述（"stock never goes below zero"、"remaining never goes below zero"、"Every product appears on exactly one page"）与响应 schema，不臆造价格/优惠规则。
- 优惠券只测了种子券 `SAVE10`（quota 5），其余券码 404，未穷举。
- "超卖"判定用不变量：成功下单的 qty 之和 ≤ 初始库存，且 `初始库存 - 最终库存 == 成功 qty 之和`。

## 已复验缺陷

### f-001 并发 POST /orders 超卖：库存校验与扣减不是原子的（critical）

- 现象：库存置为 2，同时发出 10 个 `{"productId":"p1","qty":1}`，**10 个全部返回 201**，最终库存为 1（只扣了 1 件），10 件库存被承诺出去。qty=3、库存 5、并发 8 时接受 24 件；库存 1 时 2 并发即超卖。顺序请求是正确的：库存耗尽后返回 409 `insufficient stock`。
- 预期：成功下单的数量不得超过库存，且库存必须按 qty 精确扣减。依据：`/openapi.json` POST /orders 写明 "Place an order. Stock is decremented by qty; stock never goes below zero."，并声明 409 "Insufficient stock"；单线程路径确实返回 409，说明该约束是设计意图，只是并发下失效。
- 复现步骤：`POST /reset {"stock":{"p1":2}}` → 并发 10 个 `POST /orders qty=1` → `GET /products/p1` 与 `GET /orders`。复现脚本 `.prelude/work/oversell-probe.mjs`（内部跑 3 轮，重置后用 Promise.all 并发，断言 `acceptedQty <= initialStock` 且 `stockDelta == acceptedQty`）。
- 证据：`.prelude/work/evidence-oversell.txt`、`.prelude/work/openapi.json`。
- 复验：复现 3/3；审查结论 confirmed — 不变量有文档依据，正确实现（201:2/409:8/stockDelta:2）会以 0 退出，断言不过弱；reset 失败与异常均 exit 0，不会误判。

### f-006 并发 cancel 与 order 交错时凭空造出库存（high）

- 现象：p1 库存 20，先顺序下 5 单 qty=2（库存正确降到 10），再**并发**发出 5 个取消（各退 2）和 5 个新订单（各扣 2）：10 个请求全部成功（200×5、201×5），最终库存 18，仍处于 placed 的订单 qty 合计 10。核算 18+10=28 件，而系统中只存在过 20 件，凭空多出 8 件。3 轮全部复现。
- 预期：`初始库存 == 最终库存 + 所有仍为 placed 订单的 qty`。依据：POST /orders "Stock is decremented by qty"、POST /orders/{id}/cancel "Cancel an order and return its quantity to stock"，订单要么持有库存要么已退回，总量必须守恒。单独并发取消是安全的（6 个不同订单并发取消，库存 8 → 20 精确），说明丢失发生在取消的 `+2` 与下单的 `-2` 交错写入时。
- 复现步骤：reset `{"stock":{"p1":20}}` → 顺序下 5 单 qty=2 → 并发发出这 5 单的 cancel 与 5 个新 order → 读库存与订单核对守恒。脚本 `.prelude/work/conserve-probe.mjs`。
- 证据：`.prelude/work/evidence-conserve.txt`、`.prelude/work/openapi.json`。
- 复验：复现 3/3；审查结论 confirmed — 不变量来自契约、正确实现可通过、观测数字自洽且指向库存计数器的丢失更新。

### f-002 并发领券超出配额（high）

- 现象：`SAVE10` 配额 5、剩余 5，并发 15 次 `POST /coupons/SAVE10/claim` **全部 201**，剩余只从 5 降到 4（15 次领取只扣 1 次）。顺序调用是正确的：5 次成功后第 6 次返回 409 `quota exhausted`。
- 预期：成功领取数 ≤ 初始 remaining，remaining 永不低于 0，且每次成功扣 1。依据：`/openapi.json` POST /coupons/{code}/claim "Claim one use of a coupon. remaining never goes below zero."，并声明 409 "Quota exhausted"。
- 复现步骤：`POST /reset` → 并发 15 次 claim → `GET /coupons/SAVE10`。脚本 `.prelude/work/coupon-probe.mjs`（并发数取 `remaining + 10`）。
- 证据：`.prelude/work/evidence-coupon.txt`、`.prelude/work/openapi.json`。
- 复验：复现 3/3；审查结论 confirmed — 顺序路径有 409 说明约束存在；描述与重跑输出的剩余值（4 vs 3）因竞态略有差异，不影响"15 次成功对配额 5"的结论。

### f-003 GET /products 丢失最后一条产品（medium）

- 现象：`GET /products?size=100` 返回 `total=10` 但只有 9 条；最后一条产品（加 3 个产品后是 p10）**在任何页都取不到**，而 `GET /products/p10` 返回 200，说明它确实存在、可下单。size=3/7/100 三种分页大小都稳定丢失 1 条，重置后仅种子数据时同样丢 p7。
- 预期：所有页的并集应等于全部 `total` 个产品。依据：`/openapi.json` GET /products 200 描述 "A page of products. Every product appears on exactly one page."；这里 1 个产品出现在 0 页，且 `total` 与返回条目数自相矛盾。
- 复现步骤：`POST /reset` → 创建 3 个产品 → 用 size=3/7/100 遍历全部页，比对唯一 id 数与 `total`，再对不在列表中的 id 调 `GET /products/{id}` 证明其存在。脚本 `.prelude/work/pagination-probe.mjs`。
- 证据：`.prelude/work/evidence-pagination.txt`、`.prelude/work/openapi.json`。
- 复验：复现 3/3；审查结论 confirmed — `pages` 与 `total` 自洽（ceil(10/3)=4），排除分页窗口伪影；缺失产品经单条接口证明存在。

### f-004 POST /products 接受非法值并返回违反自身 schema 的 Product（medium）

- 现象：`{"name":"neg-stock","stock":-5}` → 201 `{"id":"p8","price":0,"stock":-5}`（负库存）；`{"name":"bad-price","price":"not-a-number"}` → 201 `{"id":"p9","price":null,"stock":0}`（价格变成 null）。该产品随后无法下单（对负库存产品下单返回 409）。
- 预期：非法输入应返回 400 "Invalid input"（该接口已声明 400，且空 name 确实返回 400），或钳制成符合 schema 的值。依据：`/openapi.json` Product schema `stock: integer, minimum 0`、`price: number`；NewProduct `price: number`。
- 复现步骤：`POST /reset` → 分别创建 stock=-5 与 price="not-a-number" 的产品 → 校验返回的 Product 是否符合文档 schema。脚本 `.prelude/work/product-validation-probe.mjs`。
- 证据：`.prelude/work/evidence-product-validation.txt`、`.prelude/work/openapi.json`。
- 复验：复现 3/3；审查结论 confirmed — 断言只在 201 且响应违反响应 schema 时触发，符合 schema 的实现会通过；字符串 price 同时违反 NewProduct 的类型。

### f-005 emoji（代理对）名称导致 500 并泄露内部实现细节（medium）

- 现象：`POST /products` 对任何含 emoji 的名称返回 500 `{"error":"internal error","detail":"slugify: unexpected surrogate pair"}`（"🎉"、"a🎉"、"Sprocket 🛒" 均如此），且不创建产品。BMP 非 ASCII 名称正常（"日本語テスト"、"café"、"Ω"、"ＡＢ" 均 201），说明问题特定于 UTF-16 代理对。
- 预期：接受（201）或用 400 "Invalid input" 拒绝；合法输入不得产生 5xx。依据：`/openapi.json` NewProduct.name 描述为 "Any UTF-8 text"，POST /products 只声明 201 与 400。次要问题：500 响应体暴露了内部函数名与失败原因（"slugify: unexpected surrogate pair"），便于攻击者推断实现。
- 复现步骤：`POST /reset` → 依次创建 4 个含 emoji 的名称 → 检查是否 5xx。脚本 `.prelude/work/emoji-name-probe.mjs`。
- 证据：`.prelude/work/evidence-emoji.txt`、`.prelude/work/openapi.json`。
- 复验：复现 3/3；审查结论 confirmed — 预期来自文档 "Any UTF-8 text"，BMP 名称成功排除了通用校验问题。

## 建议

无（本次没有记录 suggestion 类型的发现；分页参数 `page=0/-1/abc`、`size=0` 被静默钳制成默认值而非返回 400，虽与 OpenAPI 的 minimum/maximum 不符，但行为一致、无数据风险，只记录在"测了什么"里，未作为缺陷上报）。

## 未复现项

无（6 条发现全部复验为 confirmed；另有两个探测未观察到问题，未作为发现记录：并发取消同一订单只成功一次、库存不被重复退回；并发取消不同订单的增量全部正确落库）。

## 测了什么

- **接口面**：`/health`、`/reset`（含 stock 覆盖）、`/products`（GET 分页 / POST 创建）、`/products/{id}`、`/coupons/{code}`、`/coupons/{code}/claim`、`/orders`（GET / POST）、`/orders/{id}/cancel`。全部端点都实际调用过。
- **并发与重复提交（盲区）**：并发下单（2/3/5/10/50 并发，qty 1/3/5，库存 1/2/3/5/10/20）、并发领券（15 并发对配额 5）、并发取消同一订单（6 并发）、并发取消多订单、取消与下单交错（5+5）。所有改状态的探测串行执行，一轮只跑一个。
- **边界与异常路径（盲区）**：qty=0/-1/1.5/"2"/缺失/超库存/未知产品/空 body/非法 JSON/多余字段；product name 缺失/空/非字符串/5000 字符/控制字符/日文/拉丁扩展/希腊/全角/emoji；price 负数/非数字；stock 负数/2^31-1 及对应最大 qty；分页 page=0/-1/abc、size=0/-5/101。
- **状态流转（盲区）**：下单 → 取消 → 重复取消（409 正确）；取消后库存精确退回；订单 status 枚举 placed/cancelled 与文档一致。
- **不变量与守恒**：每次写操作前后各读一次，检查 `initial == final + placed qty`、`successes*qty <= initial`、`remaining == initial - successes`。
- **分页完整性（盲区）**：size 1/2/3/5/6/7/8/10/20/50/99/100 遍历全部页，比对并集与 total。
- **性能退化 / 强度**：50 并发下单后 `/health` 仍 `{"ok":true}`，服务未崩溃、无 5xx（除 emoji 路径）。
- **工具**：Node 22 内置 `fetch`，单文件 `.mjs` 脚本 + `Promise.all`，curl 仅用于快速探查。无第三方依赖。

## 没测什么

- **鉴权与越权**：该服务没有鉴权（无 token/cookie），垂直/水平越权不适用；未做未授权访问测试，因为不存在授权概念。
- **安全测试**：未做扫描、注入、XSS 等（用户未授权安全测试）。emoji 500 的"内部信息泄露"是功能测试中顺带观察到的，未深入探测其他错误路径的信息泄露。
- **优惠券**：只测了种子券 `SAVE10`，其他券码均 404；券的过期、叠加、与订单金额的联动规则文档未定义，无法确定预期值，未测。
- **价格与金额**：订单不计算总价（Order 只有 productId/qty/status），未测金额取整、货币精度。
- **持久化与重启**：未重启服务，未验证数据在进程重启后是否保留；只有 `POST /reset` 这一种恢复手段。
- **真实浏览器 / UI**：无 UI，纯接口服务。
- **可访问性、国际化文案**：无 UI，不适用；只测了输入编码（见 f-005）。
- **更高并发**：用户批准的上限是 50，未测 100+ 或长时间压测（超卖在 2 并发即可复现，提高强度只影响幅度不影响结论）。

## 隔离级别

仅工具层策略（Prelude 的闸门），不是安全边界。被测服务运行在本机 localhost:4100，测试只访问该授权主机；探测脚本在 `.prelude/work/` 下，未在被测主机安装任何程序，未使用需要首次安装的依赖。

## 复盘

知识库原本没有任何类别，本次新建 `rest-api`（interface 维度：HTTP/JSON + OpenAPI 描述的有状态服务），并写入：

- **经验 les-85a9**（新增，candidate）：计数器类写接口必须做并发不变量测试，顺序调用会掩盖超卖。由 f-001 / f-002 / f-006 支持。要点：先用顺序调用确认 409 守卫存在，再并发断言 `successes*qty <= 初始值` 与 `初始值-最终值 == successes*qty`；2~10 并发就够；同一根因出现在别的接口（领券）要单独记一条；退还与消耗交错探测能抓到只守 409 检查的修复抓不到的丢失更新。
- **经验 les-0108**（新增，candidate）：把 OpenAPI 的 schema 和描述文本当作可执行断言。由 f-003 / f-004 / f-005 支持。要点：遍历所有页比对 total、用单条 GET 证明缺失项确实存在；把 201 返回的对象按响应 schema 校验一遍（201 出非法对象比直接拒绝更隐蔽）；测非 ASCII 必须用 Node fetch 直发 UTF-8（Git Bash 会破坏编码，本次因此误判过一次），并专测 emoji / UTF-16 代理对。
- **工具 `race-probe`**（入库到 rest-api/scripts/）：通用"并发消耗计数器"探测，带 `--base/--counter/--op/--reset/--conc` 等参数，退出码 1 = 复现、0 = 未复现或无法运行。`selfcheck.mjs` 用两个本地夹具服务器验证（原子实现必须 exit 0、非原子实现必须 exit 1、不可达目标必须 exit 0），已通过。README 记录了 Git Bash 把 `/path` 改写成 `C:/Program Files/Git/...` 的坑与 `MSYS_NO_PATHCONV=1` 解法，以及该工具不能建模交错操作的限制。
- 本次没有可追加证据或反例的既有经验（接收阶段知识库为空；test-pilot 是方法论 skill，不是经验类别）。
- 系统事实已写入 `.prelude/notes/canary-service.md`：端点表、种子数据、重置语义、库存先读后写的根因、curl 传中文会被 shell 破坏的坑。
