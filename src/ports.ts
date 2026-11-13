export interface ContractFacts {
  codeSize: number;
  hasSelfdestruct: boolean;
  /**
   * eip1967, zos (the older ZeppelinOS slots, used by USDC) and beacon can be repointed by an admin or beacon owner.
   * For a beacon, implementation is the beacon's address. eip1167 clones are fixed.
   */
  proxy?: { kind: "eip1967" | "zos" | "beacon" | "eip1167"; implementation: string; admin?: string };
  /** Source published and matched on Sourcify. undefined means the lookup failed, which is not the same as false. */
  verified?: boolean;
}

export interface AddressFacts {
  isContract: boolean;
  /** EIP-7702: an EOA that currently delegates to this contract. */
  delegatedTo?: string;
  txCount: number;
  balanceWei: string;
  contract?: ContractFacts;
}

export interface AddressRisk {
  address: string;
  flagged: boolean;
  labels: string[];
  source: string;
  /** unavailable means the provider failed. Policy fails closed on it. */
  status: "ok" | "unavailable" | "invalid";
  facts?: AddressFacts;
}

export interface ChainClient {
  addressRisk(address: string): Promise<AddressRisk>;
}

/** Addresses the user has sent to before. Used to catch address poisoning. */
export interface History {
  recentRecipients(account: string): Promise<string[]>;
}
