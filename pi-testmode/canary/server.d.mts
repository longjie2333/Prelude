import type { Server } from "node:http";

export function parseBugs(value: string | undefined): Set<string>;
export interface CanaryServer extends Server {
	setMode(mode: { bugs?: Set<string>; consistency?: "sync" | "eventual" }): void;
}
export function createCanary(options?: { bugs?: Set<string>; consistency?: "sync" | "eventual" }): CanaryServer;
