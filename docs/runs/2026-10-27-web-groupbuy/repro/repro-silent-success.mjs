// f-006: mutation endpoints silently "succeed" for nonexistent ids and out-of-range status values.
// Expected: updating a missing order/sorting task/delivery should return a 4xx/not-found business
// error (code!=200), and a status outside the enum should be rejected.
// This script only targets ids that do not exist (999999), so no real business data is touched.
// Exit 1 if such calls report success.
const BASE = process.env.TARGET ?? "http://8.155.17.234:50080";

async function api(token, method, path, body) {
	const res = await fetch(`${BASE}/api${path}`, {
		method,
		headers: { ...(token ? { "X-Token": token } : {}), ...(body ? { "content-type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const t = await res.text(); try { return { http: res.status, json: JSON.parse(t) }; } catch { return { http: res.status, json: t }; }
}

let reproduced = false;
try {
	const token = (await api(null, "POST", "/auth/login", { username: "admin", password: "<redacted>" })).json.data?.token;
	if (!token) { console.log("login failed, cannot prove problem"); process.exit(0); }

	const cases = [
		["POST", "/order/999999/status?status=2"],
		["POST", "/order/999999/status?status=99"],
		["POST", "/dispatch/sorting/999999/status?status=2"],
		["POST", "/dispatch/sorting/999999/status?status=99&sorterName=prelude-test"],
		["POST", "/dispatch/delivery/999999/status?status=2"],
		["POST", "/dispatch/delivery/999999/status?status=99"],
	];
	for (const [m, p] of cases) {
		const r = await api(token, m, p);
		const ok = r.json?.code === 200;
		console.log(`${m} ${p} -> http=${r.http} code=${r.json?.code} ${ok ? "<== reported success" : ""}`);
		if (ok) reproduced = true;
	}
	if (reproduced) {
		console.log("\nPROBLEM REPRODUCED: nonexistent id / out-of-range status is accepted as success.");
		process.exit(1);
	}
} catch (e) {
	console.log("could not run:", e.message);
	process.exit(0);
}
console.log("\nno silent success observed");
process.exit(0);