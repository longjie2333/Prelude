# pi-testmode

A pi extension that turns a pi session into a testing orchestrator. In test mode you state a test intent in plain language; the main session records it, dispatches missions that run in isolated in-process sub-sessions, goes idle, and is woken when results arrive. Defects count only after an independent verifier reproduces them. Design: [../docs/agent-core.md](../docs/agent-core.md); plan: [../docs/pi-testmode-plan.md](../docs/pi-testmode-plan.md).

Status: milestone M1 (kernel and mission loop).

## Use

```bash
npm install
pi -e ./pi-testmode            # or: pi install ./pi-testmode
```

In pi: `/test` (or `--test`, or Ctrl+Alt+T) toggles test mode. `/test-missions` resumes, re-dispatches, or abandons missions left interrupted or blocked by a crash.

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

Then in pi, in test mode: "测一下 canary 的下单接口在并发下会不会超卖".

## Isolation

The policy gate runs in the main session and in every mission: writes only inside the mission's run directory, protected `scope.json` / databases / extension, approvals for first-time dependency installs (R2) and unknown hosts (R4), audit of every call. This gate is not a security boundary.

On macOS and Linux, missions' `bash` runs inside `@anthropic-ai/sandbox-runtime` with a network allowlist from the scope. Windows has no OS sandbox; reports say "tool-layer policy only". For strong isolation on Windows, run pi in the official [Docker setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md).

## Develop

```bash
npm run typecheck
npm test                 # unit + e2e (faux provider, no network or credentials)
```

`npm install` uses `legacy-peer-deps` (see `.npmrc`): npm 11 crashes resolving vitest's optional peers otherwise.
