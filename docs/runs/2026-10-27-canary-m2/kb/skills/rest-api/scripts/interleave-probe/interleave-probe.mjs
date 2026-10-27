#!/usr/bin/env node
// interleave-probe.mjs — conservation probe for "reserve vs release" pairs.
//
// Detects lost updates between an operation that CONSUMES a counter (place order: -qty)
// and one that RELEASES it (cancel order: +qty). Both directions alone can be correct
// (each call guarded by a 409) while the pair still loses updates, because the two
// read-modify-write paths are not atomic with respect to each other.
//
// Invariant asserted at rest, for one resource with no other traffic:
//
//     counter + qty(sum of still-held/placed items) == initial counter
//
// Scenario per round:
//   1. POST /reset with the counter set to --initial (state is fully reset each round)
//   2. sequentially place --hold orders of --hold-qty so the counter reaches its floor
//   3. concurrently: cancel all those orders (+qty each) AND place --burst new orders
//      of --new-qty each (-qty each). Every sequential ordering of step 3 ends with
//      counter + placedQty == initial, so a correct server must end there too.
//   4. read the counter and the order list, assert conservation and counter >= 0.
//
// Exit 1 = violation observed (reproduced). Exit 0 = no violation, or "could not run"
// (unreachable target, failed reset, failed setup, unreadable counter) — environment
// problems are never reported as a repro.
//
// Usage:
//   MSYS_NO_PATHCONV=1 node interleave-probe.mjs \
//     --base http://localhost:4100 --counter /products/p1 --field stock \
//     --product p1 --orders /orders --reset /reset \
//     --initial 5 --hold-qty 1 --new-qty 1 --burst 5 --rounds 5
//
// See README.md for every option and the known failure modes.

const args = {};
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (!a.startsWith("--")) continue;
	const key = a.slice(2);
	const next = process.argv[i + 1];
	if (next === undefined || next.startsWith("--")) args[key] = true;
	else {
		args[key] = next;
		i++;
	}
}

const cfg = {
	base: (args.base ?? process.env.TARGET ?? "http://localhost:4100").replace(/\/$/, ""),
	counter: args.counter ?? "/products/p1",
	field: args.field ?? "stock",
	product: args.product ?? "p1",
	orders: args.orders ?? "/orders",
	qtyField: args["qty-field"] ?? "qty",
	placedStatus: args["placed-status"] ?? "placed",
	reset: args.reset ?? "/reset",
	initial: Number(args.initial ?? 5),
	holdQty: Number(args["hold-qty"] ?? 1),
	newQty: Number(args["new-qty"] ?? 1),
	burst: Number(args.burst ?? 5),
	rounds: Number(args.rounds ?? 5),
	ok: Number(args["expect-success"] ?? 201),
	cancelOk: Number(args["expect-cancel"] ?? 200),
	reject: Number(args["expect-reject"] ?? 409),
	quiet: Boolean(args.quiet),
};

const log = (...m) => {
	if (!cfg.quiet) console.log(...m);
};

const call = async (path, init) => {
	const res = await fetch(cfg.base + path, init);
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body };
};
const post = (path, raw) =>
	call(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: raw === undefined ? "{}" : raw,
	});
const counter = async () => {
	const r = await call(cfg.counter);
	return { status: r.status, value: r.body?.[cfg.field], body: r.body };
};
const heldQty = async () => {
	const r = await call(cfg.orders);
	const items = r.body?.items;
	if (!Array.isArray(items)) return { ok: false, status: r.status, body: r.body };
	const qty = items
		.filter((o) => o.status === cfg.placedStatus)
		.reduce((sum, o) => sum + (Number(o[cfg.qtyField]) || 0), 0);
	return { ok: true, qty, count: items.length };
};

