# canary 接口行为速查（2026-10-27 实测）

## 正常行为

| 请求 | 结果 |
|---|---|
| `GET /health` | 200 `{"ok":true}` |
| `POST /reset {}` | 200 `{"ok":true}`，恢复 6 个种子商品、清空订单、券恢复 |
| `POST /reset {"stock":{"p1":10}}` | 200，覆盖指定商品库存（**不校验**，见 f-005） |
| `GET /products?page&size` | 200 `{items,page,size,total,pages}`；size 默认 3，越界钳制/回退 |
| `POST /products {name,price,stock}` | 201 + Product；name 必填（空/缺 → 400 `name required`）；price/stock 缺省为 0；**不校验类型/范围**（f-006、f-007） |
| `GET /products/{id}` | 200 Product；未知 404 `{"error":"product not found"}` |
| `GET /coupons/{code}` | 200 `{code,quota,remaining}`；未知 404 `{"error":"coupon not found"}` |
| `POST /coupons/{code}/claim` | 201 `{code,remaining}`；耗尽 409 `{"error":"quota exhausted"}` |
| `GET /orders` | 200 `{items:[Order]}` |
| `POST /orders {productId,qty}` | 201 Order `{id,productId,qty,status:"placed"}`；库存不足 409 `insufficient stock` |
| `POST /orders/{id}/cancel` | 200 Order `status:"cancelled"`；已取消 409 `already cancelled`；未知 404 `order not found` |

## 种子数据（reset 后）

商品：p1 Widget 9.5/10、p2 Gadget 19/5、p3 Doohickey 4.25/100、p4 Sprocket 1.1/25、p5 Gizmo 42/3、p6 Thingamajig 7/12、p7 Whatsit 3.3/40
券：SAVE10 quota=5

## 关键不变量（预期值依据，均来自 openapi.json）

1. `POST /orders`："Stock is decremented by qty; stock never goes below zero" → 成功量 ≤ 初始库存，库存 = 初始 − 成功量。
2. `POST /coupons/{code}/claim`："remaining never goes below zero" → 成功领取数 ≤ quota。
3. `GET /products`："Every product appears on exactly one page" → 遍历所有页并集 = total，无重复无缺失。
4. `NewProduct.name`："Any UTF-8 text"；`Product.price:number`、`Product.stock:{integer,minimum:0}`。
5. `POST /orders/{id}/cancel`：回补 qty，同一订单只能取消一次。

## 技术栈线索

- 错误详情出现 `slugify: unexpected surrogate pair`，说明创建商品时会走 slug 生成（对 UTF-16 代理对处理有 bug）。
- 判断为单进程内存态（无持久化证据）；并发下无锁，读-判断-写非原子。