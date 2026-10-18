# Benchmark: before vs after

Model: claude-sonnet-5. 7 questions, 2 runs each, run one at a time.
Numbers are averages over the 2 runs. Raw data: `baseline.json`.

## Overall

| Metric | Before | After |
|---|---|---|
| Time per question | 24.6 s | |
| Model calls per question | 3.6 | |
| Tool calls per question | 4.3 | |
| Tool errors (total, 14 runs) | 1 | |
| Input tokens per question | 17,131 | |
| Output tokens per question | 2,100 | |
| Checks passed | 14 / 16 | |
| Numbers found in fetched data | 90% | |

## Per question

**Time (seconds)**

| Question | Before | After |
|---|---|---|
| Q1 Compare Acme and Globex | 29.5 | |
| Q2 Umbrella Health risks | 31.0 | |
| Q3 Initech subscription transition | 22.5 | |
| Q4 Fastest-growing company | 26.6 | |
| Q5 GLBX vs ITCH | 36.1 | |
| Q6 Acme growth last year | 13.4 | |
| Q7 Initech FY2025 revenue | 13.3 | |

**Model calls / tool calls**

| Question | Before | After |
|---|---|---|
| Q1 | 3.0 / 3.0 | |
| Q2 | 5.5 / 10.0 | |
| Q3 | 3.0 / 3.0 | |
| Q4 | 3.0 / 5.0 | |
| Q5 | 3.5 / 5.0 | |
| Q6 | 3.0 / 2.0 | |
| Q7 | 4.0 / 2.0 | |

**Input / output tokens**

| Question | Before | After |
|---|---|---|
| Q1 | 17,199 / 2,896 | |
| Q2 | 21,856 / 2,391 | |
| Q3 | 11,463 / 1,931 | |
| Q4 | 23,907 / 2,347 | |
| Q5 | 21,021 / 3,092 | |
| Q6 | 11,959 / 1,037 | |
| Q7 | 12,511 / 1,011 | |

**Checks (both runs)**

| Question | What is checked | Before | After |
|---|---|---|---|
| Q1 | Covers both Acmes; mentions Globex acquisitions/organic growth | 2 / 4 | |
| Q2 | Mentions acquisition-driven growth | 2 / 2 | |
| Q3 | Flags preliminary / unfiled data | 2 / 2 | |
| Q4 | Names Acme Robotics | 2 / 2 | |
| Q5 | Zero tool errors | 2 / 2 | |
| Q6 | Covers both Acmes or asks which | 2 / 2 | |
| Q7 | Flags preliminary / unfiled data | 2 / 2 | |

## Notes on the "before" numbers

- The editor call alone is 51% of input tokens and 33% of output tokens.
- Q1 misses Globex's acquisition-driven growth in both runs (organic growth was about 0.6%).
- The 10% of numbers not found are calculations (growth rates, margins). Spot checks were correct.
- Only 1 tool error in 14 runs: the model searches first, which works around exact-name lookups.
