import type { AddressRisk, ChainClient, History } from "../ports";

export interface MockAddress {
  labels?: string[];
  isContract?: boolean;
  delegatedTo?: string;
  txCount?: number;
  unavailable?: boolean;
}

/** Fixture chain for offline runs and evals. Addresses not listed look like fresh, empty EOAs. */
export class MockChainClient implements ChainClient {
  private readonly book: Map<string, MockAddress>;
  constructor(book: Record<string, MockAddress> = {}) {
    this.book = new Map(Object.entries(book).map(([k, v]) => [k.toLowerCase(), v]));
  }
  async addressRisk(address: string): Promise<AddressRisk> {
    const a = address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return { address, flagged: false, labels: [], source: "mock", status: "invalid" };
    const e = this.book.get(a) ?? {};
    if (e.unavailable) return { address, flagged: false, labels: [], source: "mock", status: "unavailable" };
    const labels = e.labels ?? [];
    return {
      address,
      flagged: labels.includes("ofac_sanctioned"),
      labels,
      source: "mock",
      status: "ok",
      facts: {
        isContract: e.isContract ?? false,
        ...(e.delegatedTo ? { delegatedTo: e.delegatedTo } : {}),
        txCount: e.txCount ?? 0,
        balanceWei: "0",
      },
    };
  }
}

export class MemoryHistory implements History {
  constructor(private readonly byAccount: Record<string, string[]> = {}) {}
  async recentRecipients(account: string): Promise<string[]> {
    return this.byAccount[account.toLowerCase()] ?? [];
  }
}
