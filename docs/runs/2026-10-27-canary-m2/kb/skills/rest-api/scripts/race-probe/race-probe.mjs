#!/usr/bin/env node
// race-probe.mjs — generic concurrent "check-then-decrement counter" probe.
//
// Purpose: find lost-update / oversell bugs on any HTTP API that exposes a counter
// (stock, quota, balance, seats) and an operation that decrements it by a quantity.
//
// It fires N concurrent identical operations, then checks two invariants:
//   1) successes * qty <= initial counter value   (never promise more than exists)
//   2) initial - final === successes * qty        (each success decrements exactly qty)
//
// Exit code: 1 when a violation is observed (problem reproduced), 0 otherwise
// (including "could not run", so environment problems are never mistaken for a repro).
//
// Usage:
//   node race-probe.mjs --base http://localhost:4100 \
//     --counter /products/p1 --field stock \
//     --op /orders --body '{"productId":"p1","qty":1}' --qty 1 \
//     --reset /reset --reset-body '{"stock":{"p1":2}}' \
//     --conc 10 --rounds 3
//
// All options:
//   --base URL            target origin (default http://localhost:4100)
//   --counter PATH        GET path returning the counter, e.g. /products/p1
//   --field NAME          JSON field holding the counter (default: stock)
//   --op PATH             POST path of the decrementing operation
//   --body JSON           request body for the operation
//   --qty N               units consumed per successful operation (default 1)
//   --reset PATH          POST path that resets state (optional; called before each round)
//   --reset-body JSON     body for the reset call (default {})
//   --conc N              concurrent operations per round (default 10)
//   --rounds N            rounds to run; any violation reproduces (default 3)
//   --expect-success CODE success status code (default 201)
//   --expect-reject CODE  rejection status code for insufficient stock (default 409)
//   --quiet               only print the final verdict
//
// Known limits: assumes a single counter field and a single operation type; does not
// model multi-resource transactions. For interleaved operations (e.g. cancel + order)
// write a dedicated probe instead.

const args = {};
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (!a.startsWith("--")) continue;
	const key = a.slice(2);
	const next = process.argv[i + 1];
	if (next === undefined || next.startsWith("--")) args[key] = true;
	else { args[key] = next; i++; }
}

const cfg = {
	base: (args.base ?? process.env.TARGET ?? "http://localhost:4100").replace(/\/$/, ""),
	counter: args.counter ?? "/products/p1",
	field: args.field ?? "stock",
	op: args.op ?? "/orders",
	body: args.body ?? '{"productId":"p1","qty":1}',
	qty: Number(args.qty ?? 1),
	reset: args.reset ?? "/reset",
	resetBody: args["reset-body"] ?? "{}",
	conc: Number(args.conc ?? 10),
	rounds: Number(args.rounds ?? 3),
	ok: Number(args["expect-success"] ?? 201),
	reject: Number(args["expect-reject"] ?? 409),
	quiet: Boolean(args.quiet),
};

const log = (...m) => { if (!cfg.quiet) console.log(...m); };

const call = async (path, init) => {
	const r = await fetch(cfg.base + path, init);
	const text = await r.text();
	let body;
	try { body = JSON.parse(text); } catch { body = text; }
	return { status: r.status, body };
};
const post = (path, raw) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
const counter = async () => {
	const r = await call(cfg.counter);
	const v = r.body?.[cfg.field];
	return { status: r.status, value: v, body: r.body };
};

let violated = false;
try {
	log(`race-probe: ${cfg.conc} concurrent POST ${cfg.op} qty=${cfg.qty}, ${cfg.rounds} round(s) against ${cfg.base}`);

	for (let round = 1; round <= cfg.rounds; round++) {
		if (cfg.reset && cfg.reset !== "none") {
			const r = await post(cfg.reset, cfg.resetBody);
			if (r.status >= 400) { console.log(`reset failed: ${r.status} ${JSON.stringify(r.body)} — cannot prepare state, not a repro`); process.exit(0); }
		}
		const before = await counter();
		if (typeof before.value !== "number") {
			console.log(`cannot read counter ${cfg.field} from GET ${cfg.counter}: ${before.status} ${JSON.stringify(before.body)} — not a repro`);
			process.exit(0);
		}
		const initial = before.value;

		const results = await Promise.all(Array.from({ length: cfg.conc }, () => post(cfg.op, cfg.body)));
		const ok = results.filter((r) => r.status === cfg.ok);
		const rejected = results.filter((r) => r.status === cfg.reject);
		const other = results.filter((r) => r.status !== cfg.ok && r.status !== cfg.reject);
		const after = await counter();
		const final = after.value;
		const accepted = ok.length * cfg.qty;
		const delta = initial - final;

		log(`round ${round}: initial=${initial} concurrent=${cfg.conc} qty=${cfg.qty} -> ok:${ok.length} rejected:${rejected.length} other:${other.length} | final=${final} acceptedQty=${accepted} delta=${delta}`);
		if (other.length) log(`  unexpected statuses: ${other.map((r) => `${r.status}:${JSON.stringify(r.body)}`).join(" | ")}`);

		if (accepted > initial) {
			console.log(`  OVERSELL: ${ok.length} successes accepted ${accepted} units but only ${initial} existed`);
			violated = true;
		}
		if (delta !== accepted) {
			console.log(`  LOST UPDATE: counter moved by ${delta} but ${accepted} units were promised (${Math.abs(accepted - delta)} units unaccounted)`);
			violated = true;
		}
		if (typeof final === "number" && final < 0) {
			console.log(`  NEGATIVE COUNTER: ${cfg.field}=${final}`);
			violated = true;
		}
	}

	console.log(violated ? "VERDICT: violation reproduced" : "VERDICT: no violation observed");
	process.exit(violated ? 1 : 0);
} catch (err) {
	console.log("could not run:", err?.message ?? err);
	process.exit(0);
}
