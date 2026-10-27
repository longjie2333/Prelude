// 复现：下单与取消并发导致库存账目与订单不一致（丢失更新）
// 依据：/orders 契约 "stock never goes below zero" + /orders/{id}/cancel 回补 qty。
// 不变量（对任意串行化结果都成立）：stock = stock0 - sum(placed 订单 qty)，
//   且 stock >= 0。并发执行一组下单/取消后，该等式必须仍成立。
// 退出码：观察到不一致 -> 1；未观察到 -> 0（含环境不可用）。
const base = process.env.TARGET ?? "http://localhost:4100";
const PRODUCT = "p3"; // stock 100，留出空间
const ROUNDS = 5;

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

let inconsistent = false;
try {
	for (let round = 1; round <= ROUNDS; round++) {
		const reset = await fetch(`${base}/reset`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		if (!reset.ok) throw new Error(`reset failed ${reset.status}`);
		const stock0 = (await get(`/products/${PRODUCT}`)).body.stock;

		// 先创建 5 个订单（qty 各 1），记录 id
		const orderIds = [];
		for (let i = 0; i < 5; i++) {
			const r = await fetch(`${base}/orders`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ productId: PRODUCT, qty: 1 }),
			});
			if (r.status !== 201) throw new Error(`order create failed ${r.status}`);
			orderIds.push((await r.json()).id);
		}

		// 并发：取消 5 个已存在订单 + 下 5 个新订单
		const ops = [
			...orderIds.map((id) =>
				fetch(`${base}/orders/${id}/cancel`, { method: "POST" }).then((r) => r.status),
			),
			...Array.from({ length: 5 }, () =>
				fetch(`${base}/orders`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ productId: PRODUCT, qty: 1 }),
				}).then((r) => r.status),
			),
		];
		const statuses = await Promise.all(ops);

		const stock = (await get(`/products/${PRODUCT}`)).body.stock;
		const orders = (await get(`/orders`)).body.items.filter((o) => o.productId === PRODUCT);
		const placedQty = orders
			.filter((o) => o.status === "placed")
			.reduce((s, o) => s + o.qty, 0);
		const expected = stock0 - placedQty;
		const bad = stock !== expected || stock < 0;

		console.log(
			`round ${round}: stock0=${stock0} statuses=[${statuses.join(",")}] placedQty=${placedQty} stock=${stock} expected=${expected} ` +
				`${bad ? "*** INCONSISTENT ***" : "ok"}`,
		);
		if (bad) inconsistent = true;
	}
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}

console.log(inconsistent ? "RESULT: stock/order inconsistency observed" : "RESULT: consistent");
process.exit(inconsistent ? 1 : 0);