# canary 服务测试笔记（2026-10-27，run-20261027-1021-4bb0）

## 环境与重置

- 目标：`http://localhost:4100`，OpenAPI 存档于 `.prelude/work/openapi.json`
- 无鉴权、匿名可用；内存态服务
- 重置：`curl -X POST localhost:4100/reset -H 'content-type: application/json' -d '{}'`
  - 会把商品恢复到 6 个种子商品（p1..p6）、订单清空、优惠券 SAVE10 恢复 quota/remaining=5
  - 注意：**p7（Whatsit）不在分页结果中，但 `GET /products/p7` 可读**；reset 后仍存在
  - `/reset` 支持 `{"stock":{"<id>":n}}` 覆盖库存，但**不做校验**：可设负数或字符串（→ null）
- 探测后请 reset 恢复状态；写操作务必串行

## 已知缺陷（本 run 复验，报告 `.prelude/reports/2026-10-27-order-oversell.md`）

1. **f-001 下单并发超卖**（critical）：20 并发买 p1(库存10) 全部 201，库存只扣 1~2 次。check-then-act 竞态。
2. **f-002 领券并发超领**（critical）：SAVE10 quota=5，20 并发 claim 全 201，remaining 只降 1~2 次。串行时正确（第 6 次起 409）。
3. **f-003 下单/取消并发丢失更新**（high）：5 取消 + 5 新建并发后库存 99（应 95）。place 与 cancel 互相覆盖。
4. **f-006 商品名含 emoji → 500**（high）：`slugify: unexpected surrogate pair`。日文/西里尔/希伯来等非代理对 UTF-8 正常。
5. **f-004 分页丢商品**（medium）：total=7 但任何 size 下遍历所有页只有 6 个，末页恒空；p7 不可见。确定性。
6. **f-007 建商品无校验**（medium）：price 传字符串→存成 null；stock 传负数→接受。违反 Product schema。
7. **f-005 reset 库存覆盖无校验**（low）：可设 stock=-5 或 "abc"→null。

## 行为正确的点（下次可跳过或作回归基线）

- 并发取消同一订单：1 次 200 + 19 次 409，库存只回补一次
- 并发创建商品：20 并发 id 唯一、total 一致、按 id 可读
- 下单参数校验：qty=0/-1/1.5/字符串/null/缺失 → 400 且不改库存；未知商品 → 404；非法 JSON → 400
- 分页参数：size=-1 / 1e3 静默当 1；size=101 钳到 100；page 非法回退 1（不报错但不破坏数据）
- 串行取消：重复取消 409，未知订单 404

## 踩坑

- Windows Git Bash 下 `/tmp` 与 `C:/.../Temp` 不是同一位置，curl 输出到 `/tmp/x` 后用 node 读 `/tmp/x` 会 FileNotFound；统一放在工作目录 `.prelude/work/` 下。
- `python` 可能不存在（只有 `python3` 或都没有），优先用 Node 写探测脚本。
- 探测脚本必须每轮先 `POST /reset`，否则上一轮订单/库存残留会导致误判。