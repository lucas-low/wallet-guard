import type { LanguageModel } from "ai";
import { MemoryHistory } from "../src/adapters/chain.mock";
import { createMockModel, createMockScreenModel, type MockBehavior } from "../src/agent/mock-model";
import { VERDICT_RANK, type Verdict } from "../src/domain/types";
import { type GuardDeps, type GuardResult, guard } from "../src/guard";
import { combineScreens, heuristicScreen, llmScreen } from "../src/guardrails/screen";
import { deps, USER } from "../tests/helpers";
import type { Case } from "./cases";

export interface Setup {
  name: string;
  behavior?: MockBehavior;
  model?: { model: LanguageModel; name: string };
  noteHandling: "quarantine" | "passthrough";
  screen: "heuristic" | "blind" | "combined";
  disabledRules?: string[];
  timeoutMs?: number;
}

export interface CaseResult {
  case: Case;
  result: GuardResult;
  /** A malicious case that reached less than its minimum verdict. */
  leaked: boolean;
  /** A benign case that was warned or blocked. */
  falsePositive: boolean;
}

export function buildDeps(c: Case, s: Setup): GuardDeps {
  const base = deps();
  const mock = s.model ?? { model: createMockModel(s.behavior ?? "competent"), name: `mock-${s.behavior ?? "competent"}` };
  const screen =
    s.screen === "heuristic"
      ? heuristicScreen
      : s.screen === "blind"
        ? llmScreen(createMockScreenModel("blind"))
        : combineScreens(heuristicScreen, llmScreen(createMockScreenModel("blind")));
  return {
    ...base,
    history: new MemoryHistory({ [USER]: c.history ?? [] }),
    model: mock.model,
    modelName: mock.name,
    screen,
    noteHandling: s.noteHandling,
    disabledRules: s.disabledRules,
    timeoutMs: s.timeoutMs ?? 5_000,
  };
}

export async function runCase(c: Case, s: Setup): Promise<CaseResult> {
  const result = await guard(c.req, buildDeps(c, s));
  const rank = (v: Verdict) => VERDICT_RANK[v];
  return {
    case: c,
    result,
    leaked: rank(result.verdict) < rank(c.min),
    falsePositive: c.tags.includes("benign") && rank(result.verdict) > rank(c.max),
  };
}

export interface Summary {
  setup: string;
  cases: number;
  leaked: number;
  falsePositives: number;
  degraded: number;
  malicious: number;
  benign: number;
}

export async function runSetup(cases: Case[], s: Setup): Promise<{ summary: Summary; results: CaseResult[] }> {
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(c, s));
  return {
    results,
    summary: {
      setup: s.name,
      cases: cases.length,
      leaked: results.filter((r) => r.leaked).length,
      falsePositives: results.filter((r) => r.falsePositive).length,
      degraded: results.filter((r) => r.result.degraded).length,
      malicious: cases.filter((c) => c.min === "block").length,
      benign: cases.filter((c) => c.tags.includes("benign")).length,
    },
  };
}
