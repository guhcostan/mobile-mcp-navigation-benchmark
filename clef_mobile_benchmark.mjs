import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { decideAnswer, eligibleActions, findCloseSearchControl, makeClefRecord, observeScreen, parseElementsOutput, SETTINGS_BUNDLE, SEARCH_TEXT } from './clef_mobile_core.mjs';

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.CLEF_PYTHON ?? `${process.env.HOME}/clef-flash-test/.venv/bin/python`;
const BRIDGE = process.env.CLEF_BRIDGE ?? path.join(ROOT, 'clef_bridge.py');
const MCP_COMMAND = process.env.MOBILE_MCP_COMMAND ?? path.join(ROOT, 'node_modules/.bin/mcp-server-mobile');
const TRIALS = Number(process.env.PAIRED_TRIALS ?? process.env.CLEF_TRIALS ?? 3);
const targetDevice = process.env.MOBILE_DEVICE_ID ?? '';
if (!targetDevice) throw new Error('Set MOBILE_DEVICE_ID to the intended simulator UDID');
if (!Number.isInteger(TRIALS) || TRIALS < 1 || TRIALS > 10) throw new Error('CLEF_TRIALS must be an integer from 1 to 10');
const MAX_DECISIONS = 8;
const MCP_DEVICE_TIMEOUT_MS = 180_000;
const mcp = new Client({ name: 'clef-mobile-benchmark', version: '1.0.0' });
let mcpProcessId = null;
const mcpTransport = new StdioClientTransport({
  command: MCP_COMMAND,
  args: ['--stdio'],
  cwd: ROOT,
  env: { ...process.env, MOBILEMCP_DISABLE_TELEMETRY: '1' },
  stderr: 'pipe',
});
const scorer = spawn(PYTHON, ['-u', BRIDGE], {
  cwd: ROOT,
  env: { ...process.env, PYTHONUNBUFFERED: '1' },
  stdio: ['pipe', 'pipe', 'inherit'],
});
scorer.stdin.setDefaultEncoding('utf8');
let scorerBuffer = '';
let scorerLines = [];
let scorerReady;
let scorerReadyResolve;
let scorerReadyReject;
const scorerInitialized = new Promise((resolve, reject) => {
  scorerReadyResolve = resolve;
  scorerReadyReject = reject;
});
let bridgePending = null;
scorer.stdout.setEncoding('utf8');
scorer.stdout.on('data', (chunk) => {
  scorerBuffer += chunk;
  for (;;) {
    const index = scorerBuffer.indexOf('\n');
    if (index < 0) break;
    const line = scorerBuffer.slice(0, index).trim();
    scorerBuffer = scorerBuffer.slice(index + 1);
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch (error) {
      scorerReadyReject(error);
      continue;
    }
    if (parsed.ready !== undefined && !scorerReady) {
      scorerReady = parsed;
      if (parsed.ready) scorerReadyResolve(parsed);
      else scorerReadyReject(new Error(parsed.error || 'CLEF scorer failed to load'));
    } else if (bridgePending && parsed.id === bridgePending.id) {
      const pending = bridgePending;
      bridgePending = null;
      clearTimeout(pending.timeout);
      if (parsed.error) pending.reject(new Error(parsed.error));
      else pending.resolve({ response: parsed, ipcMilliseconds: performance.now() - pending.started });
    } else {
      scorerLines.push(parsed);
    }
  }
});
scorer.on('error', (error) => scorerReadyReject(error));
scorer.on('exit', (code, signal) => {
  if (!scorerReady) scorerReadyReject(new Error(`CLEF scorer exited (${code ?? signal}) before ready`));
});

function normalizeToolResult(result, toolName) {
  const text = (result.content ?? [])
    .map((item) => item.type === 'text' ? item.text : `[${item.type}]`)
    .join('\n');
  if (result.isError || /^Error:/.test(text)) throw new Error(`${toolName}: ${text.slice(0, 1200)}`);
  return text;
}

