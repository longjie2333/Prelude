#!/usr/bin/env node
// selfcheck.mjs — exit 0 = the tool works.
// Uses a throwaway local HTTP server with two modes:
//   correct mode: atomic check-then-decrement -> probe must exit 0
//   buggy mode:   non-atomic read-modify-write -> probe must exit 1
// Both modes are required, so a probe that always exits 0 or always exits 1 fails.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const probe = join(here, "race-probe.mjs");

const makeServer = (buggy) => {
	let stock = 0;
	const orders = [];
	let seq = 0;
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", async () => {
			const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
			if (req.url === "/reset") { stock = 5; return send(200, { ok: true }); }
			if (req.url === "/products/p1") return send(200, { id: "p1", stock });
			if (req.url === "/orders" && req.method === "POST") {
				const qty = JSON.parse(raw).qty;
				const seen = stock;                       // the read
				if (buggy) await new Promise((r) => setTimeout(r, 5));  // widen the race window
				if (seen < qty) return send(409, { error: "insufficient stock" });
				stock = seen - qty;                       // the write (last one wins when buggy)
				return send(201, { id: `o${++seq}`, qty, status: "placed" });
			}
			send(404, { error: "not found" });
		});
	});
	return server;
};

// NOTE: must be async. spawnSync would block this process's event loop, so the local
// fixture server could never answer the child probe's requests (deadlock).
const run = (port) =>
	new Promise((resolve) => {
		const child = spawn(process.execPath, [probe, "--base", `http://127.0.0.1:${port}`, "--counter", "/products/p1", "--field", "stock", "--op", "/orders", "--body", '{"productId":"p1","qty":1}', "--qty", "1", "--reset", "/reset", "--conc", "10", "--rounds", "2", "--quiet"], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
		child.on("close", (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
	});

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(r));

let failed = 0;
try {
	// 1) correct implementation must NOT be reported as a violation
	const good = makeServer(false);
	const gp = await listen(good);
	const g = await run(gp);
	await close(good);
	console.log(`correct impl  -> exit ${g.status} (want 0)\n${(g.stdout ?? "").trim()}`);
	if (g.status !== 0) failed++;

	// 2) buggy implementation must be reported
	const bad = makeServer(true);
	const bp = await listen(bad);
	const b = await run(bp);
	await close(bad);
	console.log(`buggy impl    -> exit ${b.status} (want 1)\n${(b.stdout ?? "").trim()}`);
	if (b.status !== 1) failed++;

	// 3) unreachable target must exit 0, not look like a repro
	const dead = await run(1);
	console.log(`unreachable   -> exit ${dead.status} (want 0)`);
	if (dead.status !== 0) failed++;
} catch (err) {
	console.log("selfcheck error:", err);
	failed++;
}

console.log(failed ? `SELFCHECK FAILED (${failed})` : "SELFCHECK OK");
process.exit(failed ? 1 : 0);
