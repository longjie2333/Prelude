// 复现：POST /orders 并发下单导致超卖
// 依据：openapi.json 中 POST /orders "Stock is decremented by qty; stock never goes below zero."
//       不变量：成功订单数 * qty <= 初始库存，且库存不得为负。
// 退出码：观察到超卖 -> 1；未观察到 -> 0（含环境不可用）。
const base = process.env.TARGET ?? "http://localhost:4100";
const PRODUCT = "p1";
const QTY = 1;
const CONCURRENCY = 20;
const ROUNDS = 5;

async function jget(path) {
	const r = await fetch(`${base}${path}`);
	const body = await r.text();
	try {
		return { status: r.status, body: JSON.parse(body) };
	} catch {
		return { status: r.status, body };
	}
}

async function reset() {
	const r = await fetch(`${base}/reset`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({}),
	});
	if (!r.ok) throw new Error(`reset failed ${r.status}`);
}

async function order() {
	const r = await fetch(`${base}/orders`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ productId: PRODUCT, qty: QTY }),
	});
	let body;
	try {
		body = await r.json();
	} catch {
		body = null;
	}
	return { status: r.status, body };
}

let oversold = false;
try {
	for (let round = 1; round <= ROUNDS; round++) {
		await reset();
		const before = (await jget(`/products/${PRODUCT}`)).body;
		const stock0 = before.stock;

		const results = await Promise.all(
			Array.from({ length: CONCURRENCY }, () => order()),
		);
		const created = results.filter((r) => r.status === 201);
		const conflict = results.filter((r) => r.status === 409);
		const other = results.filter((r) => r.status !== 201 && r.status !== 409);

		const after = (await jget(`/products/${PRODUCT}`)).body;
		const orders = (await jget(`/orders`)).body;
		const placedQty = orders.items
			.filter((o) => o.productId === PRODUCT && o.status === "placed")
			.reduce((s, o) => s + o.qty, 0);

		const limit = Math.floor(stock0 / QTY);
		const bad =
			created.length > limit ||
			after.stock < 0 ||
			after.stock !== stock0 - created.length * QTY ||
			placedQty !== created.length * QTY;

		console.log(
			`round ${round}: stock0=${stock0} concurrent=${CONCURRENCY} -> 201=${created.length} 409=${conflict.length} other=${other.length} ` +
				`finalStock=${after.stock} placedQty=${placedQty} limit=${limit} ${bad ? "*** OVERSELL ***" : "ok"}`,
		);
		if (other.length) console.log("  unexpected statuses:", JSON.stringify(other.slice(0, 3)));
		if (bad) oversold = true;
	}
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}

console.log(oversold ? "RESULT: oversell observed" : "RESULT: no oversell observed");
process.exit(oversold ? 1 : 0);