# interleave-probe — release-vs-consume conservation probe

Companion to `rest-api/scripts/race-probe/`. `race-probe` fires N *identical* consuming
operations and catches oversell. This tool covers the case race-probe's README lists as
out of scope: **an operation that releases a counter (cancel/refund, `+qty`) racing an
operation that consumes it (place order, `-qty`)**.

Both directions can be correct in isolation — every call guarded by its 409 — while the
pair still loses updates, because the two read-modify-write paths are not atomic with
respect to each other. A fix that only re-checks "is there enough stock?" before placing
an order does **not** close this class; the counter must be mutated atomically (lock,
single-writer queue, or compare-and-swap).

## Invariant

At rest, for one resource with no other traffic:

```
counter + qty(sum of still-held items) == initial counter
```

Every sequential interleaving of "release all" and "place N new" ends at that value, so
a correct server must end there too.

## Usage

```bash
# Git Bash on Windows needs MSYS_NO_PATHCONV=1, otherwise "/orders" is rewritten
# into "C:/Program Files/Git/orders" (see Known failures).
MSYS_NO_PATHCONV=1 node interleave-probe.mjs \
  --base http://localhost:4100 \
  --counter /products/p1 --field stock --product p1 \
  --orders /orders --reset /reset \
  --initial 5 --hold-qty 1 --new-qty 1 --burst 5 --rounds 5
```

| Option | Default | Meaning |
|---|---|---|
| `--base` | `http://localhost:4100` (or `$TARGET`) | target origin |
| `--counter` | `/products/p1` | GET path returning the counter |
| `--field` | `stock` | JSON field holding the counter |
| `--product` | `p1` | product id used in the operation body and reset override |
| `--orders` | `/orders` | collection path: POST = place, GET = list |
| `--qty-field` | `qty` | field in a listed order holding its quantity |
| `--placed-status` | `placed` | status value that still holds the counter |
| `--reset` | `/reset` | POST path resetting state; called before each round with `{"stock":{"<product>":<initial>}}` |
| `--initial` | `5` | counter value prepared for each round |
| `--hold-qty` | `1` | qty per setup order |
| `--new-qty` | `1` | qty per new order fired during the race |
| `--burst` | `5` | number of setup orders = number of cancels = number of new orders |
| `--rounds` | `5` | rounds; any single violation reproduces |
| `--expect-success` | `201` | place-order success code |
| `--expect-cancel` | `200` | cancel success code |
| `--expect-reject` | `409` | "insufficient"/"already cancelled" code |
| `--quiet` | off | only print violations and the verdict |

## Reading the output

```
round 1: start=5 cancels=200/200/200/200/200 newOrders=201/201/201/201/201 | final=4 placedQty=5 sum=9 (expected 5)
  LOST UPDATE: stock(4) + placedQty(5) = 9, expected 5 (4 unit(s) unaccounted)
```

- `sum != expected` with a **positive** deviation means releases were double-counted or
  the concurrent consume was overwritten — units created out of thin air.
- `sum != expected` with a **negative** deviation means a release was lost — units vanished.
- `UNEXPECTED STATUS` means the probe is misconfigured for this API (wrong success codes,
  or the resource rejects the setup phase), not necessarily a defect.
- `NEGATIVE COUNTER` is a separate contract violation and is reported too.

## Known failures

- **Git Bash path mangling**: an argument starting with `/` becomes a Windows path,
  producing `Failed to parse URL from http://hostC:/Program Files/Git/orders`. Set
  `MSYS_NO_PATHCONV=1`, quote as `//orders`, or run from PowerShell/cmd.
- Assumes the reset endpoint accepts a per-product counter override
  (`{"stock":{"<product>":N}}`). Without it, prepare state yourself and pass a `--reset`
  path that still works; a failing reset exits 0 ("could not run"), never a false repro.
- Assumes the order list exposes every order with a status field and its qty. APIs that
  paginate orders or hide cancelled ones need `--orders` pointed at a complete view.
- Single resource, single pair of operations. Multi-resource transactions (order +
  coupon + ledger) and "reserve → confirm → release" three-state flows are not modelled.
- Counter is read via a separate GET; on eventually-consistent targets the post-race read
  may be stale. Re-read before concluding.
- Needs `--burst` items held before the race; if the counter cannot hold `burst*hold-qty`
  units the setup fails and the tool exits 0 (could not run).

## Selfcheck

`node selfcheck.mjs` — spins up two local fixture servers with the same HTTP shape
(atomic = one mutex, racy = non-atomic read-modify-write) and asserts the probe exits 0
against the atomic one, 1 against the racy one, and 0 against an unreachable port.
Exit 0 = the tool works.
