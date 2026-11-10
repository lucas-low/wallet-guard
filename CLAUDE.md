# wallet-guard

## Overview
Reviews a signing request (transaction, permit, EIP-7702 delegation) that a web app makes to a crypto wallet, before the user sees the prompt. A deterministic rule floor decides the minimum verdict (allow, warn, block). An LLM agent explains the request in plain words and can only make the verdict stricter.

## Stack
- Runtime: Bun (system Node is broken, do not use node/pnpm/npx), TypeScript, Vercel AI SDK v7, zod 4, Biome

## Commands
- Install: `bun install`
- Test: `bun test`
- Typecheck: `bun --bun run tsc --noEmit`
- Lint/format: `bun --bun run biome check --write .`
- Offline evals: `bun run eval` (mock models, tests the harness only)
- Live evals: `MODEL=qwen2.5:14b bun run evals/live.ts` (needs Ollama)
- Demo: `bun run cli demo`

## Architecture
`decode/` calldata and typed data to an Effect, `policy/engine.ts` the floor, `guardrails/` origin lookalikes, address poisoning, injection heuristics, quarantined description classifier, `agent/` tools, prompt, mock models, `guard.ts` combines floor and agent, `adapters/` chain data (mock, OFAC plus JSON-RPC), `evals/` cases, harness, live runner.

## Conventions
- The agent has no tool that signs or sends. Final verdict = stricter of agent and floor. Agent failure never yields allow.
- Text a dapp supplies about itself is untrusted: it reaches the agent only as a boolean flag in quarantine mode.
- The origin URL comes from the browser and is trusted for host checks.
- `data/known.json` is a small curated seed, not a registry. Say so whenever quoting results.
- Offline evals test the harness, not a real model. Say so whenever quoting results.
- Every new miss becomes an eval case or a test.
