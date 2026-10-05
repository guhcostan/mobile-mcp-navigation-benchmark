# Mobile MCP Navigation Benchmark

A small, local benchmark of two **different automation pipelines** navigating the same iOS simulator flow:

- **Luna**: a text/tool-calling model selects among a bounded set of host-provided mobile actions.
- **CLEF-Flash**: a local typed decision model scores a bounded set of actions and semantic state assertions.

Both use Mobile MCP to interact with the same app/device, and the host owns all action validation and the final correctness oracle. This is a system-pipeline comparison, **not a model-only benchmark** and not a claim that either model generalizes to all mobile apps.

## Current prototype task

On a booted iOS simulator, focus Settings' search field, enter `Wi-Fi` without submitting it, then verify the current screen and stop. The script never taps a Settings result or changes a preference. An explicit “No Results” screen is a valid observed terminal outcome and is reported as such; it is not described as a found Wi-Fi setting.

The action set, fixed query, target package and final oracle are host controlled. The models cannot supply a device ID, package, arbitrary tool name, free-form text, or arbitrary coordinates. Every MCP reference is derived from a fresh accessibility snapshot and validated before dispatch.

## Requirements

- Node.js 20+ and npm.
- Xcode and a booted iOS Simulator.
- A local Mobile MCP npm install (`@mobilenext/mobile-mcp` 1.0.7 is the version used during development).
- A local Luna-compatible Responses API listening on loopback. Set `LUNA_MODEL` to a model accepted by that gateway. This project does not bundle a Luna model or API credential.
- CLEF-Flash model files, PyTorch/Transformers/SafeTensors and a working Apple MPS environment. The prototype was previously tested on Apple Silicon with 36 GB unified memory. It loads BF16 weights and may use additional memory for inference; weight loading and device inference time are shown separately.

The CLEF bridge uses `systemone()`-style typed choice/Noul scoring. It is not a text-generating agent. The benchmark therefore constrains the candidate actions and does not ask CLEF to invent tool calls.

## Setup

```bash
npm ci
cp .env.example .env
```

Edit `.env` locally. Keep it private and do not commit it. `MOBILE_DEVICE_ID` must identify the intended booted simulator. Configure `CLEF_PYTHON` and `CLEF_MODEL_DIR` for an environment in which the CLEF model and dependencies work. Configure `LUNA_BASE_URL` and `LUNA_MODEL` for your local Luna-compatible Responses gateway. Both endpoints must be local/loopback for the supplied runner.

Start the isolated Mobile MCP server from this project directory in a separate terminal:

```bash
MOBILEMCP_DISABLE_TELEMETRY=1 npx --no-install mcp-server-mobile --listen 127.0.0.1:30100
```

If the package executable is not on PATH, install Mobile MCP in this project (`npm install --save-dev @mobilenext/mobile-mcp@1.0.7`) and restart the shell. Confirm the server is the one listening at `http://127.0.0.1:30100/mcp`; do not connect to an unknown server. The first device-specific Mobile MCP call may install its automation helper on the simulator.

## Run the paired benchmark

From a second terminal:

```bash
set -a
. ./.env
set +a
PAIRED_TRIALS=3 npm run benchmark
```

The runner starts a local CLEF scorer and a child Mobile MCP stdio server with telemetry disabled. On macOS, it cross-checks the Mobile MCP target against `xcrun simctl` and refuses anything except the matching booted Apple simulator. It warms both model decision paths without device actions, then runs three **serial, counterbalanced pairs** (a randomized first-pair order, then alternation; an even number of pairs balances Luna-first/CLEF-first). It resets and verifies Settings state before each arm. Trial timing starts from the same verified blank, unfocused Settings search field and ends after fresh host-side verification. The device preflight must explicitly identify the target as an iOS simulator.

For a smoke run use `PAIRED_TRIALS=1`. The default three pairs are exploratory; increasing the count improves the estimate but CLEF decision latency can be variable. If a baseline cannot be reset safely or a required UI state is ambiguous, the runner aborts instead of improvising. Timeouts are failures, not permission to retry a state-changing action blindly.

## Metrics and interpretation

The JSON output records each run's system, paired order, end-to-end seconds, selected bounded actions, model decision timings/probabilities, MCP calls/latencies, UI action count and final state. Warm-up/model-load time is separate. The summary includes pairwise `Luna time − CLEF time` deltas, medians and ranges. A positive delta means CLEF was faster on that pair; a negative delta means Luna was faster.

Set `BENCHMARK_RESULTS_PATH=benchmark-results/local-results.json` to persist a mode-0600 JSON report locally. The `.gitignore` excludes that directory. Review any summary before sharing; raw outputs can reveal simulator accessibility data or machine details.

End-to-end latency includes each system's observation/decision/action loop and final verification. Model component timings differ by interface: Luna's Responses round-trip includes remote/local gateway overhead and tool-choice response; CLEF reports local encoding, MPS inference and IPC. Compare **paired system time** for the user-visible flow; treat component times as diagnostics. With three pairs, results are noisy and not statistically conclusive. Server-side Luna cold/warm cache behavior cannot be fully controlled by this local harness.

The prior pilot timings used different starting states/action counts and are intentionally not included as comparative results. Run fresh pairs from this harness before publishing a performance claim.

## Safety boundaries

- Use a disposable simulator and only `com.apple.Preferences`.
- Never use a physical or remote/cloud device in this benchmark.
- Never open the Wi-Fi search result, submit the query, toggle a setting, or provide account credentials.
- Only host-generated candidates and fresh refs can be dispatched.
- CLEF's semantic Noul score is diagnostic; a deterministic host oracle decides whether a run passed.
- Do not put API keys, `.env`, model weights, simulator UDIDs, raw accessibility trees or screenshots into GitHub.

## Development checks

```bash
npm test
npm run check
"$CLEF_PYTHON" -m py_compile clef_bridge.py
```

`npm test` exercises the host safety core using fake observations. The device benchmark additionally needs the local models, MPS, Xcode Simulator, and a trusted Mobile MCP process.

## License

MIT. See `LICENSE`.
