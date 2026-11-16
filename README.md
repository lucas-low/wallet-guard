# wallet-guard

A pre-signing guard for crypto wallets. When a web app asks a wallet to sign something, wallet-guard works out what the signature would do and returns **allow**, **warn** or **block** with a plain-language reason, before the user sees the prompt.

Most losses here come from signatures the user was talked into: an unlimited token allowance to a stranger, a permit signed off-chain, `setApprovalForAll` to a drainer, an EIP-7702 delegation to hostile code, a payment to an address that imitates one they use, a site that looks like the real one.

> Status: a reference implementation, not a product. It is not wired into a real wallet and has no users. The known-protocol list is a small seed. Treat the numbers below as what they are, a test of this design on a hand-built case set.

## Use it from an agent (MCP)

An MCP server exposes two read-only tools over stdio, so any MCP client can check a signing request or an address before acting.

| Tool | What it does |
|---|---|
| `review_signing_request` | Transaction, EIP-712 typed data or EIP-7702 authorization in, `allow`, `warn` or `block` out, with reasons. Deterministic rules only, no model. |
| `inspect_address` | Contract or wallet, EIP-7702 delegation, proxy kind and admin, Sourcify verification, SELFDESTRUCT, OFAC sanctions. A failed lookup returns `unavailable`, never a clean result. |

```json
{ "mcpServers": { "wallet-guard": { "command": "bunx", "args": ["--package", "wallet-guard", "wallet-guard-mcp"] } } }
```

Requires [Bun](https://bun.sh). Ethereum mainnet only: a request for another `chainId` is rejected. Environment: `ETH_RPC_URL` (a mainnet endpoint, default a public RPC). Dapp-supplied text is not accepted by the schema, so a malicious description cannot reach the output.

## Wallet middleware

`guardProvider` wraps any EIP-1193 provider (a browser wallet, a WalletConnect session, a bot's signer) so every signing request passes the policy floor before it reaches the key.

```ts
import { guardProvider } from "wallet-guard";

const provider = guardProvider(wallet, { chain, history, known, origin: "https://app.uniswap.org" });
await provider.request({ method: "eth_sendTransaction", params: [tx] }); // throws GuardRejection (code 4001) if blocked
```

It reviews `eth_sendTransaction`, `eth_signTransaction`, `wallet_sendCalls` (every call in the batch) and `eth_signTypedData_v3/v4`. A `block` verdict is refused. A `warn` is refused unless the `onWarn` callback accepts it. `eth_sign`, legacy `eth_signTypedData`, contract creation and any chain other than mainnet are refused rather than passed through unreviewed. `personal_sign` and read-only methods pass through.

## How it decides

```
request ──► decode ──► rules (deterministic floor) ──► agent (explains, can only tighten) ──► verdict
                           │                               ▲
                  address facts, sanctions,         dapp text is quarantined:
                  origin check, history             the agent sees one boolean, not the text
```

1. **Decode.** Calldata and typed data become an effect: transfer, token approval (bounded or unlimited), approve-all, permit, account delegation. Anything it cannot decode is reported as undecodable and warned on.
2. **Floor.** Deterministic rules decide the minimum verdict: unlimited allowance, approval to a plain wallet, approve-all to an unknown operator, EIP-7702 delegation to an unknown contract, OFAC-sanctioned counterparty, address poisoning, lookalike origin (typos, digit swaps, punycode, brand-plus-word), insecure origin, first-time recipient.
3. **Agent.** A model reads the request and the findings through read-only tools and writes the explanation. It can raise the verdict, never lower it.
4. **Fail closed.** If the model errors, times out or never answers, the result is the stricter of the floor and `warn`. It is never `allow`.
5. **Quarantine.** The text a dapp writes about itself is attacker-controlled. A separate tool-less classifier turns it into one boolean, and only that boolean reaches the agent.

The agent has no tool that signs or sends anything.

## Run it

```sh
bun install
bun test                 # unit tests
bun run eval             # offline gates with scripted mock models
bun run cli demo         # all example requests, mock model and mock chain
bun run cli inspect 0x…  # what the chain says about an address: contract, proxy and admin, source verification, sanctions
MODEL_PROVIDER=ollama MODEL=qwen2.5:32b bun run cli check request.json
```

Real chain data: `CHAIN_PROVIDER=onchain ETH_RPC_URL=<any JSON-RPC>` uses the OFAC list in `data/ofac-eth.txt` plus `eth_getCode`, nonce and balance.

## Measured on real history

Replayed at the block before each transaction, origin rule off, 2026-11-16:

| Set | Cases | Block | Warn | Allow |
|---|---|---|---|---|
| Approvals and permits to labelled scam addresses (162,774 found, 1,200 sampled) | 1,200 | 96.7% | 3.3% | 0% |
| Approvals from recent normal traffic, labelled spenders excluded | 600 | 17.8% | 72.7% | 9.5% |

Read the second row with care. It has no ground truth: some of those blocks are unlabelled scams or wallet-address spenders, so 17.8% is an upper bound on false alarms, and the 72.7% warnings are mostly spenders outside the 19-entry known list. Scam labels come from public lists, so a scam nobody has labelled is not counted. About 3% of cases could not be looked up. Methods and scripts: `replay/`.

## Evals

`bun run eval` runs 25 cases (6 benign, 14 malicious, rest warn-level) against seven agent behaviours: competent, lenient (always allow), gullible, forgetful, broken, silent and slow. The gates check that no malicious case reaches the user below its minimum verdict whatever the agent does, that failures fail closed, and that the nudge turn recovers a forgetful model. These use scripted models, so they test the harness, not a real model. Live results against local models are in [docs/evals.md](docs/evals.md).

## Limits

- EVM only. No Solana, no Bitcoin.
- The known-spender and known-domain lists are a seed. A real deployment needs a maintained registry.
- Origin matching uses the last two labels of a host, which is wrong for suffixes like `co.uk`.
- Transaction simulation (balance changes before and after) is not implemented. It is the obvious next layer.
- Calldata decoding covers the common approval, transfer and permit shapes only.

MIT licensed.
