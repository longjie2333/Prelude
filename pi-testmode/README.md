# pi-testmode

A pi extension that turns a pi session into a testing orchestrator. In test mode you state a test intent in plain language; the main session records it, looks up matching test templates, dispatches missions that run in isolated in-process sub-sessions, goes idle, and is woken when results arrive. Defects count only after an independent verifier reproduces them. Every run feeds back into the template graph: templates are reinforced, gain exceptions instead of being rewritten, and new capabilities are acquired, verified, and hash-locked. Design: [../docs/agent-core.md](../docs/agent-core.md); plan: [../docs/pi-testmode-plan.md](../docs/pi-testmode-plan.md).

Status: milestones M1–M3 implemented and covered by faux-model tests. Not yet run against a real model.

## Use

```bash
npm install
pi -e ./pi-testmode            # or: pi install ./pi-testmode
```

| Command | What it does |
|---|---|
| `/test` (`--test`, Ctrl+Alt+T) | Toggle test mode |
| `/test-missions` | Resume, re-dispatch, or abandon missions left interrupted or blocked by a crash |
| `/test-kb` | Templates with status, statistics, exceptions, and open hypotheses |
| `/test-why <tpl>` | Why a template applies (or not) to the latest situation, with its history |
| `/test-promote <tpl>` | Promote a stable project template to the global layer (gate + your confirmation) |
| `/test-garden [--apply]` | Duplicates, exception folding, capacity, escape hatches, snapshot |
| `/test-calibrate [bugs=B1,B2] [hours=24]` | Precision/recall against canary ground truth; drift pauses learning |

Missions that touch a system need an authorization scope at `<project>/.pi/testmode/scope.json`, maintained by you (agents can never write it):

```json
{
  "targets": [{ "host": "localhost:4100", "envs": ["local"], "allowed": ["functional", "load"] }],
  "egress_allowlist": ["registry.npmjs.org"]
}
```

Without it, only R0/R1 (read-only) missions run.

## Try it on the canary

```bash
npm run canary                      # http://localhost:4100, bugs B1,B2,B3 on
BUGS=none npm run canary            # fixed build
CONSISTENCY=eventual BUGS=B4 npm run canary
```

Then in pi, in test mode: "测一下 canary 的下单接口在并发下会不会超卖". A second request on another resource ("优惠券并发领取会不会超领") should hit the template the first run produced.

## Isolation

The policy gate runs in the main session and in every mission: writes only inside the mission's run directory, protected `scope.json` / databases / extension, approvals for first-time dependency installs and MCP servers (R2) and unknown hosts (R4), audit of every call. This gate is not a security boundary.

On macOS and Linux, missions' `bash` runs inside `@anthropic-ai/sandbox-runtime` with a network allowlist from the scope. Windows has no OS sandbox; reports say "tool-layer policy only". For strong isolation on Windows, run pi in the official [Docker setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md).

## Develop

```bash
npm run typecheck
npm test                 # unit + e2e (faux provider, no network or credentials), ~1 min
```

The e2e suites drive real in-process pi sessions with a scripted model: `loop` (M1 chain), `crash` (kill mid-tool, recover), `m2` (H0 → draft template + verified skill → H2 at 37% of the cost), `mcp` (MCP provider, rewritten descriptions, hash lock), `m3` (agent-core §14 end to end). Set `TESTMODE_DEBUG=1` to write the reports and audit trails they produce.

`npm install` uses `legacy-peer-deps` (see `.npmrc`): npm 11 crashes resolving vitest's optional peers otherwise.
