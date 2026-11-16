import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspectBytecode } from "../guardrails/bytecode";
import type { AddressFacts, AddressRisk, ChainClient, ContractFacts } from "../ports";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function parseSanctionList(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => ADDRESS_RE.test(l))
      .map((l) => l.toLowerCase()),
  );
}

export function loadSanctionList(path = fileURLToPath(new URL("../../data/ofac-eth.txt", import.meta.url))): Set<string> {
  return parseSanctionList(readFileSync(path, "utf8"));
}

export interface RpcOptions {
  url: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Used for the Sourcify lookup. Default 1. */
  chainId?: number;
  /** Sourcify server root. null switches the verification lookup off. */
  sourcifyUrl?: string | null;
}

const EIP1967_IMPLEMENTATION = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
// keccak256("org.zeppelinos.proxy.implementation") and "...admin", from before EIP-1967.
const ZOS_IMPLEMENTATION = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const ZOS_ADMIN = "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b";

/** A storage slot that holds an address: the last 20 bytes, or undefined when empty. */
function slotAddress(word: string): string | undefined {
  const hex = word.replace(/^0x/, "").padStart(64, "0");
  return /^0+$/.test(hex) ? undefined : `0x${hex.slice(24)}`;
}

/** true or false when Sourcify answers, undefined when it does not. A failed lookup never reads as "unverified". */
async function isVerified(address: string, opts: RpcOptions): Promise<boolean | undefined> {
  if (opts.sourcifyUrl === null) return undefined;
  try {
    const res = await (opts.fetch ?? fetch)(
      `${opts.sourcifyUrl ?? "https://sourcify.dev/server"}/v2/contract/${opts.chainId ?? 1}/${address.toLowerCase()}`,
      {
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      },
    );
    if (res.status === 200) return true;
    if (res.status === 404) return false;
  } catch {}
  return undefined;
}

/** Bytecode, proxy slots and source verification for a contract. Each lookup that fails is left out, not guessed. */
async function readContractFacts(
  address: string,
  code: string,
  call: (id: number, method: string, params: unknown[]) => Promise<string>,
  opts: RpcOptions,
): Promise<ContractFacts> {
  const bc = inspectBytecode(code);
  const slot = (id: number, s: string) => call(id, "eth_getStorageAt", [address, s, "latest"]).then(slotAddress, () => undefined);
  const [impl, admin, beacon, zosImpl, zosAdmin, verified] = await Promise.all([
    slot(4, EIP1967_IMPLEMENTATION),
    slot(5, EIP1967_ADMIN),
    slot(6, EIP1967_BEACON),
    slot(7, ZOS_IMPLEMENTATION),
    slot(8, ZOS_ADMIN),
    isVerified(address, opts),
  ]);
  const proxy: ContractFacts["proxy"] = impl
    ? { kind: "eip1967", implementation: impl, ...(admin ? { admin } : {}) }
    : beacon
      ? { kind: "beacon", implementation: beacon }
      : zosImpl
        ? { kind: "zos", implementation: zosImpl, ...(zosAdmin ? { admin: zosAdmin } : {}) }
        : bc.minimalProxyTarget
          ? { kind: "eip1167", implementation: bc.minimalProxyTarget }
          : undefined;
  return {
    codeSize: bc.size,
    hasSelfdestruct: bc.hasSelfdestruct,
    ...(proxy ? { proxy } : {}),
    ...(verified === undefined ? {} : { verified }),
  };
}

/** Reads public facts about an address from any Ethereum JSON-RPC endpoint. */
export async function readAddressFacts(address: string, opts: RpcOptions): Promise<AddressFacts> {
  const doFetch = opts.fetch ?? fetch;
  const call = async (id: number, method: string, params: unknown[]) => {
    const res = await doFetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) throw new Error(`rpc ${method}: http ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (body.error || typeof body.result !== "string") throw new Error(`rpc ${method}: ${body.error?.message ?? "no result"}`);
    return body.result;
  };
  const [code, nonce, balance] = await Promise.all([
    call(1, "eth_getCode", [address, "latest"]),
    call(2, "eth_getTransactionCount", [address, "latest"]),
    call(3, "eth_getBalance", [address, "latest"]),
  ]);
  // EIP-7702: a delegated EOA has exactly 23 bytes of code, 0xef0100 followed by the delegate address.
  const delegated = /^0xef0100[0-9a-fA-F]{40}$/.test(code);
  const isContract = !delegated && code !== "0x" && code !== "0x0";
  return {
    isContract,
    ...(delegated ? { delegatedTo: `0x${code.slice(8)}` } : {}),
    txCount: Number.parseInt(nonce, 16),
    balanceWei: BigInt(balance).toString(),
    ...(isContract ? { contract: await readContractFacts(address, code, call, opts) } : {}),
  };
}

/**
 * Real public data: the OFAC sanctions list (local file) plus on-chain facts from a public RPC.
 * It never throws. A provider failure returns status "unavailable" and policy fails closed on it.
 */
export class OnchainChainClient implements ChainClient {
  constructor(
    private readonly sanctioned: Set<string>,
    private readonly rpc: RpcOptions,
  ) {}

  async addressRisk(address: string): Promise<AddressRisk> {
    if (!ADDRESS_RE.test(address)) return { address, flagged: false, labels: [], source: "onchain", status: "invalid" };
    const labels = this.sanctioned.has(address.toLowerCase()) ? ["ofac_sanctioned"] : [];
    try {
      const facts = await readAddressFacts(address, this.rpc);
      return { address, flagged: labels.length > 0, labels, source: "ofac+rpc", status: "ok", facts };
    } catch {
      // The sanctions list is local, so a hit is still reported even when the RPC is down.
      return { address, flagged: labels.length > 0, labels, source: "ofac", status: labels.length ? "ok" : "unavailable" };
    }
  }
}
