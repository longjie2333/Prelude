// f-003: product/pickup-point save performs no business validation: empty name and negative
// price are accepted and persisted.
// Basis: a product SKU and a pickup point must have a non-empty name; the product form defines
// price with min:0. Expected: HTTP 4xx (or form rejection) and no record created.
// Exit 1 if an invalid record is created. Self-cleaning: created records are deleted again.
const BASE = process.env.TARGET ?? "http://8.155.17.234:50080";

async function api(token, method, path, body) {
	const res = await fetch(`${BASE}/api${path}`, {
		method,
		headers: { ...(token ? { "X-Token": token } : {}), ...(body ? { "content-type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json; try { json = JSON.parse(text); } catch { json = text; }
	return { status: res.status, json };
}

const created = { products: [], points: [] };
let reproduced = false;

try {
	const login = await api(null, "POST", "/auth/login", { username: "admin", password: "<redacted>" });
	const token = login.json.data?.token;
	if (!token) { console.log("login failed, cannot prove problem"); process.exit(0); }
	const listProducts = async () => (await api(token, "GET", "/product/list")).json.data ?? [];
	const listPoints = async () => (await api(token, "GET", "/pickup-point/list")).json.data ?? [];

	// 1) product with empty name
	const tagA = `prelude-test-emptyname-${Date.now()}`;
	const beforeA = (await listProducts()).map((p) => p.id);
	const rA = await api(token, "POST", "/product/save", { name: "", category: "日用百货", spec: "1件", price: 1, unit: "份", supplier: tagA, status: 1 });
	const afterA = await listProducts();
	const newA = afterA.find((p) => !beforeA.includes(p.id));
	console.log(`POST /product/save name="" -> http=${rA.status} code=${rA.json?.code}; new record: ${newA ? `id=${newA.id} name=${JSON.stringify(newA.name)}` : "none"}`);
	if (newA) { created.products.push(newA.id); reproduced = true; }

	// 2) product with negative price
	const tagB = `prelude-test-negprice-${Date.now()}`;
	const beforeB = (await listProducts()).map((p) => p.id);
	const rB = await api(token, "POST", "/product/save", { name: tagB, category: "日用百货", spec: "1件", price: -5, unit: "份", supplier: "prelude-test", status: 1 });
	const newB = (await listProducts()).find((p) => !beforeB.includes(p.id));
	console.log(`POST /product/save price=-5 -> http=${rB.status} code=${rB.json?.code}; new record: ${newB ? `id=${newB.id} price=${newB.price}` : "none"}`);
	if (newB) { created.products.push(newB.id); reproduced = true; }

	// 3) pickup point with empty name
	const beforeC = (await listPoints()).map((p) => p.id);
	const rC = await api(token, "POST", "/pickup-point/save", { name: "", leaderName: "", phone: "", community: "", address: "", longitude: 999, latitude: 999, openTime: "", status: 1 });
	const newC = (await listPoints()).find((p) => !beforeC.includes(p.id));
	console.log(`POST /pickup-point/save name="" coords=999,999 -> http=${rC.status} code=${rC.json?.code}; new record: ${newC ? `id=${newC.id} name=${JSON.stringify(newC.name)} lon=${newC.longitude} lat=${newC.latitude}` : "none"}`);
	if (newC) { created.points.push(newC.id); reproduced = true; }
} catch (e) {
	console.log("could not run:", e.message);
	process.exit(0);
} finally {
	// cleanup everything created by this script
	try {
		const login = await api(null, "POST", "/auth/login", { username: "admin", password: "<redacted>" });
		const token = login.json?.data?.token;
		if (token) {
			for (const id of created.products) { await api(token, "DELETE", `/product/${id}`); console.log(`cleanup product ${id}`); }
			for (const id of created.points) { await api(token, "DELETE", `/pickup-point/${id}`); console.log(`cleanup point ${id}`); }
		}
	} catch (e) { console.log("cleanup error:", e.message); }
}

if (reproduced) {
	console.log("\nPROBLEM REPRODUCED: invalid product/pickup-point data was accepted and stored.");
	process.exit(1);
}
console.log("\nno invalid record created");
process.exit(0);