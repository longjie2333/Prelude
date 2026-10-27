// 复现：GET /products 分页丢数据，某商品不出现在任何一页
// 依据：openapi.json 中 GET /products "A page of products. Every product appears on
//       exactly one page." 以及响应里的 total。
// 不变量：遍历 page=1..pages 收集到的商品并集大小 === total，且无重复；
//         每个已存在的商品（GET /products/{id} 返回 200）都应能在某一页找到。
// 退出码：观察到缺页/重复 -> 1；未观察到 -> 0（含环境不可用）。
const base = process.env.TARGET ?? "http://localhost:4100";

async function get(path) {
	const r = await fetch(`${base}${path}`);
	let body;
	try {
		body = await r.json();
	} catch {
		body = null;
	}
	return { status: r.status, body };
}

let broken = false;
try {
	const reset = await fetch(`${base}/reset`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	if (!reset.ok) throw new Error(`reset failed ${reset.status}`);

	for (const size of [2, 3, 4, 5]) {
		const first = (await get(`/products?page=1&size=${size}`)).body;
		const seen = [];
		const perPage = [];
		for (let page = 1; page <= first.pages; page++) {
			const r = (await get(`/products?page=${page}&size=${size}`)).body;
			perPage.push(r.items.length);
			seen.push(...r.items.map((p) => p.id));
		}
		const dupes = seen.filter((id, i) => seen.indexOf(id) !== i);
		const missing = first.total - new Set(seen).size;
		const bad = dupes.length > 0 || missing !== 0;

		console.log(
			`size=${size}: total=${first.total} pages=${first.pages} itemsPerPage=[${perPage.join(",")}] ` +
				`collected=${seen.length} unique=${new Set(seen).size} missing=${missing} dupes=[${[...new Set(dupes)].join(",")}] ` +
				`${bad ? "*** PAGINATION LOSS ***" : "ok"}`,
		);
		if (bad) broken = true;
	}

	// 交叉验证：种子商品 p7 直接按 id 可读，却可能不在任何一页里
	const byId = await get(`/products/p7`);
	const first = (await get(`/products?page=1&size=3`)).body;
	const all = [];
	for (let page = 1; page <= first.pages; page++) {
		const r = (await get(`/products?page=${page}&size=3`)).body;
		all.push(...r.items.map((p) => p.id));
	}
	const p7Reachable = all.includes("p7");
	console.log(
		`p7: GET /products/p7 -> ${byId.status} ${JSON.stringify(byId.body)}; reachable via pagination: ${p7Reachable}`,
	);
	if (byId.status === 200 && !p7Reachable) {
		console.log("*** PRODUCT EXISTS BUT UNREACHABLE VIA /products ***");
		broken = true;
	}
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}

console.log(broken ? "RESULT: pagination contract violated" : "RESULT: pagination consistent");
process.exit(broken ? 1 : 0);