# race-probe — concurrent counter race probe

Generic detector for **lost-update / oversell** bugs on HTTP APIs that keep a counter
(stock, quota, seats, balance) and expose an operation that consumes a quantity.

It fires N identical operations concurrently, then checks two contract invariants:

1. `successes * qty <= initialCounter` — never promise more units than exist.
2. `initial - final === successes * qty` — each success must decrement exactly qty.
3. `final >= 0` — the counter never goes negative.

Exit **1** = a violation was observed (problem reproduced). Exit **0** = no violation,
or "could not run" (bad target, unreadable counter, failed reset) — environment problems
are never mistaken for a repro.

## Usage

```bash
# Git Bash on Windows needs MSYS_NO_PATHCONV=1, otherwise "/orders" is rewritten
# into "C:/Program Files/Git/orders" (see Known failures).
MSYS_NO_PATHCONV=1 node race-probe.mjs \
  --base http://localhost:4100 \
  --counter /products/p1 --field stock \
  --op /orders --body '{"productId":"p1","qty":1}' --qty 1 \
  --reset /reset --reset-body '{"stock":{"p1":2}}' \
  --conc 10 --rounds 3
```

| Option | Default | Meaning |
|---|---|---|
| `--base` | `http://localhost:4100` (or `$TARGET`) | target origin |
| `--counter` | `/products/p1` | GET path that returns the counter |
| `--field` | `stock` | JSON field holding the counter |
| `--op` | `/orders` | POST path of the consuming operation |
| `--body` | `{"productId":"p1","qty":1}` | request body for the operation |
| `--qty` | `1` | units consumed per successful operation |
| `--reset` | `/reset` | POST path resetting state (called before each round); pass `--reset none` to skip |
| `--reset-body` | `{}` | body for the reset call |
| `--conc` | `10` | concurrent operations per round |
| `--rounds` | `3` | rounds; any single violation reproduces |
| `--expect-success` | `201` | success status code |
| `--expect-reject` | `409` | "insufficient" status code |
| `--quiet` | off | only print the verdict |

## Reading the output

```
round 1: initial=2 concurrent=10 qty=1 -> ok:10 rejected:0 other:0 | final=1 acceptedQty=10 delta=1
  OVERSELL: 10 successes accepted 10 units but only 2 existed
  LOST UPDATE: counter moved by 1 but 10 units were promised (9 units unaccounted)
```

- `ok` vs `rejected` tells you whether the guard ever fired. A correct service returns
  `ok <= initial/qty` and `rejected = conc - ok`.
- `LOST UPDATE` alone (delta != accepted, no oversell) means the counter moves but by the
  wrong amount — usually the same non-atomic read-modify-write seen from the other side.
- `other` statuses are printed with their bodies: 5xx or 400 here usually means the probe
  is misconfigured (wrong body/field), not that the service is broken.

## Known failures

- **Git Bash path mangling**: an argument that starts with `/` is converted to a Windows
  path, producing `Failed to parse URL from http://hostC:/Program Files/Git/orders`.
  Set `MSYS_NO_PATHCONV=1`, or quote the path as `//orders` (double slash), or run from
  PowerShell/cmd.
- **`--reset none`** skips the reset; only safe on a read-only or already-prepared target.
- Single counter, single operation type. Interleaved operations (e.g. cancel + order racing
  each other) need a dedicated probe — this tool cannot model them.
- The counter is read via a separate GET before and after; if the target has eventual
  consistency the "final" read may be stale. Wait or re-read before concluding a violation.
- Does not model multi-resource transactions (order + coupon + ledger).

## Selfcheck

`node selfcheck.mjs` — spins up two local fixture servers (atomic = correct, non-atomic =
buggy) and asserts the probe exits 0 against the correct one and 1 against the buggy one,
plus 0 against an unreachable port. Exit 0 = tool works.
