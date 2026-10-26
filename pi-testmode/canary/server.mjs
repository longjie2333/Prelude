// Canary SUT for pi-testmode (plan M1-12): an inventory/order service with switchable bugs.
// Zero dependencies. Ground truth lives in bugs.json; agents under evaluation should not read it.
//
//   BUGS=B1,B2,B3 (default) | none      CONSISTENCY=sync (default) | eventual      PORT=4100
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COUPONS = [
	{ code: "SAVE10", quota: 5, remaining: 5 },
	{ code: "VIP", quota: 2, remaining: 2 },
];

const SEED = [
	{ id: "p1", name: "Widget", price: 9.5, stock: 10 },
	{ id: "p2", name: "Gadget", price: 19, stock: 5 },
	{ id: "p3", name: "Doohickey", price: 4.25, stock: 100 },
	{ id: "p4", name: "Sprocket", price: 1.1, stock: 25 },
	{ id: "p5", name: "Gizmo", price: 42, stock: 3 },
	{ id: "p6", name: "Thingamajig", price: 7, stock: 12 },
	{ id: "p7", name: "Whatsit", price: 3.3, stock: 40 },
];

export function parseBugs(value) {
	if (value === undefined || value === "") return new Set(["B1", "B2", "B3"]);
	if (value.trim().toLowerCase() === "none") return new Set();
	return new Set(
		value
			.split(",")
			.map((s) => s.trim().toUpperCase())
			.filter(Boolean),
	);
}

