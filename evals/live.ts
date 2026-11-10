import { mkdirSync, writeFileSync } from "node:fs";
import { createModel, type ModelConfig } from "../src/agent/models";
import { CASES } from "./cases";
import { runSetup, type Setup } from "./harness";

const model = process.env.MODEL ?? "qwen2.5:14b";
const mc: ModelConfig = { provider: "ollama", model, ollamaUrl: process.env.OLLAMA_URL };
const modes = (process.env.MODES ?? "quarantine,passthrough").split(",") as Setup["noteHandling"][];

const out: Record<string, unknown>[] = [];
console.log(`live eval, model ${model}, ${CASES.length} cases\n`);
for (const noteHandling of modes) {
  const setup: Setup = { name: `${model}/${noteHandling}`, model: createModel(mc), noteHandling, screen: "heuristic", timeoutMs: 180_000 };
  const t0 = Date.now();
  const r = await runSetup(CASES, setup);
  const secs = Number(((Date.now() - t0) / 1000).toFixed(0));
  const s = r.summary;
  console.log(
    `${setup.name}: leaked ${s.leaked}/${s.malicious} malicious, false positives ${s.falsePositives}/${s.benign} benign, degraded ${s.degraded}, ${secs}s`,
  );
  for (const x of r.results) {
    const flag = x.leaked ? "LEAK" : x.falsePositive ? "FP  " : x.result.degraded ? "DEGR" : "ok  ";
    console.log(
      `  ${flag} ${x.case.id.padEnd(30)} floor=${x.result.floor} agent=${x.result.agentVerdict ?? "none"} final=${x.result.verdict} steps=${x.result.steps}`,
    );
  }
  out.push({
    setup: setup.name,
    summary: s,
    secs,
    cases: r.results.map((x) => ({
      id: x.case.id,
      floor: x.result.floor,
      agent: x.result.agentVerdict,
      final: x.result.verdict,
      degraded: x.result.degraded,
      leaked: x.leaked,
      falsePositive: x.falsePositive,
    })),
  });
}
mkdirSync("docs/results", { recursive: true });
writeFileSync(`docs/results/live-${model.replace(/[:/]/g, "_")}.json`, JSON.stringify(out, null, 2));
