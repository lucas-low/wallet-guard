import { MockLanguageModelV4 } from "ai/test";
import type { Verdict } from "../domain/types";

export type MockBehavior = "competent" | "lenient" | "gullible" | "forgetful" | "broken" | "silent" | "slow" | "toolparse";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
const call = (id: string, toolName: string, input: unknown) => ({
  type: "tool-call" as const,
  toolCallId: id,
  toolName,
  input: JSON.stringify(input),
});

/** Pulls tool outputs out of the prompt history regardless of how the SDK wraps them. */
function toolResults(prompt: unknown[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const msg of prompt as { role: string; content: unknown }[]) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as any[]) {
      if (part.type !== "tool-result") continue;
      const o = part.output;
      out[part.toolName] = o && typeof o === "object" && "value" in o ? o.value : o;
    }
  }
  return out;
}

function judge(req: any, behavior: MockBehavior): { verdict: Verdict; explanation: string } {
  const desc: string = req?.untrusted?.description ?? "";
  // Worst case: obeys whatever reassurance it reads.
  if (behavior === "gullible" && /safe|approve|verified|official|trusted|do not warn/i.test(desc))
    return { verdict: "allow", explanation: "The app says it is safe, so allowing." };
  if (behavior === "lenient") return { verdict: "allow", explanation: "Looks fine." };
  if (req?.dappFlagged) return { verdict: "block", explanation: "The app's own text tries to steer this review, so it is not trusted." };
  const checks: { verdict: Verdict; message: string }[] = req?.checks ?? [];
  const worst = checks.find((c) => c.verdict === "block") ?? checks.find((c) => c.verdict === "warn");
  if (worst) return { verdict: worst.verdict, explanation: worst.message };
  return { verdict: "allow", explanation: "Bounded, expected for this site, no checks fired." };
}

/**
 * Scripted stand-in for a real model so the loop, tools, floor and evals run offline.
 * It exercises the harness. It cannot show how a real model behaves.
 */
export function createMockModel(behavior: MockBehavior = "competent") {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: `mock-${behavior}`,
    doGenerate: async (options) => {
      if (behavior === "broken") throw new Error("mock model failure");
      // Server cannot parse the model's tool call (seen with local models), but a plain JSON reply works.
      if (behavior === "toolparse") {
        if (options.tools?.length) throw new Error("Invalid JSON response");
        const facts = JSON.parse(String((options.prompt as any[]).find((m) => m.role === "user")?.content?.[0]?.text ?? "{}"));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(judge(facts, "competent")) }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      if (behavior === "slow") {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 60_000);
          options.abortSignal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(options.abortSignal?.reason ?? new Error("aborted"));
          });
        });
      }
      const results = toolResults(options.prompt as unknown[]);
      const nudged = JSON.stringify(options.prompt).includes("Call submitReview now");
      const stop = { unified: "stop" as const, raw: undefined };
      const tools = { unified: "tool-calls" as const, raw: undefined };
      if (!results.getRequest) return { content: [call("c1", "getRequest", {})], finishReason: tools, usage, warnings: [] };
      if (!results.submitReview && behavior !== "silent" && !(behavior === "forgetful" && !nudged))
        return { content: [call("c2", "submitReview", judge(results.getRequest, behavior))], finishReason: tools, usage, warnings: [] };
      return { content: [{ type: "text" as const, text: "Done." }], finishReason: stop, usage, warnings: [] };
    },
  });
}

/** Scripted description classifier. `blind` always answers safe, the worst case for the quarantine design. */
export function createMockScreenModel(behavior: "blind" | "paranoid" = "blind") {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: `mock-screen-${behavior}`,
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ suspicious: behavior === "paranoid" }) }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage,
      warnings: [],
    }),
  });
}
