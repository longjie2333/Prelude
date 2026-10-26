// 复现：POST /orders 在并发下超卖 —— 接受的订单总数量超过库存，且库存守恒被破坏
// 依据：openapi.json 中 POST /orders summary: "Place an order. Stock is decremented by qty;
//       stock never goes below zero."，并定义 409 Insufficient stock。
//       即：库存 N 时，成功下单的总 qty 不得超过 N（守恒：剩余库存 + 已售数量 = 初始库存）。
// 退出码：观察到超卖 -> 1；未观察到（或无法证明）-> 0。
const base = process.env.TARGET ?? "http://localhost:4100";

const post = async (path, body) => {
	const r = await fetch(base + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let json = null;
	try { json = await r.json(); } catch { /* ignore */ }
	return { status: r.status, json };
};
const getJson = async (path) => {
	const r = await fetch(base + path);
	return { status: r.status, json: await r.json().catch(() => null) };
};

const STOCK = 1;
const N = 10;

try {
	const health = await fetch(base + "/health").catch(() => null);
	if (!health || !health.ok) {
		console.log(`target ${base} not reachable; cannot prove the problem`);
		process.exit(0);
	}

	const reset = await post("/reset", { stock: { p5: STOCK } });
	if (reset.status !== 200) {
		console.log("reset failed:", reset.status, JSON.stringify(reset.json));
		process.exit(0);
	}
	const before = await getJson("/products/p5");
	console.log(`setup: p5 stock = ${before.json?.stock} (expected ${STOCK})`);
	if (before.json?.stock !== STOCK) {
		console.log("could not prepare state; cannot prove the problem");
		process.exit(0);
	}

	// 对照：顺序下单时服务是正确拒绝的（证明断言不会误伤正确实现）
	const seqStock = 2;
	await post("/reset", { stock: { p5: seqStock } });
	const seqStatuses = [];
	for (let i = 0; i < 4; i++) {
		seqStatuses.push((await post("/orders", { productId: "p5", qty: 1 })).status);
	}
	console.log(`control (sequential, stock=${seqStock}): statuses ${seqStatuses.join(",")} (expect 201,201,409,409)`);

	await post("/reset", { stock: { p5: STOCK } });

	// 并发下单：库存 1，10 个 qty=1 的请求同时到达
	const responses = await Promise.all(
		Array.from({ length: N }, () => post("/orders", { productId: "p5", qty: 1 }).catch((e) => ({ status: "ERR", json: { error: String(e) } }))),
	);
	const counts = {};
	for (const r of responses) counts[r.status] = (counts[r.status] ?? 0) + 1;
	const accepted = responses.filter((r) => r.status === 201);
	console.log(`concurrent POST /orders x${N} (stock=${STOCK}, qty=1) -> statuses ${JSON.stringify(counts)}`);
	console.log(`accepted orders (201): ${accepted.length}, expected at most ${STOCK}`);

	const after = await getJson("/products/p5");
	console.log(`p5 stock after: ${after.json?.stock}`);

	const orders = await getJson("/orders");
	const placed = (orders.json?.items ?? []).filter((o) => o.productId === "p5" && o.status === "placed");
	const soldQty = placed.reduce((s, o) => s + o.qty, 0);
	console.log(`placed orders for p5: ${placed.length}, total qty sold: ${soldQty}`);
	console.log(`conservation: stock(${after.json?.stock}) + sold(${soldQty}) = ${(after.json?.stock ?? 0) + soldQty}, expected ${STOCK}`);

	const oversold = accepted.length > STOCK;
	if (oversold) {
		console.log(`DEFECT: accepted ${accepted.length} orders for a product with stock ${STOCK} (oversold by ${accepted.length - STOCK})`);
		process.exit(1);
	}
	console.log("no oversell observed in this run");
	process.exit(0);
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}
