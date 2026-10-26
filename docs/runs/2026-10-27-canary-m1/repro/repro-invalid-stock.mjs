// 复现：库存字段缺少校验 —— 接受负数、小数、字符串，产生违反 schema 的商品
// 依据：openapi.json components.schemas.Product.stock = {"type":"integer","minimum":0}
//       NewProduct.stock 与 POST /reset 的 stock 覆盖项都写入同一个库存值，不应产生 stock<0 或非整数。
// 退出码：观察到任一路径写入非法库存 -> 1；否则 0。
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

const violations = [];

try {
	const health = await fetch(base + "/health").catch(() => null);
	if (!health || !health.ok) {
		console.log(`target ${base} not reachable; cannot prove the problem`);
		process.exit(0);
	}
	await post("/reset", {});

	// 路径 1：POST /products 带负 stock
	const neg = await post("/products", { name: "NegStockProbe", price: 1, stock: -5 });
	console.log(`POST /products {stock:-5} -> ${neg.status} ${JSON.stringify(neg.json)}`);
	if (neg.status === 201 && typeof neg.json?.stock === "number" && neg.json.stock < 0) {
		violations.push(`created product ${neg.json.id} with stock=${neg.json.stock} (minimum is 0)`);
	}

	// 路径 2：POST /products 带小数 stock
	const frac = await post("/products", { name: "FracStockProbe", price: 1, stock: 1.5 });
	console.log(`POST /products {stock:1.5} -> ${frac.status} ${JSON.stringify(frac.json)}`);
	if (frac.status === 201 && typeof frac.json?.stock === "number" && !Number.isInteger(frac.json.stock)) {
		violations.push(`created product ${frac.json.id} with non-integer stock=${frac.json.stock} (type is integer)`);
	}

	// 路径 3：POST /products 带字符串 stock
	const str = await post("/products", { name: "StrStockProbe", price: 1, stock: "3" });
	console.log(`POST /products {stock:"3"} -> ${str.status} ${JSON.stringify(str.json)}`);
	if (str.status === 201 && typeof str.json?.stock !== "number") {
		violations.push(`created product ${str.json.id} with stock of type ${typeof str.json.stock}`);
	}

	// 路径 4：POST /reset 用负库存覆盖已有商品
	const resetNeg = await post("/reset", { stock: { p1: -3 } });
	const p1 = await getJson("/products/p1");
	console.log(`POST /reset {stock:{p1:-3}} -> ${resetNeg.status}; GET /products/p1 = ${JSON.stringify(p1.json)}`);
	if (typeof p1.json?.stock === "number" && p1.json.stock < 0) {
		violations.push(`p1 stock=${p1.json.stock} after reset (minimum is 0)`);
	}

	// 恢复种子状态
	await post("/reset", {});

	if (violations.length > 0) {
		console.log("DEFECT: invalid stock values accepted:");
		for (const v of violations) console.log(`  - ${v}`);
		process.exit(1);
	}
	console.log("no invalid stock observed in this run");
	process.exit(0);
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}
