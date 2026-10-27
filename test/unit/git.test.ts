import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Git } from "../../src/kb/git.ts";
import { type TempProject, tempProject } from "../helpers.ts";

let p: TempProject;
beforeEach(() => {
	p = tempProject();
});
afterEach(() => p.cleanup());

/** A bare "remote" seeded with one commit on main, and two clones of it. */
async function setup() {
	const remote = join(p.base, "remote.git");
	await new Git(p.base).exec(["init", "--quiet", "--bare", "-b", "main", remote]);
	const seed = new Git(join(p.base, "seed"));
	mkdirSync(seed.dir);
	await seed.init("main");
	writeFileSync(join(seed.dir, "a.txt"), "base\n");
	await seed.commitAll("seed");
	await seed.exec(["remote", "add", "origin", remote]);
	expect((await seed.push(["main"])).code).toBe(0);
	const a = join(p.base, "a");
	const b = join(p.base, "b");
	await Git.clone(remote, a);
	await Git.clone(remote, b);
	return { remote, a: new Git(a), b: new Git(b) };
}

describe("git wrapper (M2-2)", () => {
	it("commits, reports dirty paths and restores a clean workspace", async () => {
		const { a } = await setup();
		expect(await a.dirtyPaths()).toEqual([]);
		writeFileSync(join(a.dir, "a.txt"), "edited by a shell\n");
		writeFileSync(join(a.dir, "new.txt"), "x");
		expect((await a.dirtyPaths()).sort()).toEqual(["a.txt", "new.txt"]);
		await a.restoreClean();
		expect(await a.dirtyPaths()).toEqual([]);
		expect(await a.commitAll("nothing")).toBe(false);
	});

	it("finds conflicts, takes a side and finishes the merge", async () => {
		const { a, b } = await setup();
		writeFileSync(join(a.dir, "a.txt"), "from a\n");
		await a.commitAll("a");
		expect((await a.push(["HEAD:main"])).code).toBe(0);
		writeFileSync(join(b.dir, "a.txt"), "from b\n");
		await b.commitAll("b");
		await b.fetch();
		expect(await b.merge("origin/main", "merge")).toEqual(["a.txt"]);
		expect(await b.mergeInProgress()).toBe(true);
		expect(await b.showStage("a.txt", 3)).toBe("from a\n");
		await b.checkoutSide("a.txt", "ours");
		await b.finishMerge();
		expect(await b.mergeInProgress()).toBe(false);
		expect(await b.conflictedPaths()).toEqual([]);
		expect((await b.push(["HEAD:main"])).code).toBe(0);
	});

	it("checks remote branches and reports a failed push without throwing", async () => {
		const { a, remote } = await setup();
		expect(await a.remoteBranchExists(remote, "main")).toBe(true);
		expect(await a.remoteBranchExists(remote, "kb/someone")).toBe(false);
		await a.exec(["remote", "set-url", "origin", join(p.base, "missing.git")]);
		expect((await a.push(["HEAD:main"])).code).not.toBe(0);
	});
});
