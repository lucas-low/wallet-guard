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
| Approving a contract that can change under you or has no published source | `UNVERIFIED_CONTRACT`, `UPGRADEABLE_CONTRACT` (EIP-1967, ZeppelinOS and beacon proxies), `SELFDESTRUCT_CONTRACT`. Known protocols are exempt | `tests/contract.test.ts` |
| Prompt injection in the dapp text | quarantine: agent sees only a boolean; floor holds even if the agent is fooled | `inj_*`, gullible-agent gate |
| Agent down, slow or silent | fail closed to at least `warn` | broken, silent, slow gates |
| Agent tries to relax the verdict | final = stricter of agent and floor | lenient-agent gate |

## Known gaps

- **Contract checks cover one level.** A proxy is detected and its admin reported, but the implementation behind it is not itself inspected, and a beacon proxy reports the beacon, not what it points to.
- **Failed contract lookups add no warning.** If the storage reads or Sourcify fail, the contract fields are left out and no contract rule fires. The address still gets `CHAIN_DATA_UNAVAILABLE` when the basic lookup fails. Closing this fully would mean warning on every partial lookup, which would be noisy.
- **Missing contract fields mean "not detected".** `inspect_address` leaves out a proxy or verification field when its lookup fails, so an absent field is not proof of absence.
- **Only some proxy shapes are detected.** EIP-1967, ZeppelinOS, beacon and exact EIP-1167 clones. EIP-1822, Safe-style slot 0 and custom-slot proxies read as not a proxy.
- **Sourcify is a public service with no key.** It covers source verified there, not every explorer's verifications. The contract addresses being approved are sent to it. `sourcifyUrl: null` in `RpcOptions` turns it off; there is no environment switch.
- **Mainnet only.** The policy and chain client take no chain argument, so the MCP server rejects any other `chainId`.

- **No transaction simulation.** The guard reads calldata. It does not run the transaction, so a contract call it cannot decode is only warned on.
- **Curated allowlists.** A spender or domain missing from `data/known.json` is treated as unknown, which causes warnings on legitimate new protocols.
- **Origin matching is heuristic.** Brand-in-label matching needs a brand of five letters or more. Suffixes like `co.uk` are mishandled.
- **A compromised known site passes.** If `app.uniswap.org` itself serves a malicious request that is bounded and to a known spender, the guard allows it.
- **Classifier false positives.** The quarantine classifier fails closed, which costs extra confirmations. See docs/evals.md for measured rates.
- **EVM only.**
