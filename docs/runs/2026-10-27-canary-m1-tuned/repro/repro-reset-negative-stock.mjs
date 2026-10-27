// 复现：reset 接口不做 stock 覆盖校验，可产生违反 Product.stock schema 的库存
// 依据：openapi.json 中 Product.stock {type:integer, minimum:0}；POST /orders 契约
//       "stock never goes below zero"；POST /reset 的 stock 覆盖语义是设置库存，
//       因此应拒绝/钳制非整数与负值。
// 退出码：观察到负库存或 null 库存被接受 -> 1；未观察到 -> 0（含环境不可用）。
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
	const r = await fetch(`${base}/reset`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ stock: { p1: -5 } }),
	});
	console.log(`POST /reset {stock:{p1:-5}} -> ${r.status} ${await r.text()}`);

	const p1 = await get(`/products/p1`);
	console.log(`GET /products/p1 -> ${p1.status} ${JSON.stringify(p1.body)}`);

	// 负库存被接受 = 状态本身已违反 stock >= 0（Product.stock minimum: 0）
	if (p1.body?.stock < 0) {
		console.log(`*** NEGATIVE STOCK ACCEPTED: stock=${p1.body.stock} (Product.stock minimum is 0) ***`);
		broken = true;
	}

	// case 2: stock 覆盖为非整数值，产生 stock:null（违反 integer）
	const r2 = await fetch(`${base}/reset`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ stock: { p1: "abc" } }),
	});
	const p1b = await get(`/products/p1`);
	console.log(`POST /reset {stock:{p1:"abc"}} -> ${r2.status} ${await r2.text()}`);
	console.log(`GET /products/p1 -> ${p1b.status} ${JSON.stringify(p1b.body)}`);
	if (r2.status === 200 && typeof p1b.body?.stock !== "number") {
		console.log(`*** NON-INTEGER STOCK ACCEPTED: stock=${JSON.stringify(p1b.body?.stock)} (Product.stock type is integer) ***`);
		broken = true;
	}

	// case 3: 重新置为负库存，附带检查此时是否还能继续下单
	await fetch(`${base}/reset`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ stock: { p1: -5 } }),
	});

	const order = await fetch(`${base}/orders`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ productId: "p1", qty: 1 }),
	});
	const orderText = await order.text();
	const after = await get(`/products/p1`);
	console.log(`POST /orders p1 qty=1 -> ${order.status} ${orderText}; stock now ${after.body?.stock}`);
	if (order.status === 201 && after.body?.stock < 0) {
		console.log("*** ORDER ACCEPTED WITH NEGATIVE STOCK ***");
		broken = true;
	}

	await fetch(`${base}/reset`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}

console.log(broken ? "RESULT: stock invariant violated via /reset" : "RESULT: /reset kept stock >= 0");
process.exit(broken ? 1 : 0);