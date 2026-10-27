# 复现脚本约定

`verify_findings` 会把冻结的脚本复制到一个**空目录**里运行 3 次，按退出码判断：**非 0 = 问题复现，0 = 未复现**。复现率 ≥ 60% 才算复现。之后审查员只看得到描述、脚本和输出。

## 必须

- **单文件、自包含**：不 import 本地其他文件，只用语言自带的库（推荐 `.mjs`，用 Node 内置 `fetch`）。复验在项目里的一个空目录中运行，没有你的工作目录。唯一的例外是浏览器自动化：在**项目根目录**安装的 `playwright` 能被复验时的脚本找到（`import { chromium } from "playwright"`）；别的依赖不要用。
- **不依赖当前目录**：不读相对路径的文件；目标地址写在脚本里，或读环境变量并给默认值。
- **只在观察到问题时以非 0 退出**：把断言写成显式判断。连不上目标、准备数据失败、意外异常时打印原因并以 0 退出（未能证明问题，不是复现）。未捕获的异常会以非 0 退出，会被误判为复现，所以要捕获。
- **可重复**：每次运行前自己准备状态（系统有重置接口就先调用），不依赖上一次运行的残留。
- **打印关键观测值**：请求、响应状态、实际值与预期值、预期的依据。审查员靠这些判断。
- **120 秒内结束**。

## 偶发问题

并发、时序类问题在脚本内部多试几轮，任意一轮观察到即算复现，让单次运行的复现率尽量稳定。打印每一轮的结果。

## 示例

```js
// .prelude/work/repro-negative-qty.mjs
const base = process.env.TARGET ?? "http://localhost:8080";
try {
	const r = await fetch(`${base}/items`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "x", qty: -1 }),
	});
	console.log("POST /items qty=-1 ->", r.status, await r.text());
	// 依据：openapi.json 中 qty 的 minimum 为 0，非法输入应返回 400。
	process.exit(r.status === 400 ? 0 : 1);
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}
```
