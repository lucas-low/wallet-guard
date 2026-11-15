import { z } from "zod";
import { MemoryHistory } from "../adapters/chain.mock";
import type { SigningRequest } from "../domain/types";
import { assess, type PolicyDeps } from "../policy/engine";
import type { AddressRisk, ChainClient } from "../ports";

const address = z.string().describe("0x-prefixed 20-byte address");
const context = {
  chainId: z.number().int().default(1),
  from: address.describe("The user's account"),
  origin: z.string().describe("Page URL that made the request, as reported by the browser or wallet"),
  recentRecipients: z.array(address).default([]).describe("Addresses this account has paid before, for address-poisoning checks"),
};

/** Shape of one signing request. Dapp-supplied text is deliberately not accepted: the floor does not need it. */
export const requestShape = {
  ...context,
  request: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("transaction"), to: address, valueWei: z.string().default("0"), data: z.string().default("0x") }),
    z.object({
      kind: z.literal("typedData"),
      primaryType: z.string(),
      verifyingContract: address,
      message: z.record(z.string(), z.unknown()),
    }),
    z.object({ kind: z.literal("authorization"), delegateTo: address }),
  ]),
};

export const addressShape = { address };

export type ReviewInput = z.infer<z.ZodObject<typeof requestShape>>;

/** Deterministic floor only: no model, so the answer is the same every time and cannot be talked around. */
export async function reviewRequest(input: ReviewInput, deps: Pick<PolicyDeps, "chain" | "known">) {
  const req = { id: "mcp", chainId: input.chainId, from: input.from, origin: input.origin, ...input.request } as SigningRequest;
  const a = await assess(req, { ...deps, history: new MemoryHistory({ [input.from.toLowerCase()]: input.recentRecipients }) });
  return {
    verdict: a.verdict,
    reasons: a.reasons,
    effect: a.effect,
    origin: { host: a.origin.host, status: a.origin.status },
    basis: "deterministic policy floor, no model. A known-list miss is a warning, not proof of risk.",
  };
}

export async function inspectAddress(addr: string, chain: ChainClient): Promise<AddressRisk> {
  return chain.addressRisk(addr);
}
