#!/usr/bin/env node
// selfcheck for interleave-probe.mjs.
//
// Spins up two local fixture servers with the same HTTP shape as a real inventory API:
//   - "atomic": cancel and order both go through one mutex -> conservation always holds
//   - "racy":   cancel and order each do a non-atomic read-modify-write -> updates are lost
// Asserts the probe exits 0 against "atomic", 1 against "racy", and 0 against an
// unreachable port (must not report a repro when it cannot run).
//
// Exit 0 = the tool behaves correctly.

import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "interleave-probe.mjs");

const makeServer = (mode) => {
	let stock = 0;
	const orders = new Map();
	let nextId = 1;
	let lock = Promise.resolve();
	// serialize in "atomic" mode: every mutation runs inside this queue
	const serial = (fn) =>
		mode === "atomic" ? (lock = lock.then(fn, fn)) : fn();
	const slowRead = async (read, write) => {
		const v = read();
		await new Promise((r) => setTimeout(r, 5)); // widen the race window
		write(v);
	};

	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", async () => {
			const send = (code, obj) => {
				res.writeHead(code, { "content-type": "application/json" });
				res.end(JSON.stringify(obj));
			};
			const json = () => {
				try {
					return JSON.parse(body || "{}");
				} catch {
					return {};
				}
			};
			if (url.pathname === "/reset" && req.method === "POST") {
				await serial(async () => {
					stock = Number(json().stock?.p1 ?? 0);
					orders.clear();
					nextId = 1;
				});
				return send(200, { ok: true });
			}
			if (url.pathname === "/products/p1" && req.method === "GET") return send(200, { id: "p1", stock });
			if (url.pathname === "/orders" && req.method === "GET")
				return send(200, { items: [...orders.values()].map((o) => ({ ...o })) });
			if (url.pathname === "/orders" && req.method === "POST") {
				const qty = Number(json().qty ?? 1);
				let code = 201;
				let payload;
				await serial(async () => {
					if (stock < qty) {
						code = 409;
						payload = { error: "insufficient stock" };
						return;
					}
					await slowRead(
						() => stock,
						(v) => (stock = v - qty),
					);
					const id = `o${nextId++}`;
					orders.set(id, { id, qty, status: "placed" });
					payload = orders.get(id);
				});
				return send(code, payload);
			}
			const m = url.pathname.match(/^\/orders\/([^/]+)\/cancel$/);
			if (m && req.method === "POST") {
				const id = m[1];
				let code = 200;
				let payload;
				await serial(async () => {
					const o = orders.get(id);
					if (!o) {
						code = 404;
						payload = { error: "order not found" };
						return;
					}
					if (o.status === "cancelled") {
						code = 409;
						payload = { error: "already cancelled" };
						return;
					}
					o.status = "cancelled";
					await slowRead(
						() => stock,
						(v) => (stock = v + o.qty),
					);
					payload = { ...o };
				});
				return send(code, payload);
			}
			send(404, { error: "not found" });
		});
	});
	return server;
};

const listen = (server) =>
	new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const run = (base) =>
	new Promise((resolve) => {
		const p = spawn(process.execPath, [probe, "--base", base, "--quiet", "--rounds", "3"], {
			cwd: here,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (out += d));
		p.on("close", (code) => resolve({ code, out }));
	});

let failures = 0;
const check = (name, cond, extra) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failures++;
};

const atomic = makeServer("atomic");
const racy = makeServer("racy");
const pa = await listen(atomic);
const pr = await listen(racy);
try {
	const good = await run(`http://127.0.0.1:${pa}`);
	check("exit 0 against an atomic server", good.code === 0, `exit=${good.code} ${good.out.trim().split("\n").pop()}`);

	const bad = await run(`http://127.0.0.1:${pr}`);
	check("exit 1 against a non-atomic server", bad.code === 1, `exit=${bad.code} ${bad.out.trim().split("\n").pop()}`);

	const dead = await run("http://127.0.0.1:1");
	check("exit 0 when the target is unreachable", dead.code === 0, `exit=${dead.code}`);
} finally {
	atomic.close();
	racy.close();
}

console.log(failures === 0 ? "selfcheck OK" : `selfcheck FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
