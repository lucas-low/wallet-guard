import { decodeRequest } from "../decode/calldata";
import { type Effect, type Reason, type SigningRequest, stricter, type Verdict } from "../domain/types";
import { checkOrigin, type OriginResult } from "../guardrails/origin";
import { findPoisoning } from "../guardrails/poisoning";
import type { AddressRisk, ChainClient, History } from "../ports";

export interface Known {
  domains: string[];
  spenders: Record<string, string>;
  tokens: Record<string, string>;
}

export interface Assessment {
  effect: Effect;
  origin: OriginResult;
  verdict: Verdict;
  reasons: Reason[];
  /** Risk lookups the rules used, keyed by lowercase address. Passed on to the agent so it does not refetch. */
  risks: Record<string, AddressRisk>;
}

export interface PolicyDeps {
  chain: ChainClient;
  history: History;
  known: Known;
  /** Rule ids to switch off. Used by evals to measure what a rule is worth. */
  disabledRules?: string[];
}

/** Addresses that need a lookup for this effect. */
function counterparties(e: Effect): string[] {
  switch (e.type) {
    case "transfer_native":
      return [e.to];
    case "transfer_token":
      return [e.to, e.token];
    case "approve_token":
    case "permit":
      return [e.spender, e.token];
    case "approve_all":
      return [e.operator, e.collection];
    case "delegate_account":
      return [e.delegateTo];
    case "contract_call":
      return [e.to];
    default:
      return [];
  }
}

/**
 * Deterministic floor. It runs before any model and its verdict can only be made stricter by the agent, never relaxed.
 * Order matters only for the reason list. The verdict is the strictest rule that fired.
 */
export async function assess(req: SigningRequest, deps: PolicyDeps): Promise<Assessment> {
  const effect = decodeRequest(req);
  const origin = checkOrigin(req.origin, deps.known.domains);
  const off = new Set(deps.disabledRules ?? []);
  const reasons: Reason[] = [];
  const add = (id: string, verdict: Verdict, message: string) => {
    if (!off.has(id)) reasons.push({ id, verdict, message });
  };

  const addrs = [...new Set(counterparties(effect).map((a) => a.toLowerCase()))];
  const risks: Record<string, AddressRisk> = {};
  await Promise.all(
    addrs.map(async (a) => {
      risks[a] = await deps.chain.addressRisk(a);
    }),
  );
  const spenderKnown = (a: string) => a.toLowerCase() in deps.known.spenders;
  // Properties of the contract being given access. A known protocol is vouched for by the curated list, so these only apply to strangers.
  const contractTraits = (addr: string) => {
    const a = addr.toLowerCase();
    const c = risks[a]?.facts?.contract;
    if (!c || spenderKnown(a)) return;
    if (c.verified === false) add("UNVERIFIED_CONTRACT", "warn", "Sourcify has no verified source for this contract");
    if (c.proxy && c.proxy.kind !== "eip1167")
      add(
        "UPGRADEABLE_CONTRACT",
        "warn",
        `an upgradeable proxy: ${c.proxy.admin ?? "its admin or beacon owner"} can swap the code it runs after you approve it`,
      );
    if (c.hasSelfdestruct)
      add("SELFDESTRUCT_CONTRACT", "warn", "the code contains SELFDESTRUCT, which can send out the contract's whole balance when called");
  };

  for (const [a, r] of Object.entries(risks)) {
    if (r.status === "invalid") add("INVALID_ADDRESS", "block", `${a} is not a valid address`);
    else if (r.status === "unavailable") add("CHAIN_DATA_UNAVAILABLE", "warn", `could not look up ${a}, so it cannot be cleared`);
    if (r.flagged) add("SANCTIONED_COUNTERPARTY", "block", `${a} is on the OFAC sanctions list`);
  }

  switch (effect.type) {
    case "approve_token":
    case "permit": {
      const spender = effect.spender.toLowerCase();
      const r = risks[spender];
      const known = spenderKnown(spender);
      if (effect.unlimited)
        add(
          "UNLIMITED_APPROVAL",
          known ? "warn" : "block",
          `unlimited allowance to ${known ? deps.known.spenders[spender] : "an unknown spender"}`,
        );
      if (!known && r?.status === "ok" && r.facts && !r.facts.isContract && !r.facts.delegatedTo)
        add("APPROVAL_TO_EOA", "block", "the spender is a plain wallet address, not a contract, which is how drainers collect allowances");
      if (!known) add("SPENDER_UNKNOWN", "warn", "the spender is not a known protocol");
      contractTraits(spender);
      break;
    }
    case "approve_all": {
      if (!effect.approved) break;
      const op = effect.operator.toLowerCase();
      add(
        "APPROVAL_FOR_ALL",
        spenderKnown(op) ? "warn" : "block",
        spenderKnown(op)
          ? "gives a known marketplace control of every item in the collection"
          : "gives an unknown address control of every item in the collection",
      );
      contractTraits(op);
      break;
    }
    case "delegate_account": {
      const d = effect.delegateTo.toLowerCase();
      if (!spenderKnown(d)) add("DELEGATION_TO_UNKNOWN", "block", "an EIP-7702 delegation lets that contract's code run as your account");
      else add("DELEGATION_REVIEW", "warn", "delegates your account to a known contract");
      break;
    }
    case "transfer_native":
    case "transfer_token": {
      const recent = await deps.history.recentRecipients(req.from);
      const hit = findPoisoning(effect.to, recent);
      if (hit)
        add(
          "ADDRESS_POISONING",
          "block",
          `${hit.candidate} imitates ${hit.lookalikeOf}, an address you paid before, but is a different address`,
        );
      const r = risks[effect.to.toLowerCase()];
      if (r?.status === "ok" && r.facts && r.facts.txCount === 0 && !recent.map((x) => x.toLowerCase()).includes(effect.to.toLowerCase()))
        add("FIRST_TIME_RECIPIENT", "warn", "you have not paid this address before and it has no history on chain");
      break;
    }
    case "contract_call": {
      const r = risks[effect.to.toLowerCase()];
      const valueWei = req.kind === "transaction" ? BigInt(req.valueWei || "0") : 0n;
      if (valueWei > 0n && !spenderKnown(effect.to) && r?.status === "ok" && r.facts?.isContract)
        add("VALUE_TO_UNKNOWN_CONTRACT", "warn", "sends value to a contract that is not a known protocol");
      break;
    }
    case "unknown":
      add("UNDECODABLE", "warn", `could not decode this request (${effect.detail})`);
      break;
  }

  switch (origin.status) {
    case "lookalike":
      add("ORIGIN_LOOKALIKE", "block", `${origin.host} imitates ${origin.imitates ?? "a known site"} (${origin.detail})`);
      break;
    case "insecure":
      add("ORIGIN_INSECURE", "warn", `${origin.host}: ${origin.detail}`);
      break;
    case "invalid":
      add("ORIGIN_INVALID", "block", "the request has no usable page origin");
      break;
    case "unknown":
      // An unknown site is the normal case for new dapps. It only matters once a risky effect is on the table.
      if (["approve_token", "permit", "approve_all", "delegate_account"].includes(effect.type))
        add("ORIGIN_UNKNOWN", "warn", `${origin.host} is not a site the guard knows, and this request grants access to your assets`);
      break;
  }

  const verdict = reasons.reduce<Verdict>((v, r) => stricter(v, r.verdict), "allow");
  return { effect, origin, verdict, reasons, risks };
}
