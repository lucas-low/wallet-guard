/** Checks the page origin against a list of known domains. The origin comes from the browser, so it can be trusted for this. */

const CONFUSABLES: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  і: "i",
  ӏ: "l",
  ѕ: "s",
  ԁ: "d",
  ɡ: "g",
  ο: "o",
  ν: "v",
  ρ: "p",
  α: "a",
  "0": "o",
  "1": "l",
  "3": "e",
  "5": "s",
};

export type OriginStatus = "known" | "lookalike" | "unknown" | "insecure" | "invalid";

export interface OriginResult {
  status: OriginStatus;
  host: string;
  imitates?: string;
  detail?: string;
}

function skeleton(host: string): string {
  return [...host.normalize("NFKC").toLowerCase()].map((c) => CONFUSABLES[c] ?? c).join("");
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** The registrable part, kept simple: last two labels. Good enough for the curated list, wrong for suffixes like co.uk. */
function registrable(host: string): string {
  return host.split(".").slice(-2).join(".");
}

export function checkOrigin(origin: string, knownDomains: string[]): OriginResult {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { status: "invalid", host: "", detail: "origin is not a URL" };
  }
  const host = url.hostname.toLowerCase();
  const known = new Set(knownDomains.map((d) => d.toLowerCase()));
  const onKnown = [...known].some((d) => host === d || host.endsWith(`.${d}`));
  if (onKnown && url.protocol !== "https:") return { status: "insecure", host, detail: "known domain over a non-https connection" };
  if (onKnown) return { status: "known", host };
  if (url.protocol !== "https:") return { status: "insecure", host, detail: "not https" };

  const reg = registrable(host);
  const regSkel = skeleton(reg);
  const labelSkel = skeleton(host.split(".").slice(0, -1).join("."));
  for (const d of known) {
    const dReg = registrable(d);
    const dSkel = skeleton(dReg);
    const dLabel = dReg.split(".")[0]!;
    // punycode (xn--) hosts that fold onto a known domain, or ASCII swaps such as 1 for l, or one-edit typos.
    if (regSkel === dSkel && reg !== dReg)
      return { status: "lookalike", host, imitates: dReg, detail: "characters swapped for lookalikes" };
    if (editDistance(reg, dReg) <= 1 && dLabel.length >= 5)
      return { status: "lookalike", host, imitates: dReg, detail: "one character away from a known domain" };
    // the known brand embedded in a longer label, e.g. uniswap-claim.org, app-uniswap.net
    if (dLabel.length >= 5 && labelSkel.includes(skeleton(dLabel)) && reg !== dReg)
      return { status: "lookalike", host, imitates: dReg, detail: "contains a known brand name on another domain" };
  }
  if (host.startsWith("xn--") || host.includes(".xn--")) return { status: "lookalike", host, detail: "punycode host" };
  return { status: "unknown", host };
}
