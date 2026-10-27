# canary 服务概览

- 目标：`http://localhost:4100`（scope 允许 functional + load）
- OpenAPI：`/openapi.json`（已存档 `.prelude/work/openapi.json`）
- 标题：Canary inventory/order service v1.0.0，内存态（reset 后回到种子数据）
- 无鉴权，匿名可用；无需 token
- 技术栈：未知（仅 HTTP 接口可见），非持久化（reset 语义为"回到种子数据"）

## 接口清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /health | `{"ok":true}` |
| POST | /reset | 重置全部状态；可传 `{"stock":{...}}` 覆盖指定商品库存 |
| GET | /products?page&size | 分页；契约声明"每个商品恰好出现在一页"；size 1..100，默认 3 |
| POST | /products | 创建商品，返回 201 + 商品（id 服务端分配） |
| GET | /products/{id} | 商品详情，404 `{"error":"product not found"}` |
| GET | /coupons/{code} | 优惠券 `{code,quota,remaining}`；未知券 404 |
| POST | /coupons/{code}/claim | 领一次；201；配额耗尽 409；契约"remaining 不会低于 0" |
| GET | /orders | 所有订单 |
| POST | /orders | 下单 `{productId,qty}`，qty≥1；201；库存不足 409；契约"库存不会低于 0" |
| POST | /orders/{id}/cancel | 取消并回补库存；404；已取消 409 |

## 种子数据（reset 后）

- p1 Widget price 9.5 stock 10
- p2 Gadget price 19 stock 5
- p3 Doohickey price 4.25 stock 100
- p4 Sprocket price 1.1 stock 25
- p5 Gizmo price 42 stock 3
- p6 Thingamajig price 7 stock 12
- p7 Whatsit price 3.3 stock 40（**不在分页结果里**，见 known-issues）
- 优惠券：SAVE10 quota=5

## 关键不变量（预期值依据）

1. `/products` 契约："Every product appears on exactly one page" → 遍历所有页的并集必须等于 total 个商品且无重复。
2. `/orders` 契约："stock never goes below zero"；下单成功数 × qty ≤ 初始库存（守恒）。
3. `/coupons/{code}/claim` 契约："remaining never goes below zero"；成功领取数 ≤ quota（守恒）。
4. 取消订单应回补库存，库存回到初始值（往返一致）。