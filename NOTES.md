Focus: agent behavior and performance, measured with a benchmark. Mainly improved by strengthening the tools and reworking the agent harness. Results are in `bench-results/baseline.md`.

1. Built a benchmark first (`scripts/bench.ts`) so I could hill-climb against a consistent set of questions and gate each change.
   - 7 questions (the README's 5, plus Acme ambiguity and Initech's unfiled FY2025), tracking time, model/tool calls, tokens, and simple answer checks.

2. Fixed the obvious tool failures (`src/tools.ts`).
   - Lookups accept a name or ticker in any case, and an ambiguous name like "Acme" returns both options instead of a guess.
   - Document search no longer errors on long queries or misses plurals, and financials output was trimmed to what can change an answer.

3. Reworked the agent harness for speed and accuracy (`src/agent.ts`).
   - Removed the editor pass (an extra model call over the whole transcript) and run tool calls in parallel.
   - Tool errors go back to the model marked as errors, and the prompt was rewritten around ambiguity, units/periods, and data caveats.

4. Started on traceability (unfinished).
   - Answers cite source IDs inline, e.g. [FIN-ACMR], and IDs no tool returned are flagged.
   - A number check with a hidden confidence score (`src/verify.ts`) is built but not wired up yet.

Not done: product issues, mostly for time. The main one is that chat history isn't sent with each message, so follow-ups lose context (`runAgent` accepts history, but the UI and server don't pass it). I focused on agent behavior and performance instead.
