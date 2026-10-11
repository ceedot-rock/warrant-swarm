/**
 * index.ts — Worker entrypoint.
 * Routes agent traffic via the Agents SDK and serves GET /demo:
 * a self-contained scenario proving the Warrant gate end to end.
 */

import { getAgentByName, routeAgentRequest } from "agents";
import { SwarmCoordinator, Env } from "./swarm";

export { SwarmCoordinator };

/** Extract a gate code from a thrown error (RPC may or may not keep `code`). */
function errCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  if (typeof c === "string" && c.length > 0) return c;
  const m = e instanceof Error ? e.message : String(e);
  const prefix = m.split(":")[0].trim();
  return prefix.length > 0 ? prefix : "UNKNOWN";
}

async function demoHandler(env: Env): Promise<Response> {
  const steps: Record<string, unknown>[] = [];
  // Fresh agent instance per demo request: each transcript is self-contained,
  // while Durable Object persistence keeps each run's ledger durable.
  const agent = await getAgentByName<Env, SwarmCoordinator>(
    env.SWARM_COORDINATOR,
    `demo-${Date.now().toString(36)}`
  );

  // 1. Root run with a 100c budget.
  const { runId, warrant } = await agent.startRun({
    goal: "demo run",
    budgetCents: 100,
    ttlSecs: 3600,
  });
  steps.push({
    step: "startRun",
    runId,
    rootCapCents: warrant.authority.max_cents,
  });

  // 2. Attenuate 100c -> 40c -> 15c down the delegation chain.
  const d1 = await agent.delegate({
    parentId: runId,
    agentId: "researcher",
    capCents: 40,
    ttlSecs: 1800,
  });
  steps.push({ step: "delegate", warrantId: d1.warrantId, capCents: 40 });

  const d2 = await agent.delegate({
    parentId: d1.warrantId,
    agentId: "leaf",
    capCents: 15,
    ttlSecs: 900,
  });
  steps.push({ step: "delegate", warrantId: d2.warrantId, capCents: 15 });

  // 3. Approved spend: 10c against the 15c leaf warrant.
  const approved = await agent.spend({
    warrantId: d2.warrantId,
    callerId: "leaf",
    costCents: 10,
  });
  steps.push({
    step: "spend",
    costCents: 10,
    result: "APPROVED",
    remainingCents: approved.remaining,
  });

  // 4. Denied spend: 50c against the 15c leaf warrant.
  let denied: Record<string, unknown>;
  try {
    await agent.spend({
      warrantId: d2.warrantId,
      callerId: "leaf",
      costCents: 50,
    });
    denied = { result: "APPROVED-UNEXPECTED" };
  } catch (e) {
    denied = {
      result: "DENIED",
      code: errCode(e),
      message: e instanceof Error ? e.message : String(e),
    };
  }
  steps.push({ step: "spend", costCents: 50, ...denied });

  // 5. Widening attempt: 200c child of the 100c root must throw.
  let widened: Record<string, unknown>;
  try {
    await agent.delegate({
      parentId: runId,
      agentId: "greedy",
      capCents: 200,
      ttlSecs: 600,
    });
    widened = { result: "WIDENED-UNEXPECTED" };
  } catch (e) {
    widened = {
      result: "REJECTED",
      code: errCode(e),
      message: e instanceof Error ? e.message : String(e),
    };
  }
  steps.push({ step: "delegate", capCents: 200, ...widened });

  // 6. Full audit ledger.
  const ledger = await agent.getLedger();

  return Response.json({
    scenario: "warranted-swarm demo",
    attenuation: [100, 40, 15],
    steps,
    ledger,
    ledgerLines: ledger.length,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/demo" && request.method === "GET") {
      return demoHandler(env);
    }
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  },
};
