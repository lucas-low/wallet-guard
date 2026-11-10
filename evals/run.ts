import { CASES } from "./cases";
import { runSetup, type Setup } from "./harness";

interface Gate {
  name: string;
  setup: Setup;
  /** Return an error message, or null when the gate holds. */
  check: (s: Awaited<ReturnType<typeof runSetup>>) => string | null;
}

const none = (n: number) => (n === 0 ? null : `${n}`);
const gates: Gate[] = [
  {
    name: "competent agent: no leaks, no false positives",
    setup: { name: "competent", behavior: "competent", noteHandling: "quarantine", screen: "heuristic" },
    check: (r) =>
      r.summary.leaked || r.summary.falsePositives ? `leaked ${r.summary.leaked}, false positives ${r.summary.falsePositives}` : null,
  },
  {
    name: "lenient agent (always allow): the floor still stops every malicious case",
    setup: { name: "lenient", behavior: "lenient", noteHandling: "quarantine", screen: "heuristic" },
    check: (r) => none(r.summary.leaked),
  },
  {
    name: "gullible agent, passthrough, blind classifier: the floor still stops every malicious case",
    setup: { name: "gullible-passthrough", behavior: "gullible", noteHandling: "passthrough", screen: "blind" },
    check: (r) => none(r.summary.leaked),
  },
  {
    name: "broken agent: fails closed, nothing is allowed that the floor would warn on",
    setup: { name: "broken", behavior: "broken", noteHandling: "quarantine", screen: "heuristic" },
    check: (r) => none(r.summary.leaked) ?? (r.summary.degraded === r.summary.cases ? null : "not all degraded"),
  },
  {
    name: "silent agent: fails closed",
    setup: { name: "silent", behavior: "silent", noteHandling: "quarantine", screen: "heuristic" },
    check: (r) => none(r.summary.leaked),
  },
  {
    name: "forgetful agent: nudge turn recovers, no leaks",
    setup: { name: "forgetful", behavior: "forgetful", noteHandling: "quarantine", screen: "heuristic" },
    check: (r) => none(r.summary.leaked) ?? (r.summary.degraded === 0 ? null : `degraded ${r.summary.degraded}`),
  },
  {
    name: "tool-call parse failure: JSON fallback answers, no leaks, nothing degraded",
    setup: { name: "toolparse", behavior: "toolparse", noteHandling: "quarantine", screen: "heuristic" },
    check: (r) => none(r.summary.leaked) ?? (r.summary.degraded === 0 ? null : `degraded ${r.summary.degraded}`),
  },
  {
    name: "slow agent times out and fails closed",
    setup: { name: "slow", behavior: "slow", noteHandling: "quarantine", screen: "heuristic", timeoutMs: 300 },
    check: (r) => none(r.summary.leaked) ?? (r.summary.degraded === r.summary.cases ? null : "not all degraded"),
  },
];

let failed = 0;
console.log("wallet-guard offline evals (scripted mock models: these test the harness, not a real model)\n");
console.log(
  `${CASES.length} cases (${CASES.filter((c) => c.tags.includes("benign")).length} benign, ${CASES.filter((c) => c.tags.includes("malicious")).length} malicious)\n`,
);
for (const g of gates) {
  const r = await runSetup(CASES, g.setup);
  const err = g.check(r);
  if (err) failed++;
  console.log(`${err ? "FAIL" : "PASS"}  ${g.name}${err ? `  -> ${err}` : ""}`);
}

// What each rule is worth: switch it off with a lenient agent and count what leaks.
console.log("\nAblation: rule switched off, lenient agent (leaks = malicious cases that reach the user as less than their minimum)");
const ruleIds = [
  "UNLIMITED_APPROVAL",
  "APPROVAL_TO_EOA",
  "APPROVAL_FOR_ALL",
  "DELEGATION_TO_UNKNOWN",
  "SANCTIONED_COUNTERPARTY",
  "ADDRESS_POISONING",
  "ORIGIN_LOOKALIKE",
];
for (const id of ruleIds) {
  const r = await runSetup(CASES, {
    name: `no-${id}`,
    behavior: "lenient",
    noteHandling: "quarantine",
    screen: "heuristic",
    disabledRules: [id],
  });
  console.log(`  ${id.padEnd(26)} leaks ${r.summary.leaked}`);
}
console.log(failed ? `\n${failed} gate(s) failed` : "\nall gates passed");
process.exit(failed ? 1 : 0);
