# 接口行为记录（实测）

| 接口 | 实测行为 |
|---|---|
| GET /health | 200 `{"ok":true}` |
| POST /reset | 200 `{"ok":true}`；`{"stock":{"p1":7}}` 覆盖生效；**接受负数** `{"stock":{"p1":-3}}` → p1 stock=-3；未知 id 被忽略 |
| GET /products?page&size | 返回 `items/page/size/total/pages`；**items 恒比 total 少 1（最后一条）**；page=0/-1/abc → 归一为 1；size=0/abc → 3；size>100 → 100；size=-3 → 1；size 超上限静默截断而不是 400 |
| GET /products/{id} | 200/404；p7 可单查（200, stock 40）但不在列表里 |
| POST /products | 201 `{id,name,price,stock}`；`{}`、`{"name":""}`、`{"name":123}` → 400 `name required`；**`stock:-5`、`stock:-2` 被接受（201）**；`price:-1` 也被接受（price 无 minimum，不算违约） |
| GET /coupons/{code} | 200 `{code,quota,remaining}`；未知 code 404 `coupon not found` |
| POST /coupons/{code}/claim | 201 成功 / 409 `Quota exhausted`；顺序调用严格 5 次后 remaining=0；**并发 20 次全部 201** |
| GET /orders | 200 `{"items":[...]}`，无分页 |
| POST /orders | 201 `{id,productId,qty,status}` / 409 `insufficient stock` / 400 `qty must be a positive integer` / 404 `product not found`；顺序调用不会超卖；并发会超卖 |
| POST /orders/{id}/cancel | 200 → `status:"cancelled"`，库存回补；重复取消 409 `already cancelled`；未知 id 404 `order not found` |

## 输入校验实测

- `qty`：0、-1、"1"、1.5、true、缺字段 → 400（正确）
- `productId`："" 或 null → 404（可接受）；未知 id → 404
- 多余字段被忽略（正常）
