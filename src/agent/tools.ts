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

/** Read-only tools plus one that records an opinion. Nothing here can sign, send or change a verdict downward. */
export function buildTools(ctx: RunContext) {
  const { req, assessment } = ctx;
  return {
    getRequest: tool({
      description: "What the request would do, which site asked, and what the deterministic checks found.",
      inputSchema: z.object({}),
      execute: async () => {
        ctx.slot.calls.push("getRequest");
        const out: Record<string, unknown> = {
          kind: req.kind,
          chainId: req.chainId,
          effect: assessment.effect,
          origin: { host: assessment.origin.host, status: assessment.origin.status, imitates: assessment.origin.imitates ?? null },
          checks: assessment.reasons.map((r) => ({ id: r.id, verdict: r.verdict, message: r.message })),
          dappFlagged: ctx.dappFlagged,
        };
        if (ctx.noteHandling === "passthrough") {
          out.untrusted = {
            name: sanitizeUntrusted(req.dapp?.name ?? null).text,
            description: sanitizeUntrusted(req.dapp?.description ?? null).text,
          };
        }
        return out;
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
