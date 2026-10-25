import { afterEach, describe, expect, it } from "vitest";
import { parseBugs } from "../../canary/server.mjs";
import { startCanary } from "../helpers.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
	await close?.();
	close = undefined;
});

async function canary(opts: Parameters<typeof startCanary>[0]) {
	const c = await startCanary(opts);
	close = c.close;
	const json = async (method: string, path: string, body?: unknown) => {
		const r = await fetch(`${c.url}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
		return { status: r.status, body: (await r.json()) as Record<string, unknown> };
	};
	return { ...c, json };
}

async function burst(json: Awaited<ReturnType<typeof canary>>["json"], n: number) {
	const rs = await Promise.all(Array.from({ length: n }, () => json("POST", "/orders", { productId: "p1", qty: 1 })));
	return rs.filter((r) => r.status === 201).length;
}

describe("canary", () => {
	it("parses BUGS switches", () => {
		expect([...parseBugs(undefined)]).toEqual(["B1", "B2", "B3"]);
		expect(parseBugs("none").size).toBe(0);
		expect([...parseBugs("b1, B4")]).toEqual(["B1", "B4"]);
	});

	it("B1: concurrent orders oversell; fixed build conserves stock", async () => {
		const buggy = await canary({ bugs: new Set(["B1"]) });
		await buggy.json("POST", "/reset");
		const accepted = await burst(buggy.json, 30);
		expect(accepted).toBeGreaterThan(10); // stock is 10
		await buggy.close();
		close = undefined;

		const fixed = await canary({ bugs: new Set() });
		await fixed.json("POST", "/reset");
		expect(await burst(fixed.json, 30)).toBe(10);
		expect((await fixed.json("GET", "/products/p1")).body.stock).toBe(0);
	});

	it("B2: the last page is one item short", async () => {
		const c = await canary({ bugs: new Set(["B2"]) });
		const first = await c.json("GET", "/products?page=1&size=3");
		const pages = first.body.pages as number;
		let seen = 0;
		for (let i = 1; i <= pages; i++) seen += ((await c.json("GET", `/products?page=${i}&size=3`)).body.items as unknown[]).length;
		expect(seen).toBe((first.body.total as number) - 1);
	});

	it("B3: emoji in a product name returns 500", async () => {
		const c = await canary({ bugs: new Set(["B3"]) });
		expect((await c.json("POST", "/products", { name: "Rocket 🚀" })).status).toBe(500);
		expect((await c.json("POST", "/products", { name: "Rocket" })).status).toBe(201);
	});

	it("eventual mode: an immediate read looks wrong, a settled read is correct", async () => {
		const c = await canary({ bugs: new Set(), consistency: "eventual" });
		expect(await burst(c.json, 15)).toBe(10);
		expect((await c.json("GET", "/products/p1")).body.stock).toBeGreaterThan(0); // not applied yet
		await new Promise((r) => setTimeout(r, 2300));
		expect((await c.json("GET", "/products/p1")).body.stock).toBe(0);
	});

	it("B4: in eventual mode the cancel compensation is applied twice after settling", async () => {
		const c = await canary({ bugs: new Set(["B4"]), consistency: "eventual" });
		const o = await c.json("POST", "/orders", { productId: "p2", qty: 2 });
		await c.json("POST", `/orders/${o.body.id}/cancel`);
		await new Promise((r) => setTimeout(r, 2300));
		expect((await c.json("GET", "/products/p2")).body.stock).toBe(7); // seed 5, correct would be 5
	});
});
