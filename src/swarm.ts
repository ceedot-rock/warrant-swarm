/**
 * swarm.ts — SwarmCoordinator: a Warrant-gated agent swarm on the
 * Cloudflare Agents SDK (Durable Objects).
 *
 * State: { warrants: Record<warrantId, Warrant>, ledger: string[] }
 * Every spend attempt — approved or denied — appends a JSON line to the
 * ledger. Deny by default on any failure.
 */

import { Agent, callable } from "agents";
import { attenuate, gateCheck, issueWarrant, Warrant } from "./narrow";

export interface SwarmState {
  warrants: Record<string, Warrant>;
  ledger: string[];
}

export interface Env extends Cloudflare.Env {
  SWARM_COORDINATOR: DurableObjectNamespace<SwarmCoordinator>;
}

/** Thrown by spend() on denial; `code` is one of the gate codes. */
export class GateError extends Error {
  code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "GateError";
    this.code = code;
  }
}

export class SwarmCoordinator extends Agent<Env, SwarmState> {
  initialState: SwarmState = { warrants: {}, ledger: [] };

  private nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  private putWarrant(id: string, w: Warrant): void {
    this.setState({
      ...this.state,
      warrants: { ...this.state.warrants, [id]: w },
    });
  }

  private appendLedger(entry: Record<string, unknown>): void {
    const line = JSON.stringify({ t: this.nowSec(), ...entry });
    this.setState({ ...this.state, ledger: [...this.state.ledger, line] });
  }

  /** Start a run: issue the root warrant holding the full budget. */
  @callable()
  async startRun(args: {
    goal: string;
    budgetCents: number;
    ttlSecs: number;
  }): Promise<{ runId: string; warrant: Warrant }> {
    const runId = `run-${Date.now().toString(36)}-${Math.floor(
      Math.random() * 0xffffff
    ).toString(36)}`;
    const warrant = issueWarrant({
      agent_id: "coordinator",
      max_cents: args.budgetCents,
      until: this.nowSec() + args.ttlSecs,
    });
    this.putWarrant(runId, warrant);
    this.appendLedger({
      event: "run_started",
      runId,
      goal: args.goal,
      budgetCents: args.budgetCents,
    });
    return { runId, warrant };
  }

  /**
   * Delegate: attenuate a parent warrant into a child warrant for a
   * sub-agent. Throws WarrantError on any widening (cap or expiry).
   */
  @callable()
  async delegate(args: {
    parentId: string;
    agentId: string;
    capCents: number;
    ttlSecs: number;
  }): Promise<{ warrantId: string; warrant: Warrant }> {
    const parent = this.state.warrants[args.parentId];
    if (!parent) {
      throw new GateError("WARRANT_DENIED", `unknown parent ${args.parentId}`);
    }
    const child = attenuate(parent, {
      agent_id: args.agentId,
      max_cents: args.capCents,
      until: this.nowSec() + args.ttlSecs,
    });
    const warrantId = `${args.parentId}/${args.agentId}`;
    this.putWarrant(warrantId, child);
    this.appendLedger({
      event: "delegated",
      parentId: args.parentId,
      warrantId,
      agentId: args.agentId,
      capCents: args.capCents,
    });
    return { warrantId, warrant: child };
  }

  /**
   * Spend against a warrant. Returns {ok: true, remaining} on approval;
   * throws GateError with code OVER_BUDGET | AGENT_MISMATCH |
   * WARRANT_EXPIRED | WARRANT_DENIED on denial. Every attempt is ledgered.
   */
  @callable()
  async spend(args: {
    warrantId: string;
    callerId: string;
    costCents: number;
  }): Promise<{ ok: true; remaining: number }> {
    const warrant = this.state.warrants[args.warrantId];
    const result = warrant
      ? gateCheck(warrant, args.callerId, args.costCents, this.nowSec())
      : {
          ok: false as const,
          code: "WARRANT_DENIED",
          detail: `unknown warrant ${args.warrantId}`,
        };
    if (result.ok) {
      this.appendLedger({
        event: "spend_approved",
        warrantId: args.warrantId,
        callerId: args.callerId,
        costCents: args.costCents,
        remaining: result.remaining_cents,
      });
      return { ok: true, remaining: result.remaining_cents };
    }
    this.appendLedger({
      event: "spend_denied",
      warrantId: args.warrantId,
      callerId: args.callerId,
      costCents: args.costCents,
      code: result.code,
      detail: result.detail,
    });
    throw new GateError(result.code, result.detail);
  }

  /** Return the full signed-style audit ledger (JSON lines). */
  @callable()
  async getLedger(): Promise<string[]> {
    return this.state.ledger;
  }
}
