import known from "../data/known.json";
import { MemoryHistory, type MockAddress, MockChainClient } from "../src/adapters/chain.mock";
import type { SigningRequest } from "../src/domain/types";
import type { PolicyDeps } from "../src/policy/engine";

export const USER = "0x1111111111111111111111111111111111111111";
export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
export const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const EOA = "0x2222222222222222222222222222222222222222";
export const SHADY_PROXY = "0x7777777777777777777777777777777777777777";
export const SANCTIONED = "0x3333333333333333333333333333333333333333";
export const MAX = "f".repeat(64);

export const pad = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
export const u256 = (n: bigint) => n.toString(16).padStart(64, "0");

export function deps(book: Record<string, MockAddress> = {}, history: Record<string, string[]> = {}): PolicyDeps {
  return {
    chain: new MockChainClient({
      [PERMIT2]: { isContract: true, txCount: 1 },
      [USDC]: { isContract: true, txCount: 1 },
      [EOA]: { txCount: 4 },
      [SHADY_PROXY]: {
        isContract: true,
        txCount: 9,
        contract: { verified: false, proxy: { kind: "eip1967", implementation: "0x5555555555555555555555555555555555555555", admin: EOA } },
      },
      [SANCTIONED]: { labels: ["ofac_sanctioned"] },
      ...book,
    }),
    history: new MemoryHistory(history),
    known: known as PolicyDeps["known"],
  };
}

export function tx(over: Partial<Extract<SigningRequest, { kind: "transaction" }>> & { origin?: string } = {}): SigningRequest {
  return {
    id: "r1",
    kind: "transaction",
    chainId: 1,
    from: USER,
    origin: "https://app.uniswap.org",
    to: USDC,
    valueWei: "0",
    data: "0x",
    ...over,
  };
}

export const approveData = (spender: string, amount: string) => `0x095ea7b3${pad(spender)}${amount}`;
