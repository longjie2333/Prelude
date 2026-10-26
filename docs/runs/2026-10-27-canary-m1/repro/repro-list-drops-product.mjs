// 复现：GET /products 分页列表漏掉最后一个商品（total 比实际返回多 1）
// 依据：openapi.json 中 GET /products 描述 "A page of products. Every product appears on exactly one page."
//       即遍历所有页（page=1..pages）拿到的并集应当等于 total 个商品，且每个商品只出现一次。
// 退出码：并集大小 < total（或漏掉可通过 GET /products/{id} 读到的商品）-> 1；否则 0。
const base = process.env.TARGET ?? "http://localhost:4100";

const getJson = async (path) => {
	const r = await fetch(base + path);
	return { status: r.status, json: await r.json().catch(() => null) };
};

try {
	const health = await fetch(base + "/health").catch(() => null);
	if (!health || !health.ok) {
		console.log(`target ${base} not reachable; cannot prove the problem`);
		process.exit(0);
	}
	const reset = await fetch(base + "/reset", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	}).catch(() => null);
	if (!reset || !reset.ok) {
		console.log("reset failed; cannot prepare state");
		process.exit(0);
	}

	// 用 size=3 走完所有页，收集并集
	const collected = [];
	let meta = null;
	for (let page = 1; page <= 50; page++) {
		const r = await getJson(`/products?page=${page}&size=3`);
		if (r.status !== 200 || !r.json) {
			console.log("listing failed; cannot prove the problem");
			process.exit(0);
		}
		meta = r.json;
		if (r.json.items.length === 0) break;
		collected.push(...r.json.items.map((p) => p.id));
	}
	const unique = new Set(collected);
	console.log(`pagination walk (size=3): total=${meta.total} pages=${meta.pages} items collected=${collected.length} unique=${unique.size}`);
	console.log(`ids seen: ${collected.join(",")}`);

	if (meta.total <= unique.size) {
		console.log("no missing product observed in this run");
		process.exit(0);
	}

	// 找出缺失的 id：用 GET /products/{id} 确认它其实存在
	const missing = [];
	for (let i = 1; i <= meta.total + 5; i++) {
		const id = `p${i}`;
		if (unique.has(id)) continue;
		const direct = await getJson(`/products/${id}`);
		if (direct.status === 200) missing.push(`${id}(GET 200, name=${direct.json?.name})`);
	}
	console.log(`products reachable via GET /products/{id} but absent from every list page: ${missing.join(", ") || "none"}`);
	if (missing.length > 0) {
		console.log(`DEFECT: total=${meta.total} but only ${unique.size} products are reachable through pagination (${missing.length} orphaned)`);
		process.exit(1);
	}
	console.log("total mismatch but no orphaned product confirmed; not reporting");
	process.exit(0);
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}
