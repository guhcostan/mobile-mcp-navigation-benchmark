# Paired Luna vs CLEF-Flash benchmark

**Status:** Local exploratory result; collected on 2026-10-05. This is a three-pair measurement on one booted iOS simulator, not a general performance claim or a model-only benchmark.

| Measure | Luna | CLEF-Flash |
| --- | ---: | ---: |
| Successful runs | 3/3 | 3/3 |
| Median end-to-end time | 27.96 s | 26.83 s |

Paired Luna-minus-CLEF deltas: **+1.53 s, +0.07 s, +0.34 s**. Median paired delta: **+0.34 s** (positive means CLEF was faster in that pair). Each system performed the same two UI actions, made three bounded decisions, used the same Mobile MCP process/observation path, and passed the same host verification. All outcomes were “No Results” for `Wi-Fi`; no setting was opened or changed.

CLEF model initialization took 18.67 s and is excluded from trial timing. The Luna warm-up request took 1.91 s and is also excluded; gateway/server cache state remains opaque. In this sample, CLEF's median system-pipeline time was about 1.1 s lower. The three pairs are too few to establish a stable winner; decision timing varied, and the integrations differ (CLEF typed scoring vs. Luna function-calling). The observation, action, and host orchestration overhead is shared and substantial.

The included result is an aggregate only. Device identifiers, accessibility snapshots, raw logs, endpoint paths, and local file paths are intentionally omitted. Re-run `PAIRED_TRIALS=3 npm run benchmark` to reproduce on your own local simulator and model setup; do not interpret this sample as universal.
