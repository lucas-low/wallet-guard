import type { TransactionRequest, TypedDataRequest } from "../domain/types";
import { type Assessment, assess, type PolicyDeps } from "../policy/engine";

/** The EIP-1193 surface a wallet or signer exposes. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export interface GuardOptions extends Pick<PolicyDeps, "chain" | "history" | "known"> {
  /** URL of the page or service asking for the signature. */
  origin: string;
  /** Asked on a warn verdict; return true to sign anyway. Without it a warning is refused. */
  onWarn?: (a: Assessment) => boolean | Promise<boolean>;
}

/** Thrown in place of signing. Code 4001 is what wallets return when the user refuses, so callers already handle it. */
export class GuardRejection extends Error {
  readonly code = 4001;
  constructor(
    message: string,
    readonly assessments: Assessment[] = [],
  ) {
    super(message);
    this.name = "GuardRejection";
  }
}

const MAINNET = 1;
type Call = { to?: string; value?: string; data?: string; input?: string };
type Unsigned = TransactionRequest | TypedDataRequest;

function transaction(c: Call): TransactionRequest {
  if (!c.to) throw new GuardRejection("contract creation is not reviewed, so it is not signed through the guard");
  return { kind: "transaction", to: c.to, valueWei: BigInt(c.value ?? "0x0").toString(), data: c.data ?? c.input ?? "0x" };
}

function typedData(raw: unknown): TypedDataRequest {
  const t = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
    primaryType?: string;
    domain?: { verifyingContract?: string; chainId?: number | string };
    message?: Record<string, unknown>;
  };
  if (t.domain?.chainId !== undefined && Number(t.domain.chainId) !== MAINNET)
    throw new GuardRejection(`typed data is for chain ${t.domain.chainId}, only mainnet is reviewed`);
  return {
    kind: "typedData",
    primaryType: t.primaryType ?? "",
    verifyingContract: t.domain?.verifyingContract ?? "",
    message: t.message ?? {},
  };
}

/** The requests a signing call would produce, or undefined when the method does not sign anything of value. */
function signingRequests(method: string, params: unknown): { from: string; requests: Unsigned[] } | undefined {
  const p = (Array.isArray(params) ? params : []) as unknown[];
  switch (method) {
    case "eth_sendTransaction":
    case "eth_signTransaction": {
      const c = p[0] as Call & { from: string };
      return { from: c.from, requests: [transaction(c)] };
    }
    case "wallet_sendCalls": {
      const b = p[0] as { from: string; calls: Call[] };
      return { from: b.from, requests: b.calls.map(transaction) };
    }
    case "eth_signTypedData_v3":
    case "eth_signTypedData_v4":
      return { from: p[0] as string, requests: [typedData(p[1])] };
    case "eth_sign":
    case "eth_signTypedData":
      throw new GuardRejection(`${method} signs data the guard cannot read, so it is refused`);
    default:
      return undefined;
  }
}

/**
 * Wraps a wallet provider so every signing request passes the policy floor first.
 * block is refused, warn is refused unless onWarn accepts it, and anything the guard cannot review is refused rather than passed through.
 */
export function guardProvider(inner: Eip1193Provider, opts: GuardOptions): Eip1193Provider {
  return {
    async request(args) {
      const signing = signingRequests(args.method, args.params);
      if (!signing) return inner.request(args);
      const chainId = Number(await inner.request({ method: "eth_chainId" }));
      if (chainId !== MAINNET) throw new GuardRejection(`the wallet is on chain ${chainId}, only mainnet is reviewed`);

      const context = { id: args.method, chainId, from: signing.from, origin: opts.origin };
      const assessments = await Promise.all(signing.requests.map((r) => assess({ ...context, ...r }, opts)));
      const reasons = (a: Assessment) => a.reasons.map((r) => r.message).join("; ");
      const blocked = assessments.filter((a) => a.verdict === "block");
      if (blocked.length) throw new GuardRejection(`blocked: ${blocked.map(reasons).join(" | ")}`, assessments);
      for (const a of assessments) {
        if (a.verdict === "warn" && !(await opts.onWarn?.(a))) throw new GuardRejection(`refused on warning: ${reasons(a)}`, assessments);
      }
      return inner.request(args);
    },
  };
}
