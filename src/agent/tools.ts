import { tool } from "ai";
import { z } from "zod";
import type { SigningRequest, Verdict } from "../domain/types";
import { sanitizeUntrusted } from "../guardrails/injection";
import type { Assessment } from "../policy/engine";
import type { ChainClient } from "../ports";
import { truncate } from "../util";

export interface Review {
  verdict: Verdict;
  explanation: string;
}

export interface RunContext {
  req: SigningRequest;
  assessment: Assessment;
  dappFlagged: boolean;
  noteHandling: "quarantine" | "passthrough";
  chain: ChainClient;
  /** Filled when the agent calls submitReview. */
  slot: { review?: Review; calls: string[] };
}

/** What the agent may know about a request. Shared by the getRequest tool and the JSON fallback. */
export function requestFacts(ctx: RunContext): Record<string, unknown> {
  const { req, assessment } = ctx;
  const out: Record<string, unknown> = {
    kind: req.kind,
    chainId: req.chainId,
    effect: assessment.effect,
    origin: { host: assessment.origin.host, status: assessment.origin.status, imitates: assessment.origin.imitates ?? null },
    checks: assessment.reasons.map((r) => ({ id: r.id, verdict: r.verdict, message: r.message })),
    // Facts the rules already fetched, so the model rarely needs lookupAddress.
    addresses: Object.fromEntries(
      Object.entries(assessment.risks).map(([a, r]) => [
        a,
        {
          status: r.status,
          labels: r.labels,
          isContract: r.facts?.isContract ?? null,
          delegatedTo: r.facts?.delegatedTo ?? null,
          txCount: r.facts?.txCount ?? null,
        },
      ]),
    ),
    dappFlagged: ctx.dappFlagged,
  };
  if (ctx.noteHandling === "passthrough") {
    out.untrusted = {
      name: sanitizeUntrusted(req.dapp?.name ?? null).text,
      description: sanitizeUntrusted(req.dapp?.description ?? null).text,
    };
  }
  return out;
}

/** Read-only tools plus one that records an opinion. Nothing here can sign, send or change a verdict downward. */
export function buildTools(ctx: RunContext) {
  return {
    getRequest: tool({
      description: "What the request would do, which site asked, and what the deterministic checks found.",
      inputSchema: z.object({}),
      execute: async () => {
        ctx.slot.calls.push("getRequest");
        return requestFacts(ctx);
      },
    }),
    lookupAddress: tool({
      description: "Public facts about an address: sanctions labels, whether it is a contract, delegation, transaction count.",
      inputSchema: z.object({ address: z.string() }),
      execute: async ({ address }) => {
        ctx.slot.calls.push("lookupAddress");
        const r = await ctx.chain.addressRisk(address);
        return { address, status: r.status, flagged: r.flagged, labels: r.labels, facts: r.facts ?? null };
      },
    }),
    submitReview: tool({
      description: "Record your verdict once. It can only raise the outcome above the deterministic checks.",
      inputSchema: z.object({ verdict: z.enum(["allow", "warn", "block"]), explanation: z.string().min(1) }),
      execute: async ({ verdict, explanation }) => {
        ctx.slot.calls.push("submitReview");
        if (ctx.slot.review) return { ok: false, error: "already submitted" };
        ctx.slot.review = { verdict, explanation: truncate(explanation, 300) };
        return { ok: true };
      },
    }),
  };
}
