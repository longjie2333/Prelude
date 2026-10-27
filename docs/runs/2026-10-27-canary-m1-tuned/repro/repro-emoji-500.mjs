// 复现：POST /products 用合法 UTF-8（含 emoji/代理对）名称返回 500
// 依据：openapi.json 中 NewProduct.name 描述为 "Any UTF-8 text"；POST /products 的
//       responses 只列出 201 Created 和 400 Invalid input；500 不在契约内，
//       合法输入不应触发 5xx。
// 退出码：观察到 5xx -> 1；未观察到 -> 0（含环境不可用）。
const base = process.env.TARGET ?? "http://localhost:4100";
const NAMES = ["widget 🎉", "🎉", "a🎉b", "日本語の商品", "café ünïcode", "Товар", "שלום"];

let serverError = false;
try {
	const reset = await fetch(`${base}/reset`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	if (!reset.ok) throw new Error(`reset failed ${reset.status}`);

	for (const name of NAMES) {
		const r = await fetch(`${base}/products`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name, stock: 1 }),
		});
		const text = await r.text();
		const problem = r.status >= 500;
		console.log(
			`POST /products name=${JSON.stringify(name)} -> ${r.status} ${text.slice(0, 120)}${problem ? "  *** 5xx ***" : ""}`,
		);
		if (problem) serverError = true;
	}
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}

console.log(serverError ? "RESULT: 5xx on valid UTF-8 name" : "RESULT: no 5xx observed");
process.exit(serverError ? 1 : 0);