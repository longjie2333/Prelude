// 复现：POST /coupons/{code}/claim 并发超领
// 依据：openapi.json 中 POST /coupons/{code}/claim "Claim one use of a coupon.
//       remaining never goes below zero." + GET /coupons/{code} 返回 quota。
// 不变量：成功领取数 <= quota，remaining >= 0，remaining = quota - 成功数。
// 退出码：观察到超领 -> 1；未观察到 -> 0（含环境不可用）。
const base = process.env.TARGET ?? "http://localhost:4100";
const CODE = "SAVE10";
const CONCURRENCY = 20;
const ROUNDS = 5;

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

async function claim() {
	const r = await fetch(`${base}/coupons/${CODE}/claim`, { method: "POST" });
	let body;
	try {
		body = await r.json();
	} catch {
		body = null;
	}
	return { status: r.status, body };
}

let overclaimed = false;
try {
	for (let round = 1; round <= ROUNDS; round++) {
		const reset = await fetch(`${base}/reset`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		if (!reset.ok) throw new Error(`reset failed ${reset.status}`);

		const before = (await get(`/coupons/${CODE}`)).body;
		const quota = before.quota;

		const results = await Promise.all(
			Array.from({ length: CONCURRENCY }, () => claim()),
		);
		const ok = results.filter((r) => r.status === 201);
		const exhausted = results.filter((r) => r.status === 409);
		const other = results.filter((r) => r.status !== 201 && r.status !== 409);

		const after = (await get(`/coupons/${CODE}`)).body;
		const bad =
			ok.length > quota ||
			after.remaining < 0 ||
			after.remaining !== quota - ok.length;

		console.log(
			`round ${round}: quota=${quota} concurrent=${CONCURRENCY} -> 201=${ok.length} 409=${exhausted.length} other=${other.length} ` +
				`remaining=${after.remaining} expected=${quota - ok.length} ${bad ? "*** OVERCLAIM ***" : "ok"}`,
		);
		if (other.length) console.log("  unexpected statuses:", JSON.stringify(other.slice(0, 3)));
		if (bad) overclaimed = true;
	}
} catch (err) {
	console.log("could not run:", err);
	process.exit(0);
}

console.log(overclaimed ? "RESULT: overclaim observed" : "RESULT: no overclaim observed");
process.exit(overclaimed ? 1 : 0);