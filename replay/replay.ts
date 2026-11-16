import { readFileSync, writeFileSync } from "node:fs";
import { assess, loadSanctionList, OnchainChainClient } from "../src/index";
import known from "../data/known.json";

const [input, output, url = "https://eth.drpc.org"] = process.argv.slice(2);
const cases = readFileSync(input!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const sanctioned = loadSanctionList();
const history = { recentRecipients: async () => [] };

// Pin every state read to the block before the transaction, so the guard sees what the signer would have seen.
const pinned = (block: number): typeof fetch =>
  (async (u: string | URL | Request, init?: RequestInit) => {
    if (String(u) !== url) return fetch(u, init);
    const body = String(init?.body).replace('"latest"', `"0x${(block - 1).toString(16)}"`);
    for (let i = 0; ; i++) {
      const res = await fetch(u, { ...init, body });
      const text = await res.text();
      if ((res.ok && text.includes('"result"')) || i >= 5) return new Response(text, { status: res.status });
      await Bun.sleep(800 * (i + 1));
    }
  }) as typeof fetch;

const out: unknown[] = [];
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++];
    const chain = new OnchainChainClient(sanctioned, { url, fetch: pinned(c.block), timeoutMs: 30000 });
    const a = await assess(
      { id: c.hash, chainId: 1, from: c.from, origin: "https://replay.invalid", ...(c.req ?? { kind: "transaction", to: c.to, valueWei: c.value, data: c.data }) },
      { chain, history, known, disabledRules: ["ORIGIN_UNKNOWN"] },
    );
    out.push({ hash: c.hash, label: c.label, block: c.block, kind: c.kind, spender: c.spender, verdict: a.verdict, effect: a.effect.type, reasons: a.reasons.map((r) => `${r.id}:${r.verdict}`) });
    if (out.length % 50 === 0) console.log(out.length);
  }
}
await Promise.all(Array.from({ length: Number(process.env.CONC ?? 4) }, worker));
writeFileSync(output!, JSON.stringify(out, null, 1));
