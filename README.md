# warranted-swarm — Warrant-gated agent swarm on Cloudflare Workers

Experiment: the lab's narrow-Warrant spend gate, ported to TypeScript and
running as a persistent agent on the Cloudflare Agents SDK (Durable Objects).

## What this proves

- The narrow Warrant semantics port exactly: same error strings
  (`warrant_cents`, `warrant_until`, `warrant_agent`, `warrant_widen_cents`,
  `warrant_widen_until`, `warrant_expired`, `warrant_kind`), same
  attenuation-only-narrows rule, same deny-by-default gate.
- A `SwarmCoordinator` agent holds warrants + an append-only audit ledger in
  durable state; RPC methods (`startRun`, `delegate`, `spend`, `getLedger`)
  enforce the gate per call.
- `GET /demo` runs the full scenario live against a real Durable Object and
  returns the transcript — see `demo-transcript.json`.

## File map

- `src/narrow.ts` — faithful TS port of `warrant_lib.py` (issue/attenuate/
  verify/gateCheck, identical error strings). Also exports the frozen
  `WARRANT_ERRORS` (the 7 canonical strings) and `GATE_CODES` maps for
  consumers — additive only, zero logic changes from the verified port.
- `src/swarm.ts` — `SwarmCoordinator extends Agent<Env>`: durable
  `{warrants, ledger}` state, `@callable()` RPC methods. `spend` throws
  `GateError` with code `OVER_BUDGET` / `AGENT_MISMATCH` / `WARRANT_EXPIRED` /
  `WARRANT_DENIED`; every attempt is ledgered.
- `src/index.ts` — Worker entrypoint: `routeAgentRequest` for agent traffic,
  `GET /demo` for the self-contained scenario (fresh agent instance per call).
- `test/narrow.test.ts` — 42 unit tests: all 7 canonical error strings,
  multi-hop attenuation chains, every gate denial code, parse/remaining
  helpers. Pure TS, runs under `node --test` with no Workers APIs.
- `test/integration.test.ts` — boots the real workerd runtime via
  `wrangler dev`, hits `/demo`, and asserts the exact verified transcript
  (attenuation, step results/codes/messages, 5 ledger events in sequence,
  ledger well-formedness, run isolation, id chaining).
- `wrangler.jsonc` — `SWARM_COORDINATOR` DO binding, `v1` SQLite migration.
- `demo-transcript.json` — verified output of `/demo`.

## Run it

```sh
npm install
npm run dev            # wrangler dev on :8787 (real workerd, no login needed)
# then: curl localhost:8787/demo
```

## Tests

```sh
npm test                # 42 unit tests (fast, no runtime)
npm run test:integration # boots real workerd via wrangler dev, asserts /demo
npm run typecheck        # npx tsc --noEmit (covers src + test)
npm run verify           # typecheck + unit + integration, the full gate
```

## Cloudflare open-source materials used

- **workerd** (Apache-2.0) — the actual Workers runtime, running locally via
  `wrangler dev`. The Durable Object, SQLite storage, and RPC layer in these
  tests execute on the real runtime, not a mock. No login required for local
  dev.
- **Miniflare** — bundled with wrangler; provides the local bindings
  (DO namespaces, storage) that `wrangler dev` wires to workerd.
- **celld** (denoland/celld, Apache-2.0) — evaluated, not adopted. It is a
  self-hosted Durable Objects daemon (alpha, v0.5.x) that runs Wrangler
  bundles on your own machines with per-cell SQLite replicated to a bucket
  you own. Not used here because: it is alpha, it needs a provisioned
  S3-compatible bucket plus its Rust binary, and compatibility of the Agents
  SDK `@callable()` RPC surface with celld is unverified. It remains the
  interesting self-hosting escape hatch if the lab ever wants the swarm off
  Cloudflare's metal without rewriting the DO code.

## Deploy path

```sh
npx wrangler login    # <-- your action; no Cloudflare auth on this machine
npx wrangler deploy
```

## Honest boundaries

- Everything above is verified against **local** workerd/Miniflare only. No
  live Cloudflare deployment has been performed or claimed.
- The audit ledger is append-only JSON lines in durable DO state; entries are
  not cryptographically signed (hash-chained/signed receipts are a planned
  follow-up, matching the lab's Chamber work).
- `wrangler deploy` needs `wrangler login` on a machine with Corey's
  Cloudflare account — that step is his.
