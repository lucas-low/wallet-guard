import { describe, expect, test } from "bun:test";
import { OnchainChainClient, readAddressFacts } from "../src/adapters/chain.onchain";
import { inspectBytecode } from "../src/guardrails/bytecode";
import { assess } from "../src/policy/engine";
import { approveData, deps, PERMIT2, tx, u256 } from "./helpers";

const SPENDER = "0x4444444444444444444444444444444444444444";
const IMPL = "0x5555555555555555555555555555555555555555";
const ADMIN = "0x6666666666666666666666666666666666666666";
const word = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
const ZERO = `0x${"0".repeat(64)}`;
const ids = (a: Awaited<ReturnType<typeof assess>>) => a.reasons.map((r) => r.id);

describe("inspectBytecode", () => {
  test("finds SELFDESTRUCT as an opcode", () => {
    const b = inspectBytecode("0x6000ff");
    expect(b).toMatchObject({ hasSelfdestruct: true });
  });
  test("bytes inside PUSH data are not opcodes", () => {
    // PUSH2 0xffff, then STOP. The 0xff bytes are data, not SELFDESTRUCT.
    expect(inspectBytecode("0x61ffff00")).toMatchObject({ hasSelfdestruct: false });
  });
  test("compiler metadata is stripped before the scan", () => {
    // STOP, then a CBOR map (a1) holding 0xff, then the 2-byte length 0x0003.
    const b = inspectBytecode("0x00a164ff0003");
    expect(b.hasSelfdestruct).toBe(false);
    expect(b.size).toBe(1);
  });
  test("EIP-1167 clone exposes its target", () => {
    const code = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    expect(inspectBytecode(code).minimalProxyTarget).toBe(IMPL);
  });
  test("garbage gives an empty result, not a throw", () => {
    expect(inspectBytecode("0xzz")).toEqual({ size: 0, hasSelfdestruct: false });
    expect(inspectBytecode("0x")).toEqual({ size: 0, hasSelfdestruct: false });
  });
});

function rpc(opts: {
  code: string;
  impl?: string;
  admin?: string;
  beacon?: string;
  zosImpl?: string;
  storageFails?: boolean;
  sourcify?: number | "throw";
  onSourcify?: (url: string) => void;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("sourcify")) {
      opts.onSourcify?.(u);
      if (opts.sourcify === "throw") throw new Error("down");
      return new Response("{}", { status: opts.sourcify ?? 404 });
    }
    const { id, method, params } = JSON.parse(String(init?.body));
    const result = (r: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result: r }));
    if (method === "eth_getCode") return result(opts.code);
    if (method === "eth_getTransactionCount") return result("0x1");
    if (method === "eth_getBalance") return result("0x0");
    if (opts.storageFails) return new Response("{}", { status: 500 });
    const slot = (params as string[])[1] as string;
    const by: Record<string, string | undefined> = {
      "0x3608": opts.impl,
      "0xb531": opts.admin,
      "0xa3f0": opts.beacon,
      "0x7050": opts.zosImpl,
    };
    return result(word(by[slot.slice(0, 6)] ?? ZERO));
  }) as typeof fetch;
}

