import { describe, expect, test } from "bun:test";
import known from "../data/known.json";
import { assess } from "../src/policy/engine";
import { approveData, deps, EOA, MAX, PERMIT2, pad, SANCTIONED, tx, USDC, USER, u256 } from "./helpers";

const ids = (a: Awaited<ReturnType<typeof assess>>) => a.reasons.map((r) => r.id);

describe("decoding", () => {
  test("plain native transfer", async () => {
    const a = await assess(tx({ to: EOA, valueWei: "1000", data: "0x" }), deps());
    expect(a.effect).toEqual({ type: "transfer_native", to: EOA, valueWei: "1000" });
  });
  test("approve decodes spender and amount", async () => {
    const a = await assess(tx({ data: approveData(PERMIT2, u256(5n)) }), deps());
    expect(a.effect).toMatchObject({ type: "approve_token", spender: PERMIT2, amount: "5", unlimited: false });
  });
  test("truncated calldata is a contract call, not a crash", async () => {
    const a = await assess(tx({ data: "0x095ea7b3abcd" }), deps());
    expect(a.effect.type).toBe("contract_call");
  });
  test("non-hex data is reported as unknown and warned", async () => {
    const a = await assess(tx({ data: "0xzz" }), deps());
    expect(a.effect.type).toBe("unknown");
    expect(ids(a)).toContain("UNDECODABLE");
  });
});

describe("approvals", () => {
  test("bounded approval to a known router on a known site is allowed", async () => {
    const a = await assess(tx({ data: approveData(PERMIT2, u256(1000n)) }), deps());
    expect(a.verdict).toBe("allow");
  });
  test("unlimited approval to a known spender is a warning", async () => {
    const a = await assess(tx({ data: approveData(PERMIT2, MAX) }), deps());
    expect(a.verdict).toBe("warn");
    expect(ids(a)).toContain("UNLIMITED_APPROVAL");
  });
  test("unlimited approval to an unknown spender is blocked", async () => {
    const a = await assess(tx({ data: approveData(EOA, MAX) }), deps());
    expect(a.verdict).toBe("block");
    expect(ids(a)).toEqual(expect.arrayContaining(["UNLIMITED_APPROVAL", "APPROVAL_TO_EOA"]));
  });
  test("unlimited approval to a verified contract that is not known is a warning", async () => {
    const c = "0x4444444444444444444444444444444444444444";
    const a = await assess(
      tx({ data: approveData(c, MAX) }),
      deps({ [c]: { isContract: true, txCount: 9, contract: { verified: true } } }),
    );
    expect(a.verdict).toBe("warn");
  });
  test("unlimited approval to an unverified contract is blocked", async () => {
    const c = "0x4444444444444444444444444444444444444444";
    const a = await assess(
      tx({ data: approveData(c, MAX) }),
      deps({ [c]: { isContract: true, txCount: 9, contract: { verified: false } } }),
    );
    expect(a.verdict).toBe("block");
  });
  test("unlimited approval is blocked when verification could not be checked", async () => {
    const c = "0x4444444444444444444444444444444444444444";
    const a = await assess(tx({ data: approveData(c, MAX) }), deps({ [c]: { isContract: true, txCount: 9, contract: {} } }));
    expect(a.verdict).toBe("block");
  });
  test("bounded approval to an unknown contract warns", async () => {
    const c = "0x4444444444444444444444444444444444444444";
    const a = await assess(tx({ data: approveData(c, u256(10n)) }), deps({ [c]: { isContract: true, txCount: 9 } }));
    expect(a.verdict).toBe("warn");
    expect(ids(a)).toContain("SPENDER_UNKNOWN");
  });
  test("setApprovalForAll to an unknown operator is blocked, revoke is not", async () => {
    const grant = `0xa22cb465${pad(EOA)}${u256(1n)}`;
    const revoke = `0xa22cb465${pad(EOA)}${u256(0n)}`;
    expect((await assess(tx({ data: grant }), deps())).verdict).toBe("block");
    expect((await assess(tx({ data: revoke }), deps())).verdict).toBe("allow");
  });
  test("the chain lookup failing fails closed to warn", async () => {
    const a = await assess(tx({ data: approveData(EOA, u256(1n)) }), deps({ [EOA]: { unavailable: true } }));
    expect(ids(a)).toContain("CHAIN_DATA_UNAVAILABLE");
    expect(a.verdict).not.toBe("allow");
  });
});

