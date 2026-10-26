// 复现：并发超卖产生的订单被取消后，库存被回补到超过初始值（库存凭空增加）
// 依据：取消订单应把该订单扣掉的 qty 还回库存 —— 守恒：初始库存 = 当前库存 + 未取消订单的 qty。
//       库存 1、10 个并发 qty=1 订单（已知会超卖）全部取消后，库存应回到 1，而不是 12。
// 退出码：取消后库存 > 初始库存 -> 1；否则 0。
const base = process.env.TARGET ?? "http://localhost:4100";
const INITIAL = 1;

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

try {
	const health = await fetch(base + "/health").catch(() => null);
	if (!health || !health.ok) {
		console.log(`target ${base} not reachable; cannot prove the problem`);
		process.exit(0);
	}
	const reset = await post("/reset", { stock: { p5: INITIAL } });
	if (reset.status !== 200) {
		console.log("reset failed; cannot prepare state");
		process.exit(0);
	}
	const before = await getJson("/products/p5");
	console.log(`setup: p5 stock = ${before.json?.stock} (expected ${INITIAL})`);
	if (before.json?.stock !== INITIAL) {
		console.log("could not prepare state");
		process.exit(0);
	}

	const N = 10;
	const responses = await Promise.all(
		Array.from({ length: N }, () => post("/orders", { productId: "p5", qty: 1 }).catch((e) => ({ status: "ERR", json: { error: String(e) } }))),
	);
	const accepted = responses.filter((r) => r.status === 201).map((r) => r.json?.id).filter(Boolean);
	console.log(`concurrent orders x${N} on stock ${INITIAL}: accepted ${accepted.length} (${accepted.join(",")})`);

	const mid = await getJson("/products/p5");
	console.log(`p5 stock after orders: ${mid.json?.stock}`);

	let cancelled = 0;
	for (const id of accepted) {
		const r = await post(`/orders/${id}/cancel`);
		if (r.status === 200) cancelled++;
	}
	console.log(`cancelled ${cancelled}/${accepted.length} orders`);

	const after = await getJson("/products/p5");
	console.log(`p5 stock after cancelling every order: ${after.json?.stock} (initial was ${INITIAL})`);

	if (typeof after.json?.stock === "number" && after.json.stock > INITIAL) {
		console.log(`DEFECT: stock inflated from ${INITIAL} to ${after.json.stock}; cancelling orders that were accepted on a single unit of stock created ${after.json.stock - INITIAL} phantom units`);
		process.exit(1);
	}
	console.log("no stock inflation observed in this run");
	process.exit(0);
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}