describe("on-chain contract facts", () => {
  test("reads an EIP-1967 proxy, its admin and Sourcify status", async () => {
    const f = await readAddressFacts(SPENDER, { url: "x", fetch: rpc({ code: "0x6000", impl: IMPL, admin: ADMIN, sourcify: 200 }) });
    expect(f.contract).toMatchObject({ proxy: { kind: "eip1967", implementation: IMPL, admin: ADMIN }, verified: true });
  });
  test("reads a ZeppelinOS-slot proxy, the layout USDC uses", async () => {
    const f = await readAddressFacts(SPENDER, { url: "x", fetch: rpc({ code: "0x6000", zosImpl: IMPL }) });
    expect(f.contract?.proxy).toEqual({ kind: "zos", implementation: IMPL });
  });
  test("reads a beacon proxy", async () => {
    const f = await readAddressFacts(SPENDER, { url: "x", fetch: rpc({ code: "0x6000", beacon: IMPL }) });
    expect(f.contract?.proxy).toEqual({ kind: "beacon", implementation: IMPL });
  });
  test("the Sourcify lookup lowercases the address, which it requires", async () => {
    let seen = "";
    await readAddressFacts("0xA0b86991c6218b36c1d19d4a2e9eB0cE3606eB48", {
      url: "x",
      fetch: rpc({ code: "0x6000", onSourcify: (u) => (seen = u) }),
    });
    expect(seen.endsWith("/v2/contract/1/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBe(true);
  });
  test("an unverified contract reads as verified false", async () => {
    const f = await readAddressFacts(SPENDER, { url: "x", fetch: rpc({ code: "0x6000", sourcify: 404 }) });
    expect(f.contract?.verified).toBe(false);
  });
  test("a failed Sourcify lookup leaves verified unset instead of false", async () => {
    const f = await readAddressFacts(SPENDER, { url: "x", fetch: rpc({ code: "0x6000", sourcify: "throw" }) });
    expect(f.contract).toBeDefined();
    expect(f.contract?.verified).toBeUndefined();
  });
  test("failed storage reads do not fail the whole lookup", async () => {
    const f = await readAddressFacts(SPENDER, { url: "x", fetch: rpc({ code: "0x6000", storageFails: true, sourcify: 200 }) });
    expect(f.isContract).toBe(true);
    expect(f.contract?.proxy).toBeUndefined();
  });
  test("an EOA gets no contract facts and no Sourcify call", async () => {
    let sourcifyCalls = 0;
    const inner = rpc({ code: "0x" });
    const f = await readAddressFacts(SPENDER, {
      url: "x",
      fetch: ((u: string, i?: RequestInit) => {
        if (String(u).includes("sourcify")) sourcifyCalls++;
        return inner(u, i);
      }) as typeof fetch,
    });
    expect(f.contract).toBeUndefined();
    expect(sourcifyCalls).toBe(0);
  });
  test("sourcifyUrl null switches the lookup off", async () => {
    const f = await readAddressFacts(SPENDER, { url: "x", sourcifyUrl: null, fetch: rpc({ code: "0x6000", sourcify: 404 }) });
    expect(f.contract?.verified).toBeUndefined();
  });
  test("the client passes the facts through to policy", async () => {
    const client = new OnchainChainClient(new Set(), { url: "x", fetch: rpc({ code: "0x6000", impl: IMPL, sourcify: 404 }) });
    const r = await client.addressRisk(SPENDER);
    expect(r.facts?.contract?.proxy?.kind).toBe("eip1967");
  });
});

describe("policy on contract traits", () => {
  const approve = (book: Parameters<typeof deps>[0]) =>
    assess(tx({ origin: "https://app.uniswap.org", data: approveData(SPENDER, u256(1000n)) }), deps(book));

  test("a bounded approval to an unverified upgradeable contract is warned, with both reasons", async () => {
    const a = await approve({
      [SPENDER]: {
        isContract: true,
        txCount: 5,
        contract: { verified: false, proxy: { kind: "eip1967", implementation: IMPL, admin: ADMIN } },
      },
    });
    expect(a.verdict).toBe("warn");
    expect(ids(a)).toEqual(expect.arrayContaining(["UNVERIFIED_CONTRACT", "UPGRADEABLE_CONTRACT"]));
  });
  test("SELFDESTRUCT in the spender is warned", async () => {
    const a = await approve({ [SPENDER]: { isContract: true, txCount: 5, contract: { hasSelfdestruct: true } } });
    expect(ids(a)).toContain("SELFDESTRUCT_CONTRACT");
  });
  test("zos and beacon proxies count as upgradeable", async () => {
    for (const kind of ["zos", "beacon"] as const) {
      const a = await approve({ [SPENDER]: { isContract: true, txCount: 5, contract: { proxy: { kind, implementation: IMPL } } } });
      expect(ids(a)).toContain("UPGRADEABLE_CONTRACT");
    }
  });
  test("an unknown clone is not called upgradeable", async () => {
    const a = await approve({
      [SPENDER]: { isContract: true, txCount: 5, contract: { proxy: { kind: "eip1167", implementation: IMPL } } },
    });
    expect(ids(a)).not.toContain("UPGRADEABLE_CONTRACT");
  });
  test("unknown verification status adds no reason", async () => {
    const a = await approve({ [SPENDER]: { isContract: true, txCount: 5 } });
    expect(ids(a)).not.toContain("UNVERIFIED_CONTRACT");
  });
  test("a known protocol is exempt: the curated list vouches for it", async () => {
    const a = await assess(
      tx({ data: approveData(PERMIT2, u256(1000n)) }),
      deps({
        [PERMIT2]: {
          isContract: true,
          txCount: 1,
          contract: { verified: false, hasSelfdestruct: true, proxy: { kind: "eip1967", implementation: IMPL } },
        },
      }),
    );
    expect(a.verdict).toBe("allow");
  });
  test("the rule can be switched off for ablation", async () => {
    const d = deps({ [SPENDER]: { isContract: true, txCount: 5, contract: { verified: false } } });
    const a = await assess(tx({ data: approveData(SPENDER, u256(1000n)) }), { ...d, disabledRules: ["UNVERIFIED_CONTRACT"] });
    expect(ids(a)).not.toContain("UNVERIFIED_CONTRACT");
  });
});
