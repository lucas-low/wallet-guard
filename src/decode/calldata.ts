import type { Effect, SigningRequest } from "../domain/types";

/** Amounts at or above 2^255 are treated as unlimited. Wallets and dapps use 2^256-1 or close to it. */
const UNLIMITED_THRESHOLD = 1n << 255n;

const SEL = {
  approve: "0x095ea7b3", // approve(address,uint256)
  increaseAllowance: "0x39509351", // increaseAllowance(address,uint256)
  transfer: "0xa9059cbb", // transfer(address,uint256)
  transferFrom: "0x23b872dd", // transferFrom(address,address,uint256)
  setApprovalForAll: "0xa22cb465", // setApprovalForAll(address,bool)
  permit2Approve: "0x87517c45", // Permit2.approve(address,address,uint160,uint48)
} as const;

const word = (data: string, i: number) => data.slice(10 + i * 64, 10 + (i + 1) * 64);
const addrAt = (data: string, i: number) => `0x${word(data, i).slice(24)}`.toLowerCase();
const uintAt = (data: string, i: number) => BigInt(`0x${word(data, i)}`);
const isHex = (s: string) => /^0x([0-9a-fA-F]{2})*$/.test(s);

export function isUnlimited(amount: bigint): boolean {
  return amount >= UNLIMITED_THRESHOLD;
}

/** Turns calldata into the effect a user should be shown. Anything it cannot decode is reported as such, never guessed. */
export function decodeTransaction(to: string, valueWei: string, data: string): Effect {
  if (!isHex(data)) return { type: "unknown", detail: "calldata is not valid hex" };
  if (data === "0x" || data === "") return { type: "transfer_native", to: to.toLowerCase(), valueWei };
  const selector = data.slice(0, 10).toLowerCase();
  const need = (words: number) => data.length >= 10 + words * 64;
  const token = to.toLowerCase();
  switch (selector) {
    case SEL.approve:
    case SEL.increaseAllowance: {
      if (!need(2)) break;
      const amount = uintAt(data, 1);
      return { type: "approve_token", token, spender: addrAt(data, 0), amount: amount.toString(), unlimited: isUnlimited(amount) };
    }
    case SEL.transfer: {
      if (!need(2)) break;
      return { type: "transfer_token", token, to: addrAt(data, 0), amount: uintAt(data, 1).toString() };
    }
    case SEL.transferFrom: {
      if (!need(3)) break;
      return { type: "transfer_token", token, to: addrAt(data, 1), amount: uintAt(data, 2).toString() };
    }
    case SEL.setApprovalForAll: {
      if (!need(2)) break;
      return { type: "approve_all", collection: token, operator: addrAt(data, 0), approved: uintAt(data, 1) !== 0n };
    }
    case SEL.permit2Approve: {
      if (!need(4)) break;
      const amount = uintAt(data, 2);
      // Permit2 amounts are uint160, so "unlimited" means the uint160 maximum.
      return {
        type: "approve_token",
        token: addrAt(data, 0),
        spender: addrAt(data, 1),
        amount: amount.toString(),
        unlimited: amount >= 1n << 159n,
      };
    }
  }
  return { type: "contract_call", to: token, selector };
}

function str(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? String(v) : "";
}

export function decodeRequest(req: SigningRequest): Effect {
  switch (req.kind) {
    case "transaction":
      return decodeTransaction(req.to, req.valueWei, req.data);
    case "authorization":
      return { type: "delegate_account", delegateTo: req.delegateTo.toLowerCase() };
    case "typedData": {
      const m = req.message;
      if (req.primaryType === "Permit") {
        // ERC-2612: message has owner, spender, value, nonce, deadline.
        const raw = str(m.value);
        const amount = /^\d+$/.test(raw) ? BigInt(raw) : -1n;
        if (amount < 0n || !str(m.spender)) return { type: "unknown", detail: "malformed Permit message" };
        return {
          type: "permit",
          token: req.verifyingContract.toLowerCase(),
          spender: str(m.spender).toLowerCase(),
          amount: raw,
          unlimited: isUnlimited(amount),
        };
      }
      if (req.primaryType === "PermitSingle" || req.primaryType === "PermitBatch") {
        const details = (m.details ?? {}) as Record<string, unknown>;
        const raw = str(details.amount);
        const amount = /^\d+$/.test(raw) ? BigInt(raw) : -1n;
        if (amount < 0n || !str(m.spender)) return { type: "unknown", detail: `${req.primaryType}: only the single-token form is decoded` };
        return {
          type: "permit",
          token: str(details.token).toLowerCase(),
          spender: str(m.spender).toLowerCase(),
          amount: raw,
          unlimited: amount >= 1n << 159n,
        };
      }
      return { type: "unknown", detail: `typed data of type ${req.primaryType}` };
    }
  }
}
