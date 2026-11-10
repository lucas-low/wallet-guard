export interface AddressFacts {
  isContract: boolean;
  /** EIP-7702: an EOA that currently delegates to this contract. */
  delegatedTo?: string;
  txCount: number;
  balanceWei: string;
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
