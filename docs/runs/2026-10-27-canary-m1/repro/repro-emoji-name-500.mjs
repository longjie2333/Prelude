// 复现：POST /products 的商品名包含 emoji 时返回 500，并泄露内部错误细节
// 依据：openapi.json 中 NewProduct.name 描述为 "Any UTF-8 text"，emoji 是合法 UTF-8；
//       合法输入不应得到 5xx（盲区清单：错误提示与恢复 / 合法输入不应得到 5xx）。
// 退出码：观察到 5xx -> 1；否则 0。
const base = process.env.TARGET ?? "http://localhost:4100";

const post = async (path, body) => {
	const r = await fetch(base + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	let text = "";
	try { text = await r.text(); } catch { /* ignore */ }
	return { status: r.status, text };
};

try {
	const health = await fetch(base + "/health").catch(() => null);
	if (!health || !health.ok) {
		console.log(`target ${base} not reachable; cannot prove the problem`);
		process.exit(0);
	}
	await post("/reset", {});

	const cases = [
		{ name: "☕", price: 1, stock: 1 },
		{ name: "Emoji 😀 in name", price: 1, stock: 1 },
		{ name: "中文🎉名字", price: 1, stock: 1 },
	];
	let saw5xx = false;
	for (const body of cases) {
		const r = await post("/products", body);
		console.log(`POST /products name=${JSON.stringify(body.name)} -> ${r.status} ${r.text.slice(0, 160)}`);
		if (r.status >= 500) saw5xx = true;
	}

	// 对照：非 emoji 的 UTF-8 名称应正常创建
	const control = await post("/products", { name: "Café 中文 Ünïcode", price: 1, stock: 1 });
	console.log(`control POST /products name="Café 中文 Ünïcode" -> ${control.status} ${control.text.slice(0, 120)}`);

	await post("/reset", {});

	if (saw5xx) {
		console.log("DEFECT: valid UTF-8 name (emoji) produces 5xx; documented as 'Any UTF-8 text'");
		process.exit(1);
	}
	console.log("no 5xx observed in this run");
	process.exit(0);
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}
