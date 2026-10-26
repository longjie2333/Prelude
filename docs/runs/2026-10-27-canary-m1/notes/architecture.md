# canary inventory/order service

- 地址：http://localhost:4100（OpenAPI 3.0.3 在 `/openapi.json`，title: "Canary inventory/order service" v1.0.0）
- 单进程 HTTP 服务，响应头固定带 `x-consistency: sync`（不随请求头变化，也不代表写操作真的串行化）。
- 状态全在内存里，`POST /reset` 一条请求即可恢复到种子数据；可传 `{"stock":{id:number}}` 覆盖库存。
- 种子数据：p1..p6 六个商品（stock 10/5/100/25/3/12），另有 **p7 Whatsit stock=40** 存在于数据里但**列表接口永远看不到**（见 known-issues）。
  列表接口 `total=7` 而实际只返回 6 个 —— 少的是最后插入的那条。
- 优惠券：`SAVE10`，quota=5，`remaining` 初始 5。
- 订单 id 顺序分配 `o1,o2,...`；并发下单时 id 分配与列表顺序都正常，没有重复 id、没有丢失订单。

## 数据流

下单：`POST /orders {productId,qty}` → 校验 qty 为正整数 → 查商品 → 比较 stock >= qty → 扣减 stock → 写入订单。
扣减实现看起来是**基于读到旧值的读-改-写**（最后写入者胜），没有原子 CAS/锁：
库存 3 的商品并发 20 单，20 单全部 201，但最终 stock 落在 0~2，说明扣减被覆盖而不是累加。

取消：`POST /orders/{id}/cancel` → 订单状态 placed → cancelled，`stock += qty`。同一订单并发取消 10 次只有 1 次成功（其余 409），这一路径本身没有重复回补问题。

## 环境

- Node v22 可用（脚本用内置 fetch）。
- 并发用 `Promise.all` 打 20~200 个请求即可稳定触发（HTTP/1.1 keep-alive，不需要额外工具）。
