import { generateText, type LanguageModel, stepCountIs } from "ai";
import { jsonReview } from "./agent/fallback";
import { NUDGE, PROMPT_VERSION, systemPrompt, userPrompt } from "./agent/prompt";
import { buildTools, type Review, type RunContext } from "./agent/tools";
import { type Reason, type SigningRequest, stricter, type Verdict } from "./domain/types";
import type { DescriptionScreen } from "./guardrails/screen";
import { type Assessment, assess, type PolicyDeps } from "./policy/engine";
import { truncate } from "./util";

export interface GuardDeps extends PolicyDeps {
  model: LanguageModel;
  modelName: string;
  screen: DescriptionScreen;
  noteHandling: "quarantine" | "passthrough";
  maxSteps?: number;
  timeoutMs?: number;
}

export interface GuardResult {
  requestId: string;
  verdict: Verdict;
  explanation: string;
  floor: Verdict;
  agentVerdict: Verdict | null;
  /** The agent tried to loosen the floor and was overruled. */
  overridden: boolean;
  /** The agent failed, so the floor plus a fail-closed minimum decided. */
  degraded: boolean;
  /** How the review was obtained. json means the tool-calling path failed and the plain JSON fallback answered. */
  via: "tools" | "json";
  agentError: string | null;
  dappFlagged: boolean;
  reasons: Reason[];
  effect: Assessment["effect"];
  steps: number;
  promptVersion: string;
}

export const ATTEMPT_TEMPERATURES = [0, 0.3, 0.6];

/** Verdict applied when the agent fails. The user must confirm explicitly. */
export const DEGRADED_MINIMUM: Verdict = "warn";

/**
 * Floor first, agent second. The agent can only tighten the floor. If it fails, the result is the stricter of
 * the floor and a fail-closed minimum, never allow.
 */
export async function guard(req: SigningRequest, d: GuardDeps): Promise<GuardResult> {
  const assessment = await assess(req, d);
  const dapp = await d.screen.screen([req.dapp?.name, req.dapp?.description].filter(Boolean).join("\n") || null);
  const ctx: RunContext = {
    req,
    assessment,
    dappFlagged: dapp.detected,
    noteHandling: d.noteHandling,
    chain: d.chain,
    slot: { calls: [] },
  };
  let steps = 0;
  let agentError: string | null = null;
  // Local models sometimes produce an empty or malformed reply after a tool call. At temperature 0 a retry repeats the
  // same failure, so each retry samples a little hotter. Failing every attempt fails closed.
  for (let attempt = 0; attempt < ATTEMPT_TEMPERATURES.length && !ctx.slot.review; attempt++) {
    try {
      const system = systemPrompt(d.noteHandling);
      const opts = {
        model: d.model,
        system,
        tools: buildTools(ctx),
        abortSignal: AbortSignal.timeout(d.timeoutMs ?? 60_000),
        temperature: 0,
        maxRetries: 1,
      };
      const r = await generateText({ ...opts, prompt: userPrompt(req.id), stopWhen: stepCountIs(d.maxSteps ?? 6) });
      steps += r.steps.length;
      if (!ctx.slot.review) {
        // Some models gather facts and then answer in prose. One forced turn to call submitReview.
        const f = await generateText({
          ...opts,
          messages: [
            { role: "user", content: userPrompt(req.id) },
            ...r.steps.flatMap((s) => s.response.messages),
            { role: "user", content: NUDGE },
          ],
          toolChoice: { type: "tool", toolName: "submitReview" },
          stopWhen: stepCountIs(1),
        });
        steps += f.steps.length;
      }
      if (!ctx.slot.review) throw new Error("agent finished without calling submitReview");
      agentError = null;
    } catch (err) {
      ctx.slot.review = undefined;
      agentError = truncate(err instanceof Error ? err.message : String(err), 300);
      // A timeout means the budget is spent. Do not retry it.
      if (/abort|timeout|timed out/i.test(agentError)) break;
    }
  }
  // Tool calling failed for a reason other than time. Try a plain JSON reply before failing closed.
  let via: "tools" | "json" = "tools";
  if (!ctx.slot.review && !(agentError && /abort|timeout|timed out/i.test(agentError))) {
    const r = await jsonReview(ctx, { model: d.model, timeoutMs: d.timeoutMs ?? 60_000 });
    if (r) {
      ctx.slot.review = r;
      via = "json";
      agentError = null;
    }
  }
  const review: Review | undefined = ctx.slot.review;
  const floor = assessment.verdict;
  const degraded = !review;
  const verdict = review ? stricter(review.verdict, floor) : stricter(floor, DEGRADED_MINIMUM);
  const overridden = Boolean(review) && verdict !== review!.verdict;
  const floorText = assessment.reasons.map((r) => r.message).join(" ");
  const explanation = degraded
    ? truncate(`The automated review was unavailable, so this needs your explicit confirmation. ${floorText}`, 400)
    : overridden
      ? truncate(`${floorText} (${review!.explanation})`, 400)
      : review!.explanation;
  return {
    requestId: req.id,
    verdict,
    explanation,
    floor,
    agentVerdict: review?.verdict ?? null,
    overridden,
    degraded,
    via,
    agentError,
    dappFlagged: dapp.detected,
    reasons: assessment.reasons,
    effect: assessment.effect,
    steps,
    promptVersion: PROMPT_VERSION,
  };
}
