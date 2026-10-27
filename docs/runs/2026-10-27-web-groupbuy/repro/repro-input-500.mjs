// f-002: missing/invalid request parameters crash the API with HTTP 500 instead of 4xx.
// Basis: invalid enum/number/body input is a client error and must be rejected with 400.
// Cases: statuses=abc, limit=-1, product/save {}, pickup-point/save {}.
// Exit 1 if any returns a 5xx. Read-only except the two save calls with empty bodies (which
// currently fail server-side and therefore create nothing).
const BASE = process.env.TARGET ?? "http://8.155.17.234:50080";

async function api(token, method, path, body) {
	const res = await fetch(`${BASE}/api${path}`, {
		method,
		headers: { ...(token ? { "X-Token": token } : {}), ...(body ? { "content-type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, text: await res.text() };
}

try {
	const login = await api(null, "POST", "/auth/login", { username: "admin", password: "<redacted>" });
	const token = JSON.parse(login.text).data?.token;
	if (!token) { console.log("login failed, cannot prove problem"); process.exit(0); }

	const cases = [
		["GET", "/order/aggregate/by-point?statuses=abc", null],
		["GET", "/order/aggregate/by-product?statuses=abc", null],
		["GET", "/order/stat/point-ranking?limit=-1", null],
		["GET", "/order/stat/product-ranking?limit=-1", null],
		["POST", "/product/save", {}],
		["POST", "/pickup-point/save", {}],
	];
	const bad = [];
	for (const [m, p, b] of cases) {
		const r = await api(token, m, p, b);
		const flag = r.status >= 500 ? "  <== 5xx" : "";
		console.log(`${m} ${p} -> http=${r.status}${flag} ${r.text.slice(0, 110)}`);
		if (r.status >= 500) bad.push(`${m} ${p} -> ${r.status}`);
	}

	if (bad.length) {
		console.log("\nPROBLEM REPRODUCED: invalid/missing input returns HTTP 5xx (expected 4xx):");
		for (const b of bad) console.log("  - " + b);
		process.exit(1);
	}
	console.log("\nno 5xx observed");
	process.exit(0);
} catch (e) {
	console.log("could not run:", e.message);
	process.exit(0);
}