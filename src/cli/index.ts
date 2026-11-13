#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import known from "../../data/known.json";
import { MemoryHistory, MockChainClient } from "../adapters/chain.mock";
import { loadSanctionList, OnchainChainClient } from "../adapters/chain.onchain";
import type { MockBehavior } from "../agent/mock-model";
import { createModel, createScreenModel, type ModelConfig } from "../agent/models";
import type { SigningRequest } from "../domain/types";
import { type GuardDeps, guard } from "../guard";
import { combineScreens, heuristicScreen, llmScreen } from "../guardrails/screen";
import type { PolicyDeps } from "../policy/engine";

const USAGE = `wallet-guard: review a wallet signing request before the user sees the prompt

  bun run cli check <request.json>    review one request (JSON, see docs/api.md)
  bun run cli inspect <address>       what the chain says about an address: contract, proxy, source, sanctions (always on-chain)
  bun run cli demo                    run the built-in examples

Environment:
  MODEL_PROVIDER   mock | ollama | anthropic   (default mock)
  MODEL            model name for ollama or anthropic
  MOCK_BEHAVIOR    competent | lenient | gullible | forgetful | broken | silent | slow
  NOTE_HANDLING    quarantine | passthrough    (default quarantine)
  CHAIN_PROVIDER   mock | onchain              (default mock; onchain needs ETH_RPC_URL)
  ETH_RPC_URL      any Ethereum JSON-RPC endpoint
`;

function modelConfig(): ModelConfig {
  const provider = (process.env.MODEL_PROVIDER ?? "mock") as ModelConfig["provider"];
  return {
    provider,
    model: process.env.MODEL ?? (provider === "anthropic" ? "claude-sonnet-5-5" : "qwen2.5:32b"),
    mockBehavior: (process.env.MOCK_BEHAVIOR ?? "competent") as MockBehavior,
    ollamaUrl: process.env.OLLAMA_URL,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  };
}

export function buildGuardDeps(history: Record<string, string[]> = {}): GuardDeps {
  const mc = modelConfig();
  const { model, name } = createModel(mc);
  const chain =
    process.env.CHAIN_PROVIDER === "onchain"
      ? new OnchainChainClient(loadSanctionList(), { url: process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com" })
      : new MockChainClient();
  const policy: Pick<PolicyDeps, "chain" | "history" | "known"> = {
    chain,
    history: new MemoryHistory(history),
    known: known as PolicyDeps["known"],
  };
  const screen = mc.provider === "mock" ? heuristicScreen : combineScreens(heuristicScreen, llmScreen(createScreenModel(mc)));
  return {
    ...policy,
    model,
    modelName: name,
    screen,
    noteHandling: (process.env.NOTE_HANDLING ?? "quarantine") as "quarantine" | "passthrough",
  };
}

function print(r: Awaited<ReturnType<typeof guard>>) {
  console.log(
    `${r.verdict.toUpperCase().padEnd(5)} ${r.requestId}  floor=${r.floor} agent=${r.agentVerdict ?? "none"}${r.overridden ? " (overridden)" : ""}${r.degraded ? " (degraded)" : ""}${r.dappFlagged ? " (dapp text flagged)" : ""}`,
  );
  console.log(`      ${r.explanation}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "check" && arg) {
  const req = JSON.parse(readFileSync(arg, "utf8")) as SigningRequest;
  print(await guard(req, buildGuardDeps()));
} else if (cmd === "inspect" && arg) {
  const rpc = { url: process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com" };
  console.log(JSON.stringify(await new OnchainChainClient(loadSanctionList(), rpc).addressRisk(arg), null, 2));
} else if (cmd === "demo") {
  const { CASES } = await import("../../evals/cases");
  const mockChainDeps = (await import("../../tests/helpers")).deps();
  for (const c of CASES) {
    const d = buildGuardDeps();
    print(
      await guard(
        { ...c.req, id: c.id },
        { ...d, chain: mockChainDeps.chain, history: new MemoryHistory({ [c.req.from.toLowerCase()]: c.history ?? [] }) },
      ),
    );
  }
} else {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
