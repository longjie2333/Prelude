// 复现：POST /products 不做输入校验，创建出违反 Product schema 的商品
// 依据：openapi.json 的 Product schema：required [id,name,price,stock]，
//       price: number，stock: integer, minimum 0。POST /products 成功（201）后
//       返回的 Product 以及 GET /products/{id} 返回的 Product 都必须满足该 schema。
// 退出码：观察到 price 非 number 或 stock < 0 被接受 -> 1；未观察到 -> 0。
const base = process.env.TARGET ?? "http://localhost:4100";

async function create(body) {
	const r = await fetch(`${base}/products`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	let parsed;
	try {
		parsed = await r.json();
	} catch {
		parsed = null;
	}
	return { status: r.status, body: parsed };
}

async function getProduct(id) {
	const r = await fetch(`${base}/products/${id}`);
	let body;
	try {
		body = await r.json();
	} catch {
		body = null;
	}
	return { status: r.status, body };
}

let violation = false;
try {
	const reset = await fetch(`${base}/reset`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	if (!reset.ok) throw new Error(`reset failed ${reset.status}`);

	// case 1: price 为字符串
	const c1 = await create({ name: "probe-price", price: "abc", stock: 1 });
	const g1 = c1.body?.id ? await getProduct(c1.body.id) : { status: 0, body: null };
	console.log(
		`POST /products price="abc" -> ${c1.status} ${JSON.stringify(c1.body)}; GET /products/${c1.body?.id} -> ${g1.status} ${JSON.stringify(g1.body)}`,
	);
	if (c1.status === 201 && typeof g1.body?.price !== "number") {
		console.log("*** Product.price is not a number (schema requires number) ***");
		violation = true;
	}

	// case 2: 负库存
	const c2 = await create({ name: "probe-neg", stock: -3 });
	const g2 = c2.body?.id ? await getProduct(c2.body.id) : { status: 0, body: null };
	console.log(
		`POST /products stock=-3 -> ${c2.status} ${JSON.stringify(c2.body)}; GET /products/${c2.body?.id} -> ${g2.status} ${JSON.stringify(g2.body)}`,
	);
	if (c2.status === 201 && g2.body?.stock < 0) {
		console.log("*** Product.stock < 0 (schema minimum is 0) ***");
		violation = true;
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

console.log(violation ? "RESULT: product schema violated" : "RESULT: no schema violation");
process.exit(violation ? 1 : 0);