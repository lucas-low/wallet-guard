import { describe, expect, test } from "bun:test";
import { GuardRejection, guardProvider } from "../src";
import { approveData, deps, EOA, MAX, PERMIT2, USDC, USER, u256 } from "./helpers";

const ORIGIN = "https://app.uniswap.org";

function wallet(chainId = "0x1") {
  const signed: string[] = [];
  const inner = {
    async request({ method }: { method: string }) {
      if (method === "eth_chainId") return chainId;
      signed.push(method);
      return "0xsigned";
    },
  };
  return { inner, signed };
}

const send = (data: string, to = USDC) => ({ method: "eth_sendTransaction", params: [{ from: USER, to, value: "0x0", data }] });
const guarded = (w = wallet(), over = {}) => ({ w, p: guardProvider(w.inner, { ...deps(), origin: ORIGIN, ...over }) });

describe("guardProvider", () => {
  test("a bounded approval to a known spender is signed", async () => {
    const { w, p } = guarded();
    expect(await p.request(send(approveData(PERMIT2, u256(1000n))))).toBe("0xsigned");
    expect(w.signed).toEqual(["eth_sendTransaction"]);
  });

  test("a blocked request never reaches the wallet", async () => {
    const { w, p } = guarded();
    const err = await p.request(send(approveData(EOA, MAX))).catch((e) => e);
    expect(err).toBeInstanceOf(GuardRejection);
    expect(err.code).toBe(4001);
    expect(err.assessments[0].verdict).toBe("block");
    expect(w.signed).toEqual([]);
  });

  test("a warning is refused by default and signed when onWarn accepts it", async () => {
    const unlimited = send(approveData(PERMIT2, MAX));
    const refused = guarded();
    expect(await refused.p.request(unlimited).catch((e) => e)).toBeInstanceOf(GuardRejection);
    expect(refused.w.signed).toEqual([]);

    const accepted = guarded(wallet(), { onWarn: () => true });
    expect(await accepted.p.request(unlimited)).toBe("0xsigned");
  });

  test("onWarn cannot override a block", async () => {
    const { w, p } = guarded(wallet(), { onWarn: () => true });
    expect(await p.request(send(approveData(EOA, MAX))).catch((e) => e)).toBeInstanceOf(GuardRejection);
    expect(w.signed).toEqual([]);
  });

  test("one bad call blocks a whole wallet_sendCalls batch", async () => {
    const { w, p } = guarded();
    const calls = [
      { to: USDC, data: approveData(PERMIT2, u256(1000n)) },
      { to: USDC, data: approveData(EOA, MAX) },
    ];
    const err = await p.request({ method: "wallet_sendCalls", params: [{ from: USER, calls }] }).catch((e) => e);
    expect(err).toBeInstanceOf(GuardRejection);
    expect(w.signed).toEqual([]);
  });

  test("an unlimited permit signature is reviewed like the approval it is", async () => {
    const { w, p } = guarded();
    const typed = {
      primaryType: "Permit",
      domain: { chainId: 1, verifyingContract: USDC },
      message: { owner: USER, spender: EOA, value: BigInt(`0x${MAX}`).toString(), nonce: 0, deadline: 0 },
    };
    const err = await p.request({ method: "eth_signTypedData_v4", params: [USER, JSON.stringify(typed)] }).catch((e) => e);
    expect(err).toBeInstanceOf(GuardRejection);
    expect(w.signed).toEqual([]);
  });

  test("eth_sign, contract creation and other chains are refused, not passed through", async () => {
    const { w, p } = guarded();
    for (const req of [
      { method: "eth_sign", params: [USER, "0x00"] },
      { method: "eth_signTypedData", params: [[{ type: "string", name: "m", value: "x" }], USER] },
      { method: "eth_sendTransaction", params: [{ from: USER, data: "0x6000" }] },
    ])
      expect(await p.request(req).catch((e) => e)).toBeInstanceOf(GuardRejection);
    const polygon = guarded(wallet("0x89"));
    expect(await polygon.p.request(send(approveData(PERMIT2, u256(1000n)))).catch((e) => e)).toBeInstanceOf(GuardRejection);
    expect([...w.signed, ...polygon.w.signed]).toEqual([]);
  });

  test("read-only methods pass straight through", async () => {
    const { w, p } = guarded();
    await p.request({ method: "eth_getBalance", params: [USER, "latest"] });
    expect(w.signed).toEqual(["eth_getBalance"]);
  });
});
