/**
 * narrow.ts — "narrow" spend Warrants, faithful TypeScript port of the
 * Slid Phi Labs reference implementation (warrant_lib.py, itself an exact
 * port of ceedot-rock/Agent-Rider src/lib/narrow.ts).
 *
 * A Warrant is a spend permission slip with Biscuit-style offline attenuation:
 * budgets may only shrink as authority delegates down a chain. It is NOT a
 * general action/resource policy language — spend only (max_cents + until).
 *
 * Shape:
 *   {v: 1, kind: "spl-narrow",
 *    authority: {agent_id, max_cents, until},
 *    hops: [{agent_id, max_cents, until}, ...]}
 *
 * The 7 canonical narrow error strings (spelled exactly, see WARRANT_ERRORS):
 *   warrant_cents       — max_cents not an integer >= 0
 *   warrant_until       — until not an integer > 0
 *   warrant_agent       — agent_id not a non-empty string
 *   warrant_widen_cents — a hop raises max_cents above the previous hop
 *   warrant_widen_until — a hop extends until beyond the previous hop
 *   warrant_kind        — wrong kind/version, or not a warrant-shaped object
 *   warrant_expired     — now >= last hop's until
 *
 * Note: "warrant_invalid" is a defensive extra used only when `hops` is
 * present but not an array; it is not one of the 7 canonical strings.
 *
 * Semantics:
 * - attenuate: each hop's max_cents <= previous max_cents and
 *              each hop's until     <= previous until     (never widen)
 * - verify:    kind/v check, chain monotonicity, then
 *              now >= last.until -> "warrant_expired"
 * - enforce:   last-hop agent_id == caller AND cost <= cap AND now < until.
 *              Deny by default on ANY failure.
 */

export interface WarrantBody {
  agent_id: string;
  max_cents: number;
  until: number;
}

export interface Warrant {
  v: 1;
  kind: "spl-narrow";
  authority: WarrantBody;
  hops: WarrantBody[];
}

export type VerifyResult =
  | { ok: true; body: WarrantBody }
  | { ok: false; error: string };

export type GateResult =
  | { ok: true; body: WarrantBody; remaining_cents: number }
  | { ok: false; code: string; detail: string };

/**
 * The 7 canonical narrow error strings, frozen. Consumers should compare
 * against these constants rather than retyping the literals.
 */
export const WARRANT_ERRORS = Object.freeze({
  CENTS: "warrant_cents",
  UNTIL: "warrant_until",
  AGENT: "warrant_agent",
  WIDEN_CENTS: "warrant_widen_cents",
  WIDEN_UNTIL: "warrant_widen_until",
  KIND: "warrant_kind",
  EXPIRED: "warrant_expired",
} as const);

export type WarrantErrorString =
  (typeof WARRANT_ERRORS)[keyof typeof WARRANT_ERRORS];

/** Gate denial codes (distinct from the narrow error strings). */
export const GATE_CODES = Object.freeze({
  OVER_BUDGET: "OVER_BUDGET",
  AGENT_MISMATCH: "AGENT_MISMATCH",
  WARRANT_EXPIRED: "WARRANT_EXPIRED",
  WARRANT_DENIED: "WARRANT_DENIED",
} as const);

/** Raised by issueWarrant/attenuate on malformed or widening warrants. */
export class WarrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WarrantError";
  }
}

function intCents(n: unknown): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new WarrantError("warrant_cents");
  }
  return n;
}

function intUntil(n: unknown): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new WarrantError("warrant_until");
  }
  return n;
}

function body(raw: unknown): WarrantBody {
  if (typeof raw !== "object" || raw === null) {
    throw new WarrantError("warrant_agent");
  }
  const r = raw as Record<string, unknown>;
  const agent_id = r["agent_id"];
  if (typeof agent_id !== "string" || agent_id.length === 0) {
    throw new WarrantError("warrant_agent");
  }
  return {
    agent_id,
    max_cents: intCents(r["max_cents"]),
    until: intUntil(r["until"]),
  };
}

function last(w: Warrant): WarrantBody {
  return w.hops.length > 0 ? w.hops[w.hops.length - 1] : w.authority;
}

/** Create a fresh warrant naming one agent and a spend cap. */
export function issueWarrant(authority: unknown): Warrant {
  return { v: 1, kind: "spl-narrow", authority: body(authority), hops: [] };
}

/**
 * Delegate: append a hop that may only narrow the budget.
 * Throws WarrantError("warrant_widen_cents" | "warrant_widen_until" | "warrant_kind").
 */
