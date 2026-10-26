// 复现：POST /coupons/{code}/claim 在并发下超发（领到的次数远超 quota）
// 依据：openapi.json 中 POST /coupons/{code}/claim "Claim one use of a coupon. remaining never goes below zero."
//       409 Quota exhausted；GET /coupons 返回 {quota:5, remaining:5}，故最多只能有 5 次 201。
// 退出码：观察到超发 -> 1；未观察到 -> 0。
const base = process.env.TARGET ?? "http://localhost:4100";
const CODE = "SAVE10";

const post = async (path) => {
	const r = await fetch(base + path, { method: "POST" });
	let json = null;
	try { json = await r.json(); } catch { /* ignore */ }
	return { status: r.status, json };
};
const getJson = async (path) => {
	const r = await fetch(base + path);
	return { status: r.status, json: await r.json().catch(() => null) };
};

try {
	const health = await fetch(base + "/health").catch(() => null);
	if (!health || !health.ok) {
		console.log(`target ${base} not reachable; cannot prove the problem`);
		process.exit(0);
	}
	const reset = await fetch(base + "/reset", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	}).catch(() => null);
	if (!reset || !reset.ok) {
		console.log("reset failed; cannot prepare state");
		process.exit(0);
	}

	const before = await getJson(`/coupons/${CODE}`);
	if (before.status !== 200 || !before.json) {
		console.log("coupon not readable; cannot prove the problem");
		process.exit(0);
	}
	const quota = before.json.quota;
	const remaining = before.json.remaining;
	console.log(`setup: ${CODE} quota=${quota} remaining=${remaining}`);

	const N = 20;
	const claims = await Promise.all(
		Array.from({ length: N }, () => post(`/coupons/${CODE}/claim`).catch((e) => ({ status: "ERR", json: { error: String(e) } }))),
	);
	const counts = {};
	for (const c of claims) counts[c.status] = (counts[c.status] ?? 0) + 1;
	const granted = claims.filter((c) => c.status === 201).length;
	console.log(`concurrent POST /coupons/${CODE}/claim x${N} -> statuses ${JSON.stringify(counts)}`);
	console.log(`granted claims (201): ${granted}, allowed at most ${remaining} (remaining before burst)`);

	const after = await getJson(`/coupons/${CODE}`);
	console.log(`after: quota=${after.json?.quota} remaining=${after.json?.remaining}`);

	if (granted > remaining) {
		console.log(`DEFECT: granted ${granted} claims while only ${remaining} uses were available (over-granted ${granted - remaining})`);
		process.exit(1);
	}
	console.log("no over-grant observed in this run");
	process.exit(0);
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}
