import type { Server } from "node:http";

export function parseBugs(value: string | undefined): Set<string>;
export function createCanary(options?: { bugs?: Set<string>; consistency?: "sync" | "eventual" }): Server;
