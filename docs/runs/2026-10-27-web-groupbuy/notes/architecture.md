# 社区团购订单聚合与分拣配送调度系统

目标：`http://8.155.17.234:50080/`（测试环境，仅功能/界面测试）。

## 技术栈

- 前端：Vue 3 + Vue Router(hash) + Pinia + Element Plus + ECharts，Vite 构建，产物 `/assets/index-*.js`。
- 后端：Java / SpringBoot 3.2 / MyBatis（前端页脚自述 `SpringBoot + Vue3 + MyBatis`；错误体是 Spring Boot 默认 JSON）。
- 网关：nginx/1.18.0 提供静态资源，`/api/*` 反代到后端。
- 会话：登录返回 `token`，请求头 `X-Token`；前端存 `localStorage["gb_auth"]`。
- 统一响应：`{code, message, data}`，`code=200` 成功；`code=401` 未登录；HTTP 状态在业务错误时仍可能为 200，参数/框架错误返回 Spring 默认 `{timestamp,status,error,path}`（HTTP 400/404/500）。

## 路由与角色

- `/login` 公共；`/admin/*` 需 ADMIN；`/leader/*` 需 LEADER；`/courier/*` 需 COURIER。
- 前端守卫：`beforeEach` 校验 `meta.role`，不匹配则跳回该角色 `homePath`。API 权限由后端决定。
- 角色首页：ADMIN `/admin/dashboard`，LEADER `/leader/home`，COURIER `/courier/tasks`。

## 账号

- 管理员 `admin`；团长 `leader1~leader6`（refId 1~6，绑定自提点）；配送员 `courier1~courier3`（refId 1~3，绑定配送员/车辆）。
- 账号页脚明文列出演示账号与口令（源码 Accounts-*.js 内硬编码）。

## 接口（前端 baseURL=/api，均需 X-Token 除 /auth/login）

- 认证：`POST /auth/login`、`POST /auth/logout`、`GET /auth/me`、`GET /auth/accounts`、`POST /auth/accounts/{id}/reset-password {newPassword}`
- 订单：`GET /order/list?status&pickupPointId&keyword&orderNo`、`GET /order/{id}`、`GET /order/{id}/items`、`POST /order/{id}/status?status=N`
- 聚合：`GET /order/aggregate/by-point?statuses=1,2`、`/order/aggregate/by-product?pointIds&statuses`、`/order/aggregate/waves?capacity`、`GET /order/sorting-detail?pickupPointId&statuses`
- 统计：`GET /order/stat/overview|trend|point-ranking?limit|product-ranking?limit`
- 分拣：`GET /dispatch/sorting/list?wave`、`POST /dispatch/sorting/generate?capacity`、`POST /dispatch/sorting/{id}/status?status&sorterName`、`GET /dispatch/sorting/waves`
- 调度：`GET /dispatch/courier/list`、`GET /dispatch/delivery/list`、`GET /dispatch/delivery/{id}`、`GET /dispatch/delivery/{id}/route`、`POST /dispatch/delivery/auto-dispatch?courierIds`、`POST /dispatch/delivery/{id}/status?status`、`GET /dispatch/courier/{id}/deliveries`
- 商品：`GET /product/list?category`、`GET /product/{id}`、`GET /product/categories`、`POST /product/save`、`DELETE /product/{id}`
- 自提点：`GET /pickup-point/list?status`、`GET /pickup-point/{id}`、`POST /pickup-point/save`、`DELETE /pickup-point/{id}`

## 状态枚举（前端定义，后端一致）

- 订单 status：0 待付款、1 待分拣、2 分拣中、3 待配送、4 配送中、5 已到站、6 已完成、7 已取消。
- 分拣任务 status：0 待分拣、1 分拣中、2 已完成。
- 配送单 status：0 待出发、1 配送中、2 已完成。
- 商品/自提点/账号 status：1 启用，0 停用。

## 预置数据（2026-10-27 快照）

- 6 个自提点（id 1~6，均启用）、12 个商品（5 个分类）、10 个账号、3 个配送员（容量 800/400/600）、71 张订单、0 张配送单。
- 订单状态分布：1:40, 2:13, 3:6, 4:6, 6:5, 7:1。
- 统计 overview：totalOrders=71, pendingOrders=40, processingOrders=25, finishedOrders=5, totalItems=479, totalAmount=13837.6, deliveryCount=0。

## 已知坑

- 直接用 curl 传 `//path` 会被 MSYS 路径转换破坏；用 node fetch 脚本。
- 后端对未登录返回 HTTP 200 + `code:401`。
- 前端 `main` 里用 `<keep-alive max=6>` 包裹 router-view。

## 环境/工具

- Node v22.23.2（内置 fetch + WebSocket）；项目根 `C:/Users/longjie/AppData/Local/Temp/prelude-web1/run/project` 已安装 `playwright`（chromium 已在 ms-playwright 缓存）。
- 探测脚本：`.prelude/work/probe/api.mjs`（login/call 辅助）、`explore.mjs`（按角色遍历 GET）。