describe("typed data and delegation", () => {
  const permit = (value: string, spender: string) =>
    ({
      id: "r",
      kind: "typedData",
      chainId: 1,
      from: USER,
      origin: "https://app.uniswap.org",
      primaryType: "Permit",
      verifyingContract: USDC,
      message: { owner: USER, spender, value, nonce: "0", deadline: "9999999999" },
    }) as const;
  test("an unlimited permit to an unknown spender is blocked", async () => {
    const a = await assess(permit((2n ** 256n - 1n).toString(), EOA), deps());
    expect(a.effect).toMatchObject({ type: "permit", unlimited: true });
    expect(a.verdict).toBe("block");
  });
  test("a small permit to Permit2 is allowed", async () => {
    expect((await assess(permit("1000", PERMIT2), deps())).verdict).toBe("allow");
  });
  test("an EIP-7702 delegation to an unknown contract is blocked", async () => {
    const a = await assess(
      { id: "r", kind: "authorization", chainId: 1, from: USER, origin: "https://app.uniswap.org", delegateTo: EOA },
      deps(),
    );
    expect(ids(a)).toContain("DELEGATION_TO_UNKNOWN");
    expect(a.verdict).toBe("block");
  });
});

describe("transfers", () => {
  test("a sanctioned recipient is blocked", async () => {
    const a = await assess(tx({ to: SANCTIONED, valueWei: "1", data: "0x" }), deps());
    expect(ids(a)).toContain("SANCTIONED_COUNTERPARTY");
    expect(a.verdict).toBe("block");
  });
  test("a recipient that imitates a previous one is blocked as poisoning", async () => {
    const real = "0xabcd000000000000000000000000000000001234";
    const fake = "0xabcd999999999999999999999999999999991234";
    const a = await assess(tx({ to: fake, valueWei: "1", data: "0x" }), deps({}, { [USER]: [real] }));
    expect(ids(a)).toContain("ADDRESS_POISONING");
    expect(a.verdict).toBe("block");
  });
  test("paying the same address you paid before is fine", async () => {
    const real = "0xabcd000000000000000000000000000000001234";
    const a = await assess(tx({ to: real, valueWei: "1", data: "0x" }), deps({ [real]: { txCount: 3 } }, { [USER]: [real] }));
    expect(a.verdict).toBe("allow");
  });
  test("a first-time empty recipient warns", async () => {
    const a = await assess(tx({ to: "0x5555555555555555555555555555555555555555", valueWei: "1", data: "0x" }), deps());
    expect(ids(a)).toContain("FIRST_TIME_RECIPIENT");
  });
});

describe("origin", () => {
  const a = (origin: string) => assess(tx({ origin, data: approveData(PERMIT2, u256(1n)) }), deps());
  test("lookalike domains are blocked", async () => {
    for (const o of [
      "https://app.uniswap-claim.org",
      "https://uniswep.org",
      "https://upiswap.org",
      "https://xn--unswap-9ta.org",
      "https://un1swap.org",
    ]) {
      expect((await a(o)).verdict).toBe("block");
    }
  });
  test("known domains and subdomains pass", async () => {
    for (const o of ["https://uniswap.org", "https://app.uniswap.org", "https://gov.uniswap.org"])
      expect((await a(o)).verdict).toBe("allow");
  });
  test("an unknown site warns only because the request grants access", async () => {
    expect((await a("https://newdapp.xyz")).verdict).toBe("warn");
    const send = await assess(
      tx({ origin: "https://newdapp.xyz", to: EOA, valueWei: "1", data: "0x" }),
      deps({ [EOA]: { txCount: 9 } }, { [USER]: [EOA] }),
    );
    expect(send.verdict).toBe("allow");
  });
  test("http is a warning even on a known domain", async () => {
    expect((await a("http://app.uniswap.org")).verdict).toBe("warn");
  });
});

describe("disabling a rule", () => {
  test("removes only that rule", async () => {
    const d = { ...deps(), disabledRules: ["APPROVAL_TO_EOA"] };
    const a = await assess(tx({ data: approveData(EOA, u256(1n)) }), d);
    expect(ids(a)).not.toContain("APPROVAL_TO_EOA");
  });
});

describe("known list", () => {
  test("every address key is lowercase 20-byte hex, so lookups cannot miss on case", () => {
    for (const a of [...Object.keys(known.spenders), ...Object.keys(known.tokens)]) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
