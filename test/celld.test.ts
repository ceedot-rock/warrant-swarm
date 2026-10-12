/**
 * celld.test.ts — boots the REAL celld runtime (Deno's open-source Workers
 * implementation, `celld dev` with its local object store — no cloud bucket,
 * no login) and asserts the /demo transcript against the verified behaviors:
 * 100->40->15 attenuation, 10c approved, 50c denied OVER_BUDGET, 200c
 * widening rejected with warrant_widen_cents, 5 ledger events in exact
 * sequence.
 *
 * The Agents SDK @callable() RPC works on celld with zero adaptation —
 * no code changes were needed for this path.
 *
 * Robustness notes (same discipline as test/integration.test.ts):
 * - Spawns the celld bin directly (no npx middleman).
 * - Child stdio is drained (never an unread "pipe").
 * - Every fetch has an AbortSignal timeout — nothing may hang forever.
 * - An ephemeral port is chosen per run so stale runs can't collide.
 * - esbuild must be on PATH for celld's bundler (node_modules/.bin covers it).
 *
 * Requires: .tools/celld (download from denoland/celld releases).
 * Run: node --test test/celld.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import fs from "node:fs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CELLD_BIN = path.join(REPO_ROOT, ".tools", "celld");
const CELLD_CONFIG = path.join(REPO_ROOT, "wrangler.celld.json");
const FETCH_TIMEOUT_MS = 10_000;
const BOOT_TIMEOUT_MS = 180_000;

let child: ChildProcess | undefined;
let port = 0;
let base = "";
const logTail: string[] = [];

function pushLog(chunk: Buffer | string) {
  for (const line of String(chunk).split("\n")) {
    logTail.push(line);
    if (logTail.length > 60) logTail.shift();
  }
}

function fetchJson(url: string): Promise<any> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { signal: c.signal }).then(async (r) => {
    clearTimeout(t);
    return { status: r.status, ok: r.ok, json: r.ok ? await r.json() : null };
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(p));
    });
  });
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastErr = "no attempts yet";
  while (Date.now() < deadline) {
    try {
      const { ok } = await fetchJson(`${base}/demo`);
      if (ok) return;
      lastErr = "non-OK status";
    } catch (e) {
      lastErr = `${(e as Error).name}: ${String((e as Error).message).slice(0, 100)}`;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `celld dev never became ready on :${port} (${lastErr}). Log tail:\n` +
      logTail.slice(-25).join("\n")
  );
}

async function demo(): Promise<any> {
  const { status, ok, json } = await fetchJson(`${base}/demo`);
  assert.equal(status, 200, `GET /demo should return 200 (got ${status})`);
  assert.ok(ok && json, "GET /demo should return JSON");
  return json;
}

describe("warranted-swarm on real celld (celld dev)", { timeout: 300_000 }, () => {
  before(async () => {
    assert.ok(
      fs.existsSync(CELLD_BIN),
      `celld bin missing at ${CELLD_BIN} (download from https://github.com/denoland/celld/releases)`
    );
    assert.ok(
      fs.existsSync(CELLD_CONFIG),
      `celld config missing at ${CELLD_CONFIG}`
    );
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      PATH: `${path.join(REPO_ROOT, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    child = spawn(
      CELLD_BIN,
      ["dev", "./wrangler.celld.json", "--port", String(port), "--clean", "--no-watch"],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env }
    );
    // Drain child output so a full pipe can never deadlock the runtime.
    child.stdout?.on("data", pushLog);
    child.stderr?.on("data", pushLog);
    await new Promise<void>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("spawn", resolve);
    });
    await waitForReady();
  });

  after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const exited = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 8000);
        child!.once("exit", () => {
          clearTimeout(t);
          resolve(true);
        });
      });
      if (!exited) child.kill("SIGKILL");
    }
  });

  it("serves the exact verified demo scenario", async () => {
    const d = await demo();
    assert.equal(d.scenario, "warranted-swarm demo");
    assert.deepEqual(d.attenuation, [100, 40, 15]);

    const [s0, s1, s2, s3, s4, s5] = d.steps;
    assert.equal(s0.step, "startRun");
    assert.equal(s0.rootCapCents, 100);
    assert.match(s0.runId, /^run-/);

    assert.equal(s1.step, "delegate");
    assert.equal(s1.capCents, 40);
    assert.ok((s1.warrantId as string).endsWith("/researcher"));

    assert.equal(s2.step, "delegate");
    assert.equal(s2.capCents, 15);
    assert.ok((s2.warrantId as string).endsWith("/researcher/leaf"));

    assert.equal(s3.step, "spend");
    assert.equal(s3.costCents, 10);
    assert.equal(s3.result, "APPROVED");
    assert.equal(s3.remainingCents, 15);

    assert.equal(s4.step, "spend");
    assert.equal(s4.costCents, 50);
    assert.equal(s4.result, "DENIED");
    assert.equal(s4.code, "OVER_BUDGET");
    assert.equal(s4.message, "OVER_BUDGET: cost 50c exceeds warrant cap 15c");

    assert.equal(s5.step, "delegate");
    assert.equal(s5.capCents, 200);
    assert.equal(s5.result, "REJECTED");
    assert.equal(s5.code, "warrant_widen_cents");
    assert.equal(s5.message, "warrant_widen_cents");
  });

  it("emits exactly 5 ledger events in the verified sequence", async () => {
    const d = await demo();
    assert.equal(d.ledgerLines, 5);
    assert.equal(d.ledger.length, 5);
    const events = d.ledger.map((l: string) => JSON.parse(l));
    assert.deepEqual(
      events.map((e: any) => e.event),
      ["run_started", "delegated", "delegated", "spend_approved", "spend_denied"]
    );
    const denied = events[4];
    assert.equal(denied.code, "OVER_BUDGET");
    assert.equal(denied.callerId, "leaf");
    assert.equal(denied.costCents, 50);
  });

  it("ledger lines are well-formed with non-decreasing timestamps", async () => {
    const d = await demo();
    let prevT = -Infinity;
    for (const line of d.ledger) {
      const e = JSON.parse(line);
      assert.equal(typeof e.t, "number", "ledger line must carry t");
      assert.ok(e.t >= prevT, "ledger timestamps must be non-decreasing");
      prevT = e.t;
    }
  });

  it("ledger ids chain consistently with the steps", async () => {
    const d = await demo();
    const [s0, s1, s2] = d.steps;
    const events = d.ledger.map((l: string) => JSON.parse(l));
    assert.equal(events[0].runId, s0.runId);
    assert.equal(events[0].budgetCents, 100);
    assert.equal(events[1].parentId, s0.runId);
    assert.equal(events[1].warrantId, s1.warrantId);
    assert.equal(events[2].parentId, s1.warrantId);
    assert.equal(events[2].warrantId, s2.warrantId);
    assert.equal(events[3].warrantId, s2.warrantId);
    assert.equal(events[4].warrantId, s2.warrantId);
  });

  it("each /demo call is an isolated run (fresh Durable Object instance)", async () => {
    const a = await demo();
    const b = await demo();
    assert.notEqual(
      a.steps[0].runId,
      b.steps[0].runId,
      "demo runs must not share state"
    );
    assert.equal(b.ledgerLines, 5);
  });

  it("unknown routes still 404", async () => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(`${base}/nope`, { signal: c.signal });
      assert.equal(r.status, 404);
    } finally {
      clearTimeout(t);
    }
  });
});
