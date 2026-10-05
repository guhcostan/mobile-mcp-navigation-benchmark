# Paired Luna vs CLEF-Flash benchmark

**Status:** Local exploratory result; collected on 2026-10-05. This is a three-pair measurement on one booted iOS simulator, not a general performance claim or a model-only benchmark.

| Measure | Luna | CLEF-Flash |
| --- | ---: | ---: |
| Successful runs | 3/3 | 3/3 |
| Median end-to-end time | 30.73 s | 29.75 s |

Paired Luna-minus-CLEF deltas: **+6.09 s, +0.98 s, −11.87 s**. Median paired delta: **+0.98 s** (positive means CLEF was faster in that pair). Each system performed the same two UI actions, made three bounded decisions, used the same Mobile MCP process/observation path, and passed the same host verification. All outcomes were “No Results” for `Wi-Fi`; no setting was opened or changed.

CLEF model initialization took 19.06 s and is excluded from trial timing. The Luna warm-up request took 5.54 s and is also excluded; gateway/server cache state remains opaque. The median times were close, with mixed paired deltas. This sample is too small and variable to establish a stable winner; decision latency differed per run, and the integrations differ (CLEF typed scoring vs. Luna function-calling). Shared observation, action, and host orchestration overhead was substantial.

The included result is an aggregate only. Device identifiers, accessibility snapshots, raw logs, endpoint paths, and local file paths are intentionally omitted. Re-run `PAIRED_TRIALS=3 npm run benchmark` to reproduce on your own local simulator and model setup; do not interpret this sample as universal.