let violated = false;
try {
	log(
		`interleave-probe: ${cfg.base} counter=${cfg.counter}.${cfg.field} initial=${cfg.initial} ` +
			`hold=${cfg.burst}x${cfg.holdQty} release+cancel vs place ${cfg.burst}x${cfg.newQty}, ${cfg.rounds} round(s)`,
	);
	log(`invariant: ${cfg.field} + ${cfg.placedStatus}Qty must equal ${cfg.initial} at rest`);

	for (let round = 1; round <= cfg.rounds; round++) {
		const reset = await post(cfg.reset, JSON.stringify({ stock: { [cfg.product]: cfg.initial } }));
		if (reset.status >= 400) {
			console.log(`reset failed: ${reset.status} ${JSON.stringify(reset.body)} — cannot prepare state, not a repro`);
			process.exit(0);
		}

		const before = await counter();
		if (typeof before.value !== "number") {
			console.log(`cannot read ${cfg.field} from GET ${cfg.counter}: ${before.status} ${JSON.stringify(before.body)} — not a repro`);
			process.exit(0);
		}
		const start = before.value;

		// step 2: reserve everything sequentially
		const ids = [];
		for (let i = 0; i < cfg.burst; i++) {
			const r = await post(cfg.orders, JSON.stringify({ productId: cfg.product, qty: cfg.holdQty }));
			if (r.status !== cfg.ok) {
				console.log(`setup order ${i + 1}/${cfg.burst} failed: ${r.status} ${JSON.stringify(r.body)} — not a repro`);
				process.exit(0);
			}
			ids.push(r.body?.id);
		}
		const afterHold = await counter();
		if (afterHold.value !== start - cfg.burst * cfg.holdQty) {
			console.log(
				`unexpected counter after setup orders: ${afterHold.value}, expected ${start - cfg.burst * cfg.holdQty} — not a repro`,
			);
			process.exit(0);
		}

		// step 3: releases (+qty) race new reservations (-qty)
		const results = await Promise.all([
			...ids.map((id) => post(`${cfg.orders}/${id}/cancel`)),
			...Array.from({ length: cfg.burst }, () =>
				post(cfg.orders, JSON.stringify({ productId: cfg.product, qty: cfg.newQty })),
			),
		]);
		const cancelStatuses = results.slice(0, ids.length).map((r) => r.status);
		const orderStatuses = results.slice(ids.length).map((r) => r.status);

		// step 4: read quiescent state
		const after = await counter();
		const held = await heldQty();
		if (!held.ok) {
			console.log(`cannot read order list ${cfg.orders}: ${held.status} ${JSON.stringify(held.body)} — not a repro`);
			process.exit(0);
		}
		const final = after.value;
		const conserved = typeof final === "number" ? final + held.qty : NaN;

		log(
			`round ${round}: start=${start} cancels=${cancelStatuses.join("/")} newOrders=${orderStatuses.join("/")} | ` +
				`final=${final} ${cfg.placedStatus}Qty=${held.qty} sum=${conserved} (expected ${cfg.initial})`,
		);

		const unexpected = [...cancelStatuses, ...orderStatuses].filter(
			(s) => s !== cfg.ok && s !== cfg.cancelOk && s !== cfg.reject,
		);
		if (unexpected.length) {
			console.log(`  UNEXPECTED STATUS: ${unexpected.join(",")} — expected ${cfg.cancelOk}/${cfg.ok}/${cfg.reject}`);
			violated = true;
		}
		if (conserved !== cfg.initial) {
			console.log(
				`  LOST UPDATE: ${cfg.field}(${final}) + ${cfg.placedStatus}Qty(${held.qty}) = ${conserved}, ` +
					`expected ${cfg.initial} (${conserved - cfg.initial} unit(s) unaccounted)`,
			);
			violated = true;
		}
		if (typeof final === "number" && final < 0) {
			console.log(`  NEGATIVE COUNTER: ${cfg.field}=${final}`);
			violated = true;
		}
	}

	console.log(violated ? "VERDICT: lost update between release and consume reproduced" : "VERDICT: no violation observed");
	process.exit(violated ? 1 : 0);
} catch (err) {
	console.log("could not run:", err?.message ?? err);
	process.exit(0);
}
