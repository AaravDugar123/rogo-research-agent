# Benchmark results

Model: claude-sonnet-5. 7 questions, 2 runs each (14 agent runs per benchmark).
Numbers are averages per question unless noted. Raw data: `baseline.json`.

- **Before (#1):** the original code.
- **Final (#4):** forgiving tools with trimmed output, no editor pass, parallel tool calls, the new
  prompt, and inline source IDs (API citations off).

## Final vs Before

| Metric | Before | Final | Change |
|---|---|---|---|
| Time per question | 24.6 s | 11.9 s | **-52%** |
| Model calls per question | 3.6 | 2.4 | -33% |
| Tool calls per question | 4.3 | 3.1 | -28% |
| Input tokens per question | 17,131 | 10,570 | **-38%** |
| Output tokens per question | 2,100 | 974 | **-54%** |
| Tool errors (14 runs) | 1 | 0 | |
| Checks passed | 14 / 16 | 14 / 16 | same |
| Numbers found in fetched data | 90% | 91% | same |
| Answers with inline source IDs | 0 / 14 | 14 / 14 | **new** |
| Answers using markdown tables (render as raw pipes) | 7 / 14 | 0 / 14 | |
| Answers using bold (renders as raw `**`) | 14 / 14 | 3 / 14 | |
| Mean answer length | 1,765 chars | 1,344 chars | -24% |

Before ran one question at a time; Final ran all 14 at once with 0 API retries (no rate-limit waiting
hidden in the times). Time per question is measured per run, so it is comparable; whole-benchmark
time (5.7 min vs 24 s) is not, since most of that gap is the parallel benchmark runner.

## Per question

| Question | Time (s) Before / Final | Model / tool calls Before / Final | Input tokens Before / Final | Checks Before / Final |
|---|---|---|---|---|
| Q1 Compare Acme and Globex | 29.5 / 16.3 | 3.0, 3.0 / 2.0, 3.0 | 17,199 / 9,669 | 2/4 / 2/4 |
| Q2 Umbrella Health risks | 31.0 / 11.8 | 5.5, 10.0 / 4.0, 3.0 | 21,856 / 12,723 | 2/2 / 2/2 |
| Q3 Initech subscription transition | 22.5 / 11.0 | 3.0, 3.0 / 2.0, 2.0 | 11,463 / 7,168 | 2/2 / 2/2 |
| Q4 Fastest-growing company | 26.6 / 13.1 | 3.0, 5.0 / 2.0, 5.0 | 23,907 / 12,624 | 2/2 / 2/2 |
| Q5 GLBX vs ITCH | 36.1 / 19.9 | 3.5, 5.0 / 3.0, 5.5 | 21,021 / 17,512 | 2/2 / 2/2 |
| Q6 Acme growth last year | 13.4 / 6.2 | 3.0, 2.0 / 2.0, 2.0 | 11,959 / 8,055 | 2/2 / 2/2 |
| Q7 Initech FY2025 revenue | 13.3 / 5.0 | 4.0, 2.0 / 2.0, 1.0 | 12,511 / 6,244 | 2/2 / 2/2 |

Checks: Q1 and Q6 cover both Acmes (or ask which); Q1 and Q2 mention acquired or organic growth;
Q3 and Q7 flag preliminary or unfiled data; Q4 names Acme Robotics; Q5 has zero tool errors.

## What improved, and why

- **Speed and cost.** Deleting the editor pass removed one model call per question and the re-sending
  of the whole transcript (it was 51% of input tokens). Parallel tool calls and trimmed tool output
  did the rest.
- **Traceability.** Every answer now cites its sources inline, e.g. "[FIN-ACMR]", "[DOC-ITCH-001]",
  and no answer cited an ID the tools didn't return.
- **Readability.** No tables or raw tool lines, far less bold, about a quarter shorter.
- **Tools.** Q2 tool calls fell from 10 to 3: search no longer fails on long queries or misses plurals.
  "Acme" now returns an ambiguity error listing both companies instead of depending on luck.

## What's still open
More integration is needed for the source IDs, so that only quantitative claims drawn from the sources are cited, not every sentence. Some citations are misplaced, for example on the model's own conclusions. Additionally, the validation checks, specifically the regex-based number checks, were left open and need more development.