export function createCanary(options = {}) {
	let bugs = options.bugs ?? parseBugs(process.env.BUGS);
	let consistency = options.consistency ?? process.env.CONSISTENCY ?? "sync";
	let eventual = consistency === "eventual";
	const settleMs = () => 1000 + Math.floor(Math.random() * 1000);

	let products;
	let coupons;
	let orders;
	let reserved; // eventual mode: committed decisions, applied to `stock` later
	let seq;
	const timers = new Set();

	function reset(body = {}) {
		for (const t of timers) clearTimeout(t);
		timers.clear();
		products = new Map(SEED.map((p) => [p.id, { ...p }]));
		if (body.stock && typeof body.stock === "object") {
			for (const [id, s] of Object.entries(body.stock)) if (products.has(id)) products.get(id).stock = Number(s);
		}
		orders = new Map();
		coupons = new Map(COUPONS.map((c) => [c.code, { ...c }]));
		reserved = new Map([...products.values()].map((p) => [p.id, p.stock]));
		seq = 0;
	}
	reset();

	function later(fn) {
		const t = setTimeout(() => {
			timers.delete(t);
			fn();
		}, settleMs());
		timers.add(t);
	}

	async function placeOrder(productId, qty) {
		const p = products.get(productId);
		if (!p) return [404, { error: "product not found" }];
		if (!Number.isInteger(qty) || qty < 1) return [400, { error: "qty must be a positive integer" }];
		if (eventual) {
			// Decisions are made on `reserved` (correct); `stock` catches up after 1-2s.
			const avail = reserved.get(productId);
			if (avail < qty) return [409, { error: "insufficient stock" }];
			reserved.set(productId, avail - qty);
			later(() => (p.stock -= qty));
		} else if (bugs.has("B1")) {
			// B1: read-modify-write without a lock; concurrent orders oversell.
			const seen = p.stock;
			await sleep(5 + Math.floor(Math.random() * 15));
			if (seen < qty) return [409, { error: "insufficient stock" }];
			p.stock = seen - qty;
		} else {
			if (p.stock < qty) return [409, { error: "insufficient stock" }];
			p.stock -= qty;
		}
		const order = { id: `o${++seq}`, productId, qty, status: "placed" };
		orders.set(order.id, order);
		return [201, order];
	}

	// Coupon quota: the same read-modify-write shape as stock (B1 applies to both resources).
	async function claimCoupon(code) {
		const c = coupons.get(code);
		if (!c) return [404, { error: "coupon not found" }];
		if (bugs.has("B1") && !eventual) {
			const seen = c.remaining;
			await sleep(5 + Math.floor(Math.random() * 15));
			if (seen < 1) return [409, { error: "quota exhausted" }];
			c.remaining = seen - 1;
		} else {
			if (c.remaining < 1) return [409, { error: "quota exhausted" }];
			c.remaining -= 1;
		}
		return [201, { code, remaining: c.remaining }];
	}

	function cancelOrder(id) {
		const o = orders.get(id);
		if (!o) return [404, { error: "order not found" }];
		if (o.status === "cancelled") return [409, { error: "already cancelled" }];
		o.status = "cancelled";
		const p = products.get(o.productId);
		if (eventual) {
			reserved.set(o.productId, reserved.get(o.productId) + o.qty);
			later(() => (p.stock += o.qty));
			// B4: the compensation is enqueued twice; the drift only shows after settling.
			if (bugs.has("B4")) later(() => (p.stock += o.qty));
		} else {
			p.stock += o.qty;
		}
		return [200, o];
	}

	function listProducts(url) {
		const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
		const size = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("size") ?? "3", 10) || 3));
		const all = [...products.values()];
		const total = all.length;
		const pages = Math.max(1, Math.ceil(total / size));
		const start = (page - 1) * size;
		let end = Math.min(start + size, total);
		// B2: the last page is one item short.
		if (bugs.has("B2") && page === pages && end - start > 0) end -= 1;
		return { items: all.slice(start, end), page, size, total, pages };
	}

	function createProduct(body) {
		const name = body?.name;
		if (typeof name !== "string" || !name.trim()) return [400, { error: "name required" }];
		// B3: names with emoji crash the "slug" step.
		if (bugs.has("B3") && /\p{Extended_Pictographic}/u.test(name))
			throw new Error("slugify: unexpected surrogate pair");
		const id = `p${products.size + 1}`;
		const p = { id, name, price: Number(body.price ?? 0), stock: Number(body.stock ?? 0) };
		products.set(id, p);
		reserved.set(id, p.stock);
		return [201, p];
	}

	async function route(req, url, body) {
		const parts = url.pathname.split("/").filter(Boolean);
		const m = req.method;
		if (m === "GET" && url.pathname === "/health") return [200, { ok: true }];
		if (m === "GET" && url.pathname === "/openapi.json")
			return [200, JSON.parse(readFileSync(join(HERE, "openapi.json"), "utf8"))];
		if (m === "POST" && url.pathname === "/reset") {
			reset(body ?? {});
			return [200, { ok: true }];
		}
		if (parts[0] === "products") {
			if (m === "GET" && parts.length === 1) return [200, listProducts(url)];
			if (m === "POST" && parts.length === 1) return createProduct(body);
			if (m === "GET" && parts.length === 2) {
				const p = products.get(parts[1]);
				return p ? [200, p] : [404, { error: "product not found" }];
			}
		}
		if (parts[0] === "coupons" && parts.length >= 2) {
			const c = coupons.get(parts[1]);
			if (m === "GET" && parts.length === 2) return c ? [200, c] : [404, { error: "coupon not found" }];
			if (m === "POST" && parts.length === 3 && parts[2] === "claim") return claimCoupon(parts[1]);
		}
		if (parts[0] === "orders") {
			if (m === "GET" && parts.length === 1) return [200, { items: [...orders.values()] }];
			if (m === "POST" && parts.length === 1) return placeOrder(body?.productId, body?.qty);
			if (m === "POST" && parts.length === 3 && parts[2] === "cancel") return cancelOrder(parts[1]);
		}
		return [404, { error: "not found" }];
	}

	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", async () => {
			const send = (status, payload) => {
				res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-consistency": consistency });
				res.end(JSON.stringify(payload));
			};
			try {
				const url = new URL(req.url ?? "/", "http://canary.local");
				let body;
				if (raw) {
					try {
						body = JSON.parse(raw);
					} catch {
						return send(400, { error: "invalid JSON" });
					}
				}
				const [status, payload] = await route(req, url, body);
				send(status, payload);
			} catch (err) {
				send(500, { error: "internal error", detail: String(err?.message ?? err) });
			}
		});
	});
	server.on("close", () => {
		for (const t of timers) clearTimeout(t);
	});
	/** Test hook: switch bugs/consistency on a running server (same URL, state reset). */
	server.setMode = (mode) => {
		if (mode.bugs) bugs = mode.bugs;
		if (mode.consistency) {
			consistency = mode.consistency;
			eventual = consistency === "eventual";
		}
		reset();
	};
	return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const port = Number(process.env.PORT ?? 4100);
	const server = createCanary();
	server.listen(port, "127.0.0.1", () => {
		const bugs = [...parseBugs(process.env.BUGS)].join(",") || "none";
		console.log(
			`canary listening on http://localhost:${port} (bugs: ${bugs}, consistency: ${process.env.CONSISTENCY ?? "sync"})`,
		);
	});
}