export function attenuate(w: unknown, nxt: unknown): Warrant {
  if (typeof w !== "object" || w === null) {
    throw new WarrantError("warrant_kind");
  }
  const ww = w as Record<string, unknown>;
  if (ww["kind"] !== "spl-narrow" || ww["v"] !== 1) {
    throw new WarrantError("warrant_kind");
  }
  const hop = body(nxt);
  const authority = body(ww["authority"]);
  if ("hops" in ww && !Array.isArray(ww["hops"])) {
    throw new WarrantError("warrant_invalid");
  }
  const hops = (Array.isArray(ww["hops"]) ? ww["hops"] : []).map(body);
  const prev = hops.length > 0 ? hops[hops.length - 1] : authority;
  if (hop.max_cents > prev.max_cents) {
    throw new WarrantError("warrant_widen_cents");
  }
  if (hop.until > prev.until) {
    throw new WarrantError("warrant_widen_until");
  }
  return { v: 1, kind: "spl-narrow", authority, hops: [...hops, hop] };
}

/**
 * Structural verification. Returns {ok: true, body} or {ok: false, error}
 * with one of the narrow.ts error strings.
 */
export function verifyWarrant(w: unknown, now?: number): VerifyResult {
  const t = now ?? Math.floor(Date.now() / 1000);
  try {
    if (typeof w !== "object" || w === null) {
      return { ok: false, error: "warrant_kind" };
    }
    const ww = w as Record<string, unknown>;
    if (ww["kind"] !== "spl-narrow" || ww["v"] !== 1) {
      return { ok: false, error: "warrant_kind" };
    }
    if ("hops" in ww && !Array.isArray(ww["hops"])) {
      return { ok: false, error: "warrant_invalid" };
    }
    const chain = [
      body(ww["authority"]),
      ...(Array.isArray(ww["hops"]) ? ww["hops"] : []).map(body),
    ];
    for (let i = 1; i < chain.length; i++) {
      if (chain[i].max_cents > chain[i - 1].max_cents) {
        return { ok: false, error: "warrant_widen_cents" };
      }
      if (chain[i].until > chain[i - 1].until) {
        return { ok: false, error: "warrant_widen_until" };
      }
    }
    const cur = chain[chain.length - 1];
    if (t >= cur.until) {
      return { ok: false, error: "warrant_expired" };
    }
    return { ok: true, body: cur };
  } catch (e) {
    if (e instanceof WarrantError) {
      return { ok: false, error: e.message || "warrant_invalid" };
    }
    return { ok: false, error: "warrant_invalid" };
  }
}

/** Lenient parse: undefined unless the shape is exactly a narrow warrant. */
export function parseWarrant(raw: unknown): Warrant | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r["kind"] !== "spl-narrow" || r["v"] !== 1) return undefined;
  if (typeof r["authority"] !== "object" || !Array.isArray(r["hops"])) {
    return undefined;
  }
  try {
    return {
      v: 1,
      kind: "spl-narrow",
      authority: body(r["authority"]),
      hops: (r["hops"] as unknown[]).map(body),
    };
  } catch {
    return undefined;
  }
}

/** Remaining spendable cents, 0 when the warrant is not currently valid. */
export function remainingCents(w: unknown, now?: number): number {
  const v = verifyWarrant(w, now);
  return v.ok ? v.body.max_cents : 0;
}

/**
 * Full enforcement (mirrors credits.ts):
 *   gate.body.agent_id === caller && cost <= gate.body.max_cents && now < until
 * Deny by default on any failure.
 */
export function gateCheck(
  warrant: unknown,
  callerId: string,
  costCents: unknown,
  now?: number
): GateResult {
  if (typeof costCents !== "number" || !Number.isInteger(costCents) || costCents < 0) {
    return { ok: false, code: "WARRANT_DENIED", detail: "invalid cost_cents" };
  }
  const v = verifyWarrant(warrant, now);
  if (!v.ok) {
    const code = v.error === "warrant_expired" ? "WARRANT_EXPIRED" : "WARRANT_DENIED";
    return { ok: false, code, detail: v.error };
  }
  const b = v.body;
  if (b.agent_id !== callerId) {
    return {
      ok: false,
      code: "AGENT_MISMATCH",
      detail: `warrant names ${JSON.stringify(b.agent_id)}, caller is ${JSON.stringify(callerId)}`,
    };
  }
  if (costCents > b.max_cents) {
    return {
      ok: false,
      code: "OVER_BUDGET",
      detail: `cost ${costCents}c exceeds warrant cap ${b.max_cents}c`,
    };
  }
  return { ok: true, body: b, remaining_cents: b.max_cents };
}
