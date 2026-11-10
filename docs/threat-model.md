# Threat model

What wallet-guard defends against, what it trusts, and where it is weak.

## Trust boundaries

| Input | Trusted? | Why |
|---|---|---|
| Page origin (`origin`) | yes, for host checks | Supplied by the browser or wallet, not by the page's own script |
| Calldata, typed data, chain id | yes | The thing the user would sign. Decoded, never executed |
| Dapp name and description | **no** | Written by the dapp. Attackers control it |
| Chain facts (code, nonce, sanctions) | yes, with fail-closed | A provider failure produces a warning, never an allow |
| Agent output | **no** | Can only tighten the floor |

## Threats and controls

| Threat | Control | Test |
|---|---|---|
| Unlimited allowance to a stranger | `UNLIMITED_APPROVAL`, `APPROVAL_TO_EOA` | `blk_unlimited_eoa` |
| Off-chain permit signature that grants an allowance | typed-data decoding, same rules | `blk_permit_drain` |
| `setApprovalForAll` to a drainer | `APPROVAL_FOR_ALL` (grant blocked, revoke allowed) | `blk_setapproval_all`, `ok_revoke` |
| EIP-7702 delegation to hostile code | `DELEGATION_TO_UNKNOWN` | `blk_7702` |
| Sanctioned counterparty | `SANCTIONED_COUNTERPARTY` (OFAC list) | `blk_sanctioned` |
| Address poisoning (lookalike of a previous recipient) | `ADDRESS_POISONING` (first and last 4 hex match) | `blk_poisoning` |
| Lookalike site: brand plus word, typo, digit swap, punycode | `ORIGIN_LOOKALIKE` | `blk_lookalike_*` |
| Prompt injection in the dapp text | quarantine: agent sees only a boolean; floor holds even if the agent is fooled | `inj_*`, gullible-agent gate |
| Agent down, slow or silent | fail closed to at least `warn` | broken, silent, slow gates |
| Agent tries to relax the verdict | final = stricter of agent and floor | lenient-agent gate |

## Known gaps

- **No transaction simulation.** The guard reads calldata. It does not run the transaction, so a contract call it cannot decode is only warned on.
- **Curated allowlists.** A spender or domain missing from `data/known.json` is treated as unknown, which causes warnings on legitimate new protocols.
- **Origin matching is heuristic.** Brand-in-label matching needs a brand of five letters or more. Suffixes like `co.uk` are mishandled.
- **A compromised known site passes.** If `app.uniswap.org` itself serves a malicious request that is bounded and to a known spender, the guard allows it.
- **Classifier false positives.** The quarantine classifier fails closed, which costs extra confirmations. See docs/evals.md for measured rates.
- **EVM only.**
