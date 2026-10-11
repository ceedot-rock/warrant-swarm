/**
 * narrow.test.ts — unit tests for src/narrow.ts (pure TS, no Workers APIs).
 *
 * Covers the faithful port contract: the 7 exact narrow error strings
 * (warrant_cents, warrant_until, warrant_agent, warrant_widen_cents,
 *  warrant_widen_until, warrant_kind, warrant_expired), attenuation-only
 * narrowing across multi-hop chains, and deny-by-default gate semantics.
 *
 * Run: node --test test/narrow.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attenuate,
  gateCheck,
  issueWarrant,
  parseWarrant,
  remainingCents,
  verifyWarrant,
} from "../src/narrow.ts";
import type { Warrant } from "../src/narrow.ts";

// Fixed clock so expiry tests are deterministic.
const NOW = 1_800_000_000; // ~2027-01-15
const LATER = NOW + 3_600;

function root(max_cents = 100, until = LATER, agent_id = "coordinator") {
  return issueWarrant({ agent_id, max_cents, until });
}

function expectThrow(fn: () => unknown, message: string) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof Error, "expected an Error");
    assert.equal((e as Error).message, message);
    return true;
  });
}

describe("issueWarrant", () => {
  it("creates a valid narrow warrant", () => {
    const w = root();
    assert.equal(w.v, 1);
    assert.equal(w.kind, "spl-narrow");
    assert.deepEqual(w.authority, {
      agent_id: "coordinator",
      max_cents: 100,
      until: LATER,
    });
    assert.deepEqual(w.hops, []);
  });

  it("rejects negative cents with warrant_cents", () => {
    expectThrow(
      () => issueWarrant({ agent_id: "a", max_cents: -1, until: LATER }),
      "warrant_cents"
    );
  });

  it("rejects non-integer cents with warrant_cents", () => {
    expectThrow(
      () => issueWarrant({ agent_id: "a", max_cents: 10.5, until: LATER }),
      "warrant_cents"
    );
  });

  it("rejects non-numeric cents with warrant_cents", () => {
    expectThrow(
      () => issueWarrant({ agent_id: "a", max_cents: "100", until: LATER }),
      "warrant_cents"
    );
  });

  it("rejects until <= 0 with warrant_until", () => {
    expectThrow(
      () => issueWarrant({ agent_id: "a", max_cents: 10, until: 0 }),
      "warrant_until"
    );
    expectThrow(
      () => issueWarrant({ agent_id: "a", max_cents: 10, until: -5 }),
      "warrant_until"
    );
  });

  it("rejects empty agent_id with warrant_agent", () => {
    expectThrow(
      () => issueWarrant({ agent_id: "", max_cents: 10, until: LATER }),
      "warrant_agent"
    );
  });

  it("rejects missing agent_id with warrant_agent", () => {
    expectThrow(
      () => issueWarrant({ max_cents: 10, until: LATER }),
      "warrant_agent"
    );
  });

  it("accepts zero-cent warrants", () => {
    const w = issueWarrant({ agent_id: "a", max_cents: 0, until: LATER });
    assert.equal(w.authority.max_cents, 0);
  });
});

describe("attenuate", () => {
  it("appends a narrowing hop", () => {
    const w1 = attenuate(root(), {
      agent_id: "researcher",
      max_cents: 40,
      until: NOW + 1800,
    });
    assert.equal(w1.hops.length, 1);
    assert.deepEqual(w1.hops[0], {
      agent_id: "researcher",
      max_cents: 40,
      until: NOW + 1800,
    });
    // Authority is preserved through delegation.
    assert.equal(w1.authority.max_cents, 100);
  });

  it("chains 100 -> 40 -> 15 like the demo", () => {
    const w1 = attenuate(root(100), {
      agent_id: "researcher",
      max_cents: 40,
      until: NOW + 1800,
    });
    const w2 = attenuate(w1, {
      agent_id: "leaf",
      max_cents: 15,
      until: NOW + 900,
    });
    assert.equal(w2.hops.length, 2);
    const v = verifyWarrant(w2, NOW);
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.body.agent_id, "leaf");
      assert.equal(v.body.max_cents, 15);
    }
  });

  it("allows equal caps (narrowing to the same value is not widening)", () => {
    const w1 = attenuate(root(40), {
      agent_id: "b",
      max_cents: 40,
      until: LATER,
    });
    assert.equal(w1.hops[0].max_cents, 40);
  });

  it("rejects cap widening with warrant_widen_cents", () => {
    expectThrow(
      () =>
        attenuate(root(100), {
          agent_id: "greedy",
          max_cents: 200,
          until: NOW + 600,
        }),
      "warrant_widen_cents"
    );
  });

  it("rejects widening against the last hop, not just the root", () => {
    const w1 = attenuate(root(100), {
      agent_id: "mid",
      max_cents: 40,
      until: NOW + 1800,
    });
    // 50 > 40 (last hop) even though 50 < 100 (root): still widening.
    expectThrow(
      () =>
        attenuate(w1, { agent_id: "leaf", max_cents: 50, until: NOW + 900 }),
      "warrant_widen_cents"
    );
  });

  it("rejects expiry extension with warrant_widen_until", () => {
    expectThrow(
      () =>
        attenuate(root(100, NOW + 600), {
          agent_id: "b",
          max_cents: 40,
          until: NOW + 3600,
        }),
      "warrant_widen_until"
    );
  });

  it("rejects wrong kind with warrant_kind", () => {
    const bad = { ...root(), kind: "spl-wide" };
    expectThrow(
      () => attenuate(bad, { agent_id: "b", max_cents: 1, until: LATER }),
      "warrant_kind"
    );
  });

  it("rejects wrong version with warrant_kind", () => {
    const bad = { ...root(), v: 2 };
    expectThrow(
      () => attenuate(bad, { agent_id: "b", max_cents: 1, until: LATER }),
      "warrant_kind"
    );
  });

  it("rejects a non-object warrant with warrant_kind", () => {
    expectThrow(
      () => attenuate(null, { agent_id: "b", max_cents: 1, until: LATER }),
      "warrant_kind"
    );
    expectThrow(
      () => attenuate("nope", { agent_id: "b", max_cents: 1, until: LATER }),
      "warrant_kind"
    );
  });
});

describe("verifyWarrant", () => {
  it("accepts a valid chain and returns the last hop", () => {
    const w2 = attenuate(
      attenuate(root(100), {
        agent_id: "mid",
        max_cents: 40,
        until: NOW + 1800,
      }),
      { agent_id: "leaf", max_cents: 15, until: NOW + 900 }
    );
    const v = verifyWarrant(w2, NOW);
    assert.ok(v.ok);
    if (v.ok) assert.equal(v.body.max_cents, 15);
  });

  it("reports warrant_expired when now >= until", () => {
    const w = root(100, NOW); // until == NOW -> expired
    const v = verifyWarrant(w, NOW);
    assert.ok(!v.ok);
    if (!v.ok) assert.equal(v.error, "warrant_expired");
  });

  it("detects a widened cap planted directly with warrant_widen_cents", () => {
    const w: Warrant = {
      v: 1,
      kind: "spl-narrow",
      authority: { agent_id: "a", max_cents: 100, until: LATER },
      hops: [{ agent_id: "b", max_cents: 500, until: LATER }],
    };
    const v = verifyWarrant(w, NOW);
    assert.ok(!v.ok);
    if (!v.ok) assert.equal(v.error, "warrant_widen_cents");
  });

  it("detects a widened expiry planted directly with warrant_widen_until", () => {
    const w: Warrant = {
      v: 1,
      kind: "spl-narrow",
      authority: { agent_id: "a", max_cents: 100, until: NOW + 100 },
      hops: [{ agent_id: "b", max_cents: 50, until: NOW + 9999 }],
    };
    const v = verifyWarrant(w, NOW);
    assert.ok(!v.ok);
    if (!v.ok) assert.equal(v.error, "warrant_widen_until");
  });

  it("reports warrant_kind for the wrong kind", () => {
    const v = verifyWarrant({ ...root(), kind: "other" }, NOW);
    assert.ok(!v.ok);
    if (!v.ok) assert.equal(v.error, "warrant_kind");
  });

  it("reports warrant_kind for null", () => {
    const v = verifyWarrant(null, NOW);
    assert.ok(!v.ok);
    if (!v.ok) assert.equal(v.error, "warrant_kind");
  });

  it("reports warrant_cents for a malformed body", () => {
    const w = {
      v: 1,
      kind: "spl-narrow",
      authority: { agent_id: "a", max_cents: -3, until: LATER },
      hops: [],
    };
    const v = verifyWarrant(w, NOW);
    assert.ok(!v.ok);
    if (!v.ok) assert.equal(v.error, "warrant_cents");
  });

  it("reports warrant_agent for an empty agent_id", () => {
    const w = {
      v: 1,
      kind: "spl-narrow",
      authority: { agent_id: "", max_cents: 10, until: LATER },
      hops: [],
    };
    const v = verifyWarrant(w, NOW);
    assert.ok(!v.ok);
    if (!v.ok) assert.equal(v.error, "warrant_agent");
  });
});

describe("gateCheck", () => {
  function leaf(): Warrant {
    return attenuate(
      attenuate(root(100), {
        agent_id: "mid",
        max_cents: 40,
        until: NOW + 1800,
      }),
      { agent_id: "leaf", max_cents: 15, until: NOW + 900 }
    );
  }

  it("approves a valid spend and reports the cap as remaining", () => {
    const g = gateCheck(leaf(), "leaf", 10, NOW);
    assert.ok(g.ok);
    if (g.ok) assert.equal(g.remaining_cents, 15);
  });

  it("approves cost exactly equal to the cap", () => {
    const g = gateCheck(leaf(), "leaf", 15, NOW);
    assert.ok(g.ok);
  });

  it("approves a zero-cost call", () => {
    const g = gateCheck(leaf(), "leaf", 0, NOW);
    assert.ok(g.ok);
  });

  it("denies over-budget with OVER_BUDGET", () => {
    const g = gateCheck(leaf(), "leaf", 50, NOW);
    assert.ok(!g.ok);
    if (!g.ok) {
      assert.equal(g.code, "OVER_BUDGET");
      assert.match(g.detail, /exceeds warrant cap 15/);
    }
  });

  it("denies the wrong caller with AGENT_MISMATCH", () => {
    const g = gateCheck(leaf(), "mallory", 5, NOW);
    assert.ok(!g.ok);
    if (!g.ok) assert.equal(g.code, "AGENT_MISMATCH");
  });

  it("denies an expired warrant with WARRANT_EXPIRED", () => {
    const w = root(100, NOW); // expired at NOW
    const g = gateCheck(w, "coordinator", 5, NOW);
    assert.ok(!g.ok);
    if (!g.ok) assert.equal(g.code, "WARRANT_EXPIRED");
  });

  it("denies an invalid cost with WARRANT_DENIED", () => {
    for (const bad of [-1, 2.5, "10", NaN]) {
      const g = gateCheck(leaf(), "leaf", bad, NOW);
      assert.ok(!g.ok, `cost ${String(bad)} should be denied`);
      if (!g.ok) assert.equal(g.code, "WARRANT_DENIED");
    }
  });

  it("denies a malformed warrant with WARRANT_DENIED (deny by default)", () => {
    const g = gateCheck({ kind: "nope" }, "leaf", 5, NOW);
    assert.ok(!g.ok);
    if (!g.ok) assert.equal(g.code, "WARRANT_DENIED");
  });

  it("denies null warrant with WARRANT_DENIED", () => {
    const g = gateCheck(null, "leaf", 5, NOW);
    assert.ok(!g.ok);
    if (!g.ok) assert.equal(g.code, "WARRANT_DENIED");
  });
});

describe("parseWarrant / remainingCents", () => {
  it("parseWarrant returns the warrant for an exact shape", () => {
    const w = root();
    const p = parseWarrant(JSON.parse(JSON.stringify(w)));
    assert.ok(p !== undefined);
    assert.equal(p!.authority.max_cents, 100);
  });

  it("parseWarrant returns undefined for the wrong kind", () => {
    assert.equal(parseWarrant({ ...root(), kind: "x" }), undefined);
  });

  it("parseWarrant returns undefined when hops is not an array", () => {
    assert.equal(parseWarrant({ ...root(), hops: {} }), undefined);
  });

  it("parseWarrant returns undefined for null", () => {
    assert.equal(parseWarrant(null), undefined);
  });

  it("remainingCents returns the last hop cap when valid", () => {
    const w2 = attenuate(root(100), {
      agent_id: "b",
      max_cents: 40,
      until: LATER,
    });
    assert.equal(remainingCents(w2, NOW), 40);
  });

  it("remainingCents returns 0 when expired", () => {
    assert.equal(remainingCents(root(100, NOW), NOW), 0);
  });

  it("remainingCents returns 0 for garbage", () => {
    assert.equal(remainingCents("garbage", NOW), 0);
  });
});

describe("the 7 canonical error strings", () => {
  it("are all reachable and spelled exactly", () => {
    const seen = new Set<string>();
    const grab = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        seen.add((e as Error).message);
      }
    };
    grab(() => issueWarrant({ agent_id: "a", max_cents: -1, until: 1 }));
    grab(() => issueWarrant({ agent_id: "a", max_cents: 1, until: 0 }));
    grab(() => issueWarrant({ agent_id: "", max_cents: 1, until: 1 }));
    grab(() =>
      attenuate(root(10, LATER), { agent_id: "b", max_cents: 11, until: 1 })
    );
    grab(() =>
      attenuate(root(10, 5), { agent_id: "b", max_cents: 9, until: 6 })
    );
    grab(() =>
      attenuate({ kind: "x" }, { agent_id: "b", max_cents: 1, until: 1 })
    );
    const expired = verifyWarrant(root(10, NOW), NOW);
    if (!expired.ok) seen.add(expired.error);
    for (const s of [
      "warrant_cents",
      "warrant_until",
      "warrant_agent",
      "warrant_widen_cents",
      "warrant_widen_until",
      "warrant_kind",
      "warrant_expired",
    ]) {
      assert.ok(seen.has(s), `missing canonical error string: ${s}`);
    }
    assert.equal(seen.size, 7);
  });
});
