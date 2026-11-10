# Evals

Two kinds of run, and they answer different questions.

**Offline (`bun run eval`).** Scripted mock models. These test the harness: that the floor holds whatever the agent says, that failures fail closed, that the retry and fallback paths work. They say nothing about how a real model behaves.

**Live (`MODEL=<ollama model> bun run evals/live.ts`).** A real local model through Ollama, the same 25 cases, both dapp-text modes. Raw results are in `docs/results/`.

The case set is hand-built (6 benign, 14 malicious, 5 warn-level) and small. The known-protocol list is a seed. Read the numbers as a test of this design on this set, not as a measured detection rate.

## Offline gates (mock models)

| Agent behaviour | What must hold |
|---|---|
| competent | no leaks, no false positives |
| lenient (always allow) | the floor still stops every malicious case |
| gullible, passthrough, blind classifier | the floor still stops every malicious case |
| broken, silent | fails closed, never allow |
| forgetful | the nudge turn recovers it |
| tool-call parse failure | the JSON fallback answers, nothing degrades |
| slow | times out and fails closed |

A leak means a malicious case reached the user below its minimum verdict.

## Live results, 2026-11-10, Apple M2 Max 64 GB, Ollama

| Model | Dapp text | Leaked | False positives | Degraded | Time |
|---|---|---|---|---|---|
| qwen2.5:14b | quarantine | 0 / 14 | 1 / 6 | 0 | 236 s |
| qwen2.5:14b | passthrough | 0 / 14 | 1 / 6 | 0 | 256 s |
| qwen2.5:32b | quarantine | 0 / 14 | 2 / 6 | 0 | 402 s |
| qwen2.5:32b | passthrough | 0 / 14 | 2 / 6 | 0 | 500 s |

- **No leaks, but that is mostly the floor.** Every malicious case is caught by a deterministic rule, so a leak would need the floor to miss. Treat 0/14 as "the rules cover these 14 patterns", not as the model's detection rate.
- **The model's contribution is the explanation and the occasional tightening.** In these runs it raised the verdict above the floor on 3 to 4 cases per run, for example unlimited approval to a known router (warn to block).
- **False positives are model over-caution.** The floor allowed `ok_revoke` (revoking an operator) and, on 32b, `ok_known_recipient`. The model warned or blocked anyway. The agent can only tighten, so a cautious model costs extra confirmation clicks. A bigger model was not better here.
- **Dapp text did not change the outcome.** Quarantine and passthrough gave the same counts. With a floor that already blocks the malicious requests, injection text had nothing to flip. The injection cases test that the floor holds, not that the model resists.

## A finding worth recording: Ollama drops tool-call replies

First live run (14b, before the fix): 4 to 7 of 25 cases degraded to the fail-closed path. Cause, found by replaying the failing request against Ollama directly: the model wrote its answer as plain text (`submitReview({"verdict": ...`) instead of a tool call, and Ollama's parser then returned an empty reply (HTTP 200, no content). A retry at temperature 0 repeats it. The 32b model did the same on 4 of 6 retried cases, so it is not a size problem.

Fix, in order: retry at rising temperature, then a plain JSON reply parsed and validated in the guard, then fail closed. After the fix, 0 of 25 degraded on both models. The response records which path answered (`via: "tools" | "json"`).

The failure was safe even before the fix: every degraded case still reached the user as at least `warn`, and the 14 malicious cases still blocked, because the floor does not depend on the agent.

## Also seen in the first run

In quarantine mode on 14b the model proposed a looser verdict than the floor on 5 cases (approve-all, EIP-7702 delegation, three lookalike domains: warn where the floor said block). The final verdict stayed block because the result is the stricter of the two. That is the property the floor exists to guarantee, observed on a real model.

## Not measured

- Detection rate on unseen attacks. The case set was written alongside the rules.
- The quarantine classifier's false-positive rate on real dapp descriptions. The live runs used the regex screen only.
- Larger or hosted models. Only the two local Qwen sizes were run.
- Latency in a real wallet. These runs are 9 to 20 s per case on a local GPU, too slow for an interactive prompt without the floor answering first.