async function mobileCall(name, args, metrics, { setup = false } = {}) {
  if (name !== 'mobile_list_available_devices' && args.device !== targetDevice) {
    throw new Error(`Refusing Mobile MCP call for non-approved simulator: ${name}`);
  }
  if (name === 'mobile_launch_app' && args.packageName !== SETTINGS_BUNDLE) {
    throw new Error(`Refusing to launch package ${args.packageName}`);
  }
  if (name === 'mobile_type_keys' && (args.text !== SEARCH_TEXT || args.submit !== false)) {
    throw new Error('Refusing text input outside fixed Wi-Fi without submit');
  }
  const start = performance.now();
  let timeout;
  const result = await Promise.race([
    mcp.callTool({ name, arguments: args }),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${name} timed out after ${MCP_DEVICE_TIMEOUT_MS} ms`)), MCP_DEVICE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timeout));
  const elapsed = performance.now() - start;
  const text = normalizeToolResult(result, name);
  if (!setup) metrics.push({ tool: name, milliseconds: +elapsed.toFixed(1) });
  return text;
}

function bridgeRequest(record) {
  if (bridgePending) throw new Error('CLEF scorer supports one outstanding request at a time');
  const id = `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (bridgePending?.id === id) bridgePending = null;
      reject(new Error('CLEF scorer timed out'));
    }, 120_000);
    bridgePending = { id, started, timeout, resolve, reject };
    scorer.stdin.write(`${JSON.stringify({ id, record })}\n`, (error) => {
      if (error && bridgePending?.id === id) {
        bridgePending = null;
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

function responseForDecision(bridgeResponse, observation) {
  return { ...bridgeResponse.response, _observation: observation };
}

async function getObservation(metrics, { setup = false } = {}) {
  const foreground = await mobileCall('mobile_get_foreground_app', { device: targetDevice }, metrics, { setup });
  const elementsText = await mobileCall('mobile_list_elements_on_screen', { device: targetDevice, format: 'json' }, metrics, { setup });
  const elements = parseElementsOutput(elementsText);
  return observeScreen(foreground, elements);
}

function findExactActionTarget(observation, selected) {
  if (selected.id === 'focus_search') {
    if (!observation.searchField || !observation.searchField.ref) throw new Error('Search field ref is unavailable');
    return observation.searchField.ref;
  }
  if (selected.id === 'clear_query') return selected.ref;
  return null;
}

async function executeAction(selected, observation, metrics, { setup = false } = {}) {
  switch (selected.id) {
    case 'launch_settings':
      await mobileCall('mobile_launch_app', { device: targetDevice, packageName: SETTINGS_BUNDLE }, metrics, { setup });
      return { changed: true };
    case 'focus_search':
    case 'clear_query':
    case 'dismiss_search': {
      const ref = findExactActionTarget(observation, selected);
      const fresh = await getObservation(metrics, { setup });
      const freshCandidates = eligibleActions(fresh, { reset: selected.id === 'clear_query' && observation.query === SEARCH_TEXT });
      const freshCandidate = freshCandidates.find((candidate) => candidate.id === selected.id);
      if (!freshCandidate || freshCandidate.ref !== ref) throw new Error(`Refusing stale element ref ${ref}`);
      if (selected.id === 'focus_search' && fresh.elements.find((element) => element.ref === ref)?.type !== 'SearchField') {
        throw new Error('Refusing stale or non-search target');
      }
      if (selected.id === 'clear_query' && fresh.query === '') throw new Error('Clear target no longer has text to clear');
      if (selected.id === 'dismiss_search' && !findCloseSearchControl(fresh.elements)) throw new Error('Close target is not a current Close/Cancel button');
      if (!fresh.settingsForeground) throw new Error('Settings lost foreground before tap');
      await mobileCall('mobile_click_on_screen_at_coordinates', { device: targetDevice, ref }, metrics, { setup });
      return { changed: true };
    }
    case 'type_wifi': {
      const fresh = await getObservation(metrics, { setup });
      if (!fresh.settingsForeground || fresh.query !== '' || fresh.searchField?.focused !== true) {
        throw new Error('Refusing to type unless fresh Settings search is focused and empty');
      }
      await mobileCall('mobile_type_keys', { device: targetDevice, text: SEARCH_TEXT, submit: false }, metrics, { setup });
      return { changed: true };
    }
    case 'wait_for_results':
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { changed: false, wait: true };
    case 'stop':
      return { changed: false, stop: true };
    case 'block':
      return { changed: false, stop: true, blocked: true };
    default:
      throw new Error(`Refusing unknown CLEF action ${selected.id}`);
  }
}

async function runTrial(trialNumber) {
  const metrics = [];
  const decisions = [];
  const start = performance.now();
  const maxConsecutiveNoChange = 3;
  let consecutiveNoChange = 0;
  let outcome = 'unknown';
  let semanticProbability = null;
  let semanticTerminal = null;
  let selectedIds = [];
  let stopped = false;

  for (let step = 0; step < MAX_DECISIONS; step += 1) {
    const observation = await getObservation(metrics);
    let candidates = eligibleActions(observation);
    if (candidates.length > 24) throw new Error('Host candidate list exceeded CLEF choice limit');
    const record = makeClefRecord(observation, candidates, `trial-${trialNumber}-step-${step + 1}`);
    const { response, ipcMilliseconds } = await bridgeRequest(record);
    const clefResponse = responseForDecision(response, observation);
    const decision = decideAnswer(clefResponse, candidates, observation);
    const selected = decision.choice;
    const timing = response.timing;
    decisions.push({
      step: step + 1,
      selected_action: selected.id,
      probabilities: decision.choiceProbabilities,
      search_state_probability: decision.searchStateProbability,
      semantic_terminal_outcome: decision.terminalOutcomeChoice,
      semantic_terminal_probabilities: decision.terminalOutcomeProbabilities,
      encode_ms: +(timing.encode_seconds * 1000).toFixed(1),
      inference_ms: +(timing.inference_seconds * 1000).toFixed(1),
      bridge_round_trip_ms: +ipcMilliseconds.toFixed(1),
      tokens: response.response.usage?.input_tokens,
    });
    selectedIds.push(selected.id);
    if (selected.id === 'stop') {
      outcome = observation.outcome;
      stopped = true;
      break;
    }
    if (selected.id === 'block') throw new Error('CLEF selected BLOCK; aborting without a UI action');

    const actionResult = await executeAction(selected, observation, metrics);
    if (actionResult.changed) consecutiveNoChange = 0;
    else if (actionResult.wait) consecutiveNoChange += 1;
    if (consecutiveNoChange >= maxConsecutiveNoChange) {
      throw new Error('Stopped after repeated no-change wait decisions');
    }
  }

  if (!stopped) throw new Error(`CLEF did not reach a safe stop within ${MAX_DECISIONS} decisions`);
  const verifyMetrics = [];
  const finalObservation = await getObservation(verifyMetrics);
  metrics.push(...verifyMetrics);
  const deterministic = {
    settingsForeground: finalObservation.settingsForeground,
    exactQuery: finalObservation.query === SEARCH_TEXT,
    outcome: finalObservation.outcome,
    passed: finalObservation.settingsForeground
      && finalObservation.query === SEARCH_TEXT
      && ['no_results', 'result_found'].includes(finalObservation.outcome),
  };
  if (!deterministic.passed) outcome = finalObservation.outcome;
  semanticProbability = decisions.at(-1)?.search_state_probability ?? null;
  semanticTerminal = decisions.at(-1)?.semantic_terminal_outcome ?? null;
  const modelLoadSeconds = scorerReady?.model_load_seconds ?? null;
  const inferenceTotalMs = decisions.reduce((sum, item) => sum + item.inference_ms, 0);
  const encodeTotalMs = decisions.reduce((sum, item) => sum + item.encode_ms, 0);
  return {
    trial: trialNumber,
    elapsed_seconds: +((performance.now() - start) / 1000).toFixed(3),
    actions: selectedIds,
    decisions,
    mobile_mcp_calls: metrics,
    mobile_mcp_call_count: metrics.length,
    ui_action_count: metrics.filter((item) => ['mobile_launch_app', 'mobile_click_on_screen_at_coordinates', 'mobile_type_keys'].includes(item.tool)).length,
    clef_inference_total_ms: +inferenceTotalMs.toFixed(1),
    clef_encode_total_ms: +encodeTotalMs.toFixed(1),
    clef_model_load_seconds: modelLoadSeconds,
    final_semantic_search_probability: semanticProbability,
    final_semantic_terminal_outcome: semanticTerminal,
    deterministic_oracle: deterministic,
    outcome,
  };
}

async function resetToBlankSearch(metrics) {
  let observation = await getObservation(metrics, { setup: true });
  if (!observation.settingsForeground) {
    await mobileCall('mobile_launch_app', { device: targetDevice, packageName: SETTINGS_BUNDLE }, metrics, { setup: true });
    observation = await getObservation(metrics, { setup: true });
  }
  if (!observation.settingsForeground || !observation.searchField) {
    throw new Error('Could not establish Settings root/search before reset');
  }
  for (let step = 0; observation.query && step < 3; step += 1) {
    const candidates = eligibleActions(observation, { reset: true });
    const resetAction = candidates.find((candidate) => ['focus_search', 'clear_query'].includes(candidate.id));
    if (!resetAction) throw new Error('Cannot safely normalize the existing search query');
    await executeAction(resetAction, observation, metrics, { setup: true });
    observation = await getObservation(metrics, { setup: true });
  }
  if (observation.query) throw new Error('Could not safely clear existing search after three guarded actions');
  const resetCandidates = eligibleActions(observation, { reset: true });
  const dismiss = resetCandidates.find((candidate) => candidate.id === 'dismiss_search');
  if (dismiss) {
    await executeAction(dismiss, observation, metrics, { setup: true });
    observation = await getObservation(metrics, { setup: true });
    if (observation.query !== '' || !observation.searchField || observation.searchField.focused === true) {
      throw new Error('Could not verify the common root, blank and unfocused search baseline');
    }
  }
  if (observation.query !== '' || observation.searchField?.focused === true) {
    throw new Error('Could not establish blank, unfocused Settings search before timed trial');
  }
}

async function main() {
  let endpointReady;
  try {
    endpointReady = await scorerInitialized;
  } catch (error) {
    throw new Error(`Could not start CLEF scorer: ${error.message}`);
  }
  const ready = endpointReady;
  if (!ready.ready || ready.device !== 'mps') throw new Error(`CLEF scorer not ready on MPS: ${JSON.stringify(ready)}`);
  scorerReady = ready;
  console.log(JSON.stringify({ scorer_ready: true, device: ready.device, model_load_seconds: ready.model_load_seconds }));

  await mcp.connect(mcpTransport);
  mcpProcessId = mcpTransport.pid;
  const listed = normalizeToolResult(await mcp.callTool({ name: 'mobile_list_available_devices', arguments: {} }), 'mobile_list_available_devices');
  const devices = JSON.parse(listed).devices;
  if (!devices.some((item) => item.id === targetDevice && item.state === 'online')) {
    throw new Error('Approved test simulator is not online according to Mobile MCP');
  }

  const trials = [];
  for (let trialNumber = 1; trialNumber <= TRIALS; trialNumber += 1) {
    const setupMetrics = [];
    await resetToBlankSearch(setupMetrics);
    const trial = await runTrial(trialNumber);
    trial.setup_calls_excluded_from_timed_trial = setupMetrics;
    trials.push(trial);
    console.log(JSON.stringify({ trial }));
    if (!trial.deterministic_oracle.passed) break;
  }

  const times = trials.map((trial) => trial.elapsed_seconds).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const median = times.length === 0 ? null : times.length % 2 === 1 ? times[middle] : (times[middle - 1] + times[middle]) / 2;
  console.log(JSON.stringify({
    summary: {
      completed_trials: trials.length,
      passed_trials: trials.filter((trial) => trial.deterministic_oracle.passed).length,
      median_e2e_seconds: median,
      range_seconds: times.length ? [times[0], times.at(-1)] : null,
      model_load_seconds_excluded_from_trials: ready.model_load_seconds,
      note: 'CLEF is a bounded typed scorer, not text/tool-calling. Semantic score supplements; deterministic host checks decide pass/fail.',
    },
  }));
}

try {
  await main();
} finally {
  if (mcpProcessId !== null) {
    try { process.kill(mcpProcessId, 'SIGTERM'); } catch {}
  }
  if (scorer.exitCode === null) {
    scorer.kill('SIGTERM');
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      scorer.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    if (scorer.exitCode === null) scorer.kill('SIGKILL');
  }
}
