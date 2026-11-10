/** Address poisoning: an attacker sends dust from an address that matches the first and last characters of one you use. */

const hex = (a: string) => a.toLowerCase().replace(/^0x/, "");

export interface PoisonMatch {
  candidate: string;
  lookalikeOf: string;
}

/** True when two different addresses share the first and last `edge` hex characters, the part wallets show in short form. */
export function looksLikePoisoning(a: string, b: string, edge = 4): boolean {
  const x = hex(a);
  const y = hex(b);
  if (x === y || x.length !== 40 || y.length !== 40) return false;
  return x.slice(0, edge) === y.slice(0, edge) && x.slice(-edge) === y.slice(-edge);
}

/** Looks for a recipient that imitates an address the user has paid before. */
export function findPoisoning(recipient: string, previousRecipients: string[]): PoisonMatch | undefined {
  const hit = previousRecipients.find((p) => looksLikePoisoning(recipient, p));
  return hit ? { candidate: recipient.toLowerCase(), lookalikeOf: hit.toLowerCase() } : undefined;
}
