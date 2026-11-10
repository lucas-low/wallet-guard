/** A request a dapp makes to the wallet. The wallet asks the guard before showing the signing prompt. */
export type SigningRequest = (TransactionRequest | TypedDataRequest | AuthorizationRequest) & RequestContext;

export interface RequestContext {
  id: string;
  chainId: number;
  from: string;
  /** Page URL that initiated the request. Comes from the browser, so it is trusted for host checks. */
  origin: string;
  /** Text the dapp supplies about itself. Untrusted: attackers control it. */
  dapp?: { name?: string; description?: string };
}

export interface TransactionRequest {
  kind: "transaction";
  to: string;
  /** Wei, decimal string. */
  valueWei: string;
  data: string;
}

/** eth_signTypedData_v4 payloads such as ERC-2612 permits and Permit2 allowances. */
export interface TypedDataRequest {
  kind: "typedData";
  primaryType: string;
  verifyingContract: string;
  message: Record<string, unknown>;
}

/** EIP-7702: authorises an account to run a contract's code. */
export interface AuthorizationRequest {
  kind: "authorization";
  delegateTo: string;
}

export type Verdict = "allow" | "warn" | "block";
export const VERDICT_RANK: Record<Verdict, number> = { allow: 0, warn: 1, block: 2 };

export function stricter(a: Verdict, b: Verdict): Verdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

export interface Reason {
  id: string;
  verdict: Verdict;
  message: string;
}

/** What the request would do once signed, in plain terms. */
export type Effect =
  | { type: "transfer_native"; to: string; valueWei: string }
  | { type: "transfer_token"; token: string; to: string; amount: string }
  | { type: "approve_token"; token: string; spender: string; amount: string; unlimited: boolean }
  | { type: "approve_all"; collection: string; operator: string; approved: boolean }
  | { type: "permit"; token: string; spender: string; amount: string; unlimited: boolean }
  | { type: "delegate_account"; delegateTo: string }
  | { type: "contract_call"; to: string; selector: string }
  | { type: "unknown"; detail: string };
