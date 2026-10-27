// f-007: the wave-packing plan ignores the configured capacity for single pickup points.
// The UI ("波次容量(件)") promises greedy bin packing; the tooltip says a new wave is opened when
// capacity is exceeded. But when one pickup point already holds more items than the capacity, the
// point is placed in a wave larger than the capacity without any warning or splitting.
// Expected: every wave's totalItems <= capacity, or the UI warns that the point cannot be split.
// Exit 1 if a wave exceeds the requested capacity.
const BASE = process.env.TARGET ?? "http://8.155.17.234:50080";

async function api(token, method, path) {
	const res = await fetch(`${BASE}/api${path}`, { method, headers: token ? { "X-Token": token } : {} });
	const t = await res.text(); try { return { status: res.status, json: JSON.parse(t) }; } catch { return { status: res.status, json: t }; }
}

let reproduced = false;
try {
	const login = await api(null, "POST", "/auth/login");
	const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "<redacted>" }) });
	const token = (await res.json()).data?.token;
	if (!token) { console.log("login failed, cannot prove problem"); process.exit(0); }

	const cap = 50;
	const r = await api(token, "GET", `/order/aggregate/waves?capacity=${cap}`);
	const waves = r.json.data ?? [];
	const over = waves.filter((w) => Number(w.totalItems || 0) > cap);
	for (const w of waves) console.log(`wave ${w.wave}: items=${w.totalItems} orders=${w.orderCount} points=${w.pointCount} (capacity=${cap})`);
	if (over.length) {
		console.log(`\nPROBLEM REPRODUCED: ${over.length}/${waves.length} waves exceed capacity=${cap}: ${over.map((w) => `${w.wave}:${w.totalItems}`).join(", ")}`);
		reproduced = true;
	}
} catch (e) {
	console.log("could not run:", e.message);
}
process.exit(reproduced ? 1 : 0);