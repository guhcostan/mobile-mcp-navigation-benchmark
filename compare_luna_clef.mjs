import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { summarizePairs } from './benchmark_stats.mjs';
import {
  decideAnswer,
  eligibleActions,
  makeClefRecord,
  observeScreen,
  parseElementsOutput,
  SETTINGS_BUNDLE,
  SEARCH_TEXT,
  isApprovedSimulator,
} from './clef_mobile_core.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME ?? '';
const targetDevice = process.env.MOBILE_DEVICE_ID;
const lunaModel = process.env.LUNA_MODEL ?? 'codeen/gpt-6-luna';
const lunaBase = new URL(process.env.LUNA_BASE_URL ?? 'http://127.0.0.1:10100/v1');
const mcpCommand = process.env.MOBILE_MCP_COMMAND ?? path.join(ROOT, 'node_modules/.bin/mcp-server-mobile');
const python = process.env.CLEF_PYTHON ?? path.join(HOME, 'clef-flash-test/.venv/bin/python');
const bridge = process.env.CLEF_BRIDGE ?? path.join(ROOT, 'clef_bridge.py');
const pairCount = Number(process.env.PAIRED_TRIALS ?? 3);
const actionBudget = 8;
const modelTimeoutMs = 180_000;
const warmupTimeoutMs = 180_000;
const mcpTimeoutMs = 180_000;
const resultPath = process.env.BENCHMARK_RESULTS_PATH ?? '';

if (!targetDevice) throw new Error('Set MOBILE_DEVICE_ID to the approved booted simulator UDID');
if (!['localhost', '127.0.0.1', '::1'].includes(lunaBase.hostname.replace(/^\[|\]$/g, ''))) {
  throw new Error('For this local benchmark, LUNA_BASE_URL must use loopback');
}
if (!Number.isInteger(pairCount) || pairCount < 1 || pairCount > 10) {
  throw new Error('PAIRED_TRIALS must be an integer from 1 to 10');
}

const mcp = new Client({ name: 'luna-clef-paired-benchmark', version: '1.0.0' });
const mcpTransport = new StdioClientTransport({
  command: mcpCommand,
  args: ['--stdio'],
  cwd: ROOT,
  env: { ...process.env, MOBILEMCP_DISABLE_TELEMETRY: '1' },
  stderr: 'pipe',
});
let scorer;
let scorerReady = null;
let scorerBuffer = '';
let bridgePending = null;
let mcpPid = null;
let scorerRequestSerial = 0;
let lunaRequestSerial = 0;
let deviceStateUncertain = false;
let scorerUncertain = false;
let resolveScorerReady;
let rejectScorerReady;
const scorerReadyPromise = new Promise((resolve, reject) => {
  resolveScorerReady = resolve;
  rejectScorerReady = reject;
});

function startScorer() {
  if (scorer) throw new Error('CLEF scorer already started');
  scorer = spawn(python, ['-u', bridge], {
    cwd: ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  scorer.stdin.setDefaultEncoding('utf8');
  scorer.stdout.setEncoding('utf8');
  scorer.stdout.on('data', (chunk) => {
    scorerBuffer += chunk;
    while (scorerBuffer.includes('\n')) {
      const index = scorerBuffer.indexOf('\n');
      const line = scorerBuffer.slice(0, index).trim();
      scorerBuffer = scorerBuffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (error) { rejectScorerReady(error); continue; }
      if (message.ready !== undefined && !scorerReady) {
        scorerReady = message;
        if (message.ready) resolveScorerReady(message);
        else rejectScorerReady(new Error(message.error ?? 'CLEF failed to initialize'));
      } else if (bridgePending?.id === message.id) {
        const pending = bridgePending;
        bridgePending = null;
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve({ data: message, ipcSeconds: (performance.now() - pending.started) / 1000 });
      }
    }
  });
  scorer.once('error', rejectScorerReady);
  scorer.once('exit', (code, signal) => {
    if (!scorerReady) rejectScorerReady(new Error(`CLEF exited during startup (${code ?? signal})`));
    if (bridgePending) {
      clearTimeout(bridgePending.timeout);
      bridgePending.reject(new Error('CLEF exited while decision pending'));
      bridgePending = null;
    }
  });
}

function resultText(result, name) {
  const text = result.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') ?? '';
  if (result.isError || /^Error:/.test(text)) throw new Error(`${name}: ${text.slice(0, 1000)}`);
  return text;
}

async function callMobile(name, args, metrics, { setup = false } = {}) {
  if (deviceStateUncertain && !setup && name !== 'mobile_list_available_devices') {
    throw new Error('Device state uncertain after prior timeout; refusing further benchmark calls');
  }
  if (name !== 'mobile_list_available_devices' && args.device !== targetDevice) throw new Error(`wrong-device guard: ${name}`);
  if (name === 'mobile_launch_app' && args.packageName !== SETTINGS_BUNDLE) throw new Error('package guard rejected launch');
  if (name === 'mobile_type_keys' && (args.text !== SEARCH_TEXT || args.submit !== false)) throw new Error('text guard rejected input');
  const started = performance.now();
  let timeout;
  const pending = mcp.callTool({ name, arguments: args });
  const result = await Promise.race([
    pending,
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        if (['mobile_launch_app', 'mobile_click_on_screen_at_coordinates', 'mobile_type_keys'].includes(name)) {
          deviceStateUncertain = true;
        }
        reject(new Error(`${name} timed out${deviceStateUncertain ? '; device state may have changed' : ''}`));
      }, mcpTimeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
  const seconds = (performance.now() - started) / 1000;
  const text = resultText(result, name);
  if (!setup) metrics.push({ name, seconds });
  return text;
}

async function observe(metrics, { setup = false } = {}) {
  const foreground = await callMobile('mobile_get_foreground_app', { device: targetDevice }, metrics, { setup });
  const raw = await callMobile('mobile_list_elements_on_screen', { device: targetDevice, format: 'json' }, metrics, { setup });
  const all = parseElementsOutput(raw);
  const pruned = all.filter((element) => {
    if (element.type === 'SearchField') return true;
    const value = [element.label, element.name, element.value, element.identifier].filter(Boolean).join(' ')
      .normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    return /wi-?fi|nenhum resultado|no results|buscar|search|limpar texto|clear text|fechar|cancelar|cancel|close/.test(value)
      && !/barras wi-fi/.test(value);
  }).slice(0, 24);
  return observeScreen(foreground, pruned);
}

function lunaTools(candidates) {
  return [{
    type: 'function',
    name: 'choose_action',
    description: 'Set exactly one eligible action key to true and every other key to false. Never provide action arguments.',
    parameters: {
      type: 'object',
      properties: Object.fromEntries(candidates.map((candidate) => [candidate.id, { type: 'boolean' }])),
      required: candidates.map((candidate) => candidate.id),
      additionalProperties: false,
    },
    strict: true,
  }];
}

async function lunaRequest(payload, decisionMetrics, { warmup = false } = {}) {
  const started = performance.now();
  const response = await fetch(new URL('responses', lunaBase.href.endsWith('/') ? lunaBase : new URL(`${lunaBase.href}/`)), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(warmup ? warmupTimeoutMs : modelTimeoutMs),
  });
  const body = await response.json();
  const seconds = (performance.now() - started) / 1000;
  if (!response.ok || body.error) throw new Error(`Luna HTTP ${response.status}: ${JSON.stringify(body.error ?? body).slice(0, 800)}`);
  if (!warmup) decisionMetrics.push({ model_call: 'LUNA', seconds, request_number: ++lunaRequestSerial });
  return { body, seconds };
}

async function askLuna(state, candidates, decisionMetrics, { warmup = false } = {}) {
  const response = await lunaRequest({
    model: lunaModel,
    instructions: 'Use only the current eligible_actions in the supplied state. Set exactly one eligible action key to true and every other key to false. Never invent arguments. Choose block when evidence is ambiguous. The host executes, validates, and verifies; you do not directly interact with the simulator.',
    input: JSON.stringify(state),
    tools: lunaTools(candidates),
    tool_choice: 'required',
    max_output_tokens: 128,
  }, decisionMetrics, { warmup });
  const call = (response.body.output ?? []).find((item) => item.type === 'function_call' && item.name === 'choose_action');
  if (!call) throw new Error('Luna response omitted choose_action');
  const args = JSON.parse(call.arguments);
  const selected = candidates.filter((candidate) => args[candidate.id] === true);
  if (Object.keys(args).length !== candidates.length || candidates.some((candidate) => typeof args[candidate.id] !== 'boolean') || selected.length !== 1) {
    throw new Error('Luna response did not choose exactly one current candidate');
  }
  return { actionId: selected[0].id, seconds: response.seconds };
}

async function askClef(record, decisionMetrics, { warmup = false } = {}) {
  if (bridgePending) throw new Error('CLEF scorer requests must be serial');
  const id = `clef-${Date.now()}-${++scorerRequestSerial}`;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (bridgePending?.id === id) bridgePending = null;
      scorerUncertain = true;
      reject(new Error('CLEF decision timed out; scorer state uncertain, aborting benchmark'));
    }, modelTimeoutMs);
    bridgePending = { id, started, timeout, resolve, reject };
    scorer.stdin.write(`${JSON.stringify({ id, record })}\n`, (error) => {
      if (error && bridgePending?.id === id) {
        bridgePending = null;
        clearTimeout(timeout);
        reject(error);
      }
    });
  }).then((result) => {
    if (!warmup) decisionMetrics.push({
      model_call: 'CLEF', inference_seconds: result.data.timing.inference_seconds,
      encode_seconds: result.data.timing.encode_seconds, round_trip_seconds: result.ipcSeconds,
      request_number: scorerRequestSerial, input_tokens: result.data.response.usage?.input_tokens,
    });
    return result;
  });
}

function validateAction(observation, candidates, actionId) {
  if (actionId === 'block') throw new Error('Model selected BLOCK; no UI action performed');
  const candidate = candidates.find((item) => item.id === actionId);
  if (!candidate) throw new Error(`Action ${actionId} was not eligible`);
  if (candidate.ref && !observation.elements.some((element) => element.ref === candidate.ref)) throw new Error(`Stale ref ${candidate.ref}`);
  if (actionId === 'focus_search' && observation.elements.find((element) => element.ref === candidate.ref)?.type !== 'SearchField') {
    throw new Error('Focus target is not a current SearchField');
  }
  if (actionId === 'clear_query' && observation.searchField?.focused !== true) throw new Error('Search field is not focused for Clear Text');
  if (actionId === 'type_wifi' && (!observation.settingsForeground || observation.query !== '' || observation.searchField?.focused !== true)) {
    throw new Error('Type guard requires focused, empty Settings search');
  }
  if (actionId === 'stop' && (!observation.settingsForeground || observation.query !== SEARCH_TEXT || !['result_found', 'no_results'].includes(observation.outcome))) {
    throw new Error('Stop requires fresh terminal evidence');
  }
  return candidate;
}

async function executeCommon(actionId, observation, candidates, calls, { setup = false, reset = false } = {}) {
  const candidate = validateAction(observation, candidates, actionId);
  if (actionId === 'stop') return 'stop';
  if (actionId === 'launch_settings') {
    await callMobile('mobile_launch_app', { device: targetDevice, packageName: SETTINGS_BUNDLE }, calls, { setup });
  } else if (actionId === 'type_wifi') {
    const fresh = await observe(calls, { setup });
    if (!fresh.settingsForeground || fresh.searchField?.focused !== true || fresh.query !== '') throw new Error('Search changed before type dispatch');
    await callMobile('mobile_type_keys', { device: targetDevice, text: SEARCH_TEXT, submit: false }, calls, { setup });
  } else if (['focus_search', 'clear_query', 'dismiss_search'].includes(actionId)) {
    const fresh = await observe(calls, { setup });
    const current = eligibleActions(fresh, { reset }).find((item) => item.id === actionId);
    if (!fresh.settingsForeground || !current || current.ref !== candidate.ref || !fresh.elements.some((element) => element.ref === current.ref)) {
      throw new Error(`Current ${actionId} target changed before dispatch`);
    }
    if (actionId === 'clear_query' && fresh.searchField?.focused !== true) throw new Error('Cannot clear unfocused search field');
    await callMobile('mobile_click_on_screen_at_coordinates', { device: targetDevice, ref: current.ref }, calls, { setup });
  } else if (actionId === 'wait_for_results') {
    await new Promise((resolve) => setTimeout(resolve, 500));
  } else {
    throw new Error(`Unknown host action ${actionId}`);
  }
  return 'continue';
}

async function modelDecision(system, observation, candidates, history, pair, step, decisions) {
  if (system === 'LUNA') {
    const state = makeClefRecord(observation, candidates, `pair-${pair}-step-${step}`).state;
    state.action_history = history;
    state.eligible_actions = candidates.map(({ id, description }) => ({ id, description }));
    return (await askLuna(state, candidates, decisions)).actionId;
  }
  const record = makeClefRecord(observation, candidates, `pair-${pair}-step-${step}`);
  record.state.action_history = history;
  const result = await askClef(record, decisions);
  return decideAnswer(result.data.response, candidates, observation).choice.id;
}

async function runOne(system, pair, calls) {
  const start = performance.now();
  const history = [];
  const decisions = [];
  let stopped = false;
  let failure = null;
  for (let step = 1; step <= actionBudget; step += 1) {
    let observation;
    let candidates;
    let selected;
    try {
      observation = await observe(calls);
      candidates = eligibleActions(observation);
      selected = await modelDecision(system, observation, candidates, history, pair, step, decisions);
      history.push({ action: selected, prior_outcome: observation.outcome });
      const actionResult = await executeCommon(selected, observation, candidates, calls);
      if (actionResult === 'stop') { stopped = true; break; }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  const finalObservation = deviceStateUncertain ? null : await observe(calls).catch((error) => {
    failure ??= `Final verification failed: ${error instanceof Error ? error.message : String(error)}`;
    return null;
  });
  const success = Boolean(stopped && finalObservation?.settingsForeground && finalObservation.query === SEARCH_TEXT && ['result_found', 'no_results'].includes(finalObservation.outcome));
  return {
    system,
    pair,
    seconds: (performance.now() - start) / 1000,
    success,
    failure,
    outcome: finalObservation?.outcome ?? 'unknown',
    final_settings_foreground: finalObservation?.settingsForeground ?? false,
    final_query: finalObservation?.query ?? '',
    action_history: history,
    decisions,
    mcp_calls: calls,
    mcp_call_count: calls.length,
    ui_actions: calls.filter((call) => ['mobile_launch_app','mobile_click_on_screen_at_coordinates','mobile_type_keys'].includes(call.name)).length,
    device_state_uncertain: deviceStateUncertain,
  };
}

async function resetBaseline(calls) {
  deviceStateUncertain = false;
  let observation = await observe(calls, { setup: true });
  if (!observation.settingsForeground) {
    await callMobile('mobile_launch_app', { device: targetDevice, packageName: SETTINGS_BUNDLE }, calls, { setup: true });
    observation = await observe(calls, { setup: true });
  }
  if (!observation.settingsForeground || !observation.searchField) throw new Error('Settings root/search baseline unavailable');
  let inspected = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidates = eligibleActions(observation, { reset: true });
    let id;
    if (!observation.query && observation.searchField?.focused !== true && !inspected) { id = 'focus_search'; inspected = true; }
    else if (observation.query) id = candidates.find((item) => item.id === 'clear_query')?.id ?? candidates.find((item) => item.id === 'focus_search')?.id;
    else if (!observation.query && observation.searchField?.focused === true) id = candidates.find((item) => item.id === 'dismiss_search')?.id;
    if (!id) break;
    await executeCommon(id, observation, candidates, calls, { setup: true, reset: true });
    observation = await observe(calls, { setup: true });
  }
  if (!observation.settingsForeground || observation.query !== '' || observation.searchField?.focused === true) {
    throw new Error('Common baseline requires Settings root with blank, unfocused search');
  }
}

async function warmLuna() {
  const syntheticObservation = {
    settingsForeground: true,
    foregroundText: `Foreground app: Settings (${SETTINGS_BUNDLE})`,
    searchField: { ref: 'synthetic', type: 'SearchField', value: '', focused: false },
    query: '', outcome: 'incomplete',
    elements: [{ ref: 'synthetic', type: 'SearchField', label: 'Search', value: '', focused: false }],
  };
  const candidates = eligibleActions(syntheticObservation);
  const decisionMetrics = [];
  const state = makeClefRecord(syntheticObservation, candidates, 'luna-warmup').state;
  state.eligible_actions = candidates.map(({ id, description }) => ({ id, description }));
  const decision = await askLuna(state, candidates, decisionMetrics, { warmup: true });
  return { seconds: decision.seconds, selected_action: decision.actionId, decision_metrics_excluded: decisionMetrics.length };
}

function safeFailure(message) {
  return String(message ?? 'unknown failure').replaceAll(HOME, '<HOME>');
}

async function main() {
  // Preflight local device control before loading the large CLEF model.
  await mcp.connect(mcpTransport);
  mcpPid = mcpTransport.pid;
  const listed = JSON.parse(resultText(await mcp.callTool({ name: 'mobile_list_available_devices', arguments: {} }), 'device list')).devices;
  const approved = listed.find((device) => device.id === targetDevice && device.state === 'online' && isApprovedSimulator(device));
  if (!approved) throw new Error('Approved iOS simulator offline or target is not explicitly identified as a simulator');
  const { execFileSync } = await import('node:child_process');
  const simctl = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], { encoding: 'utf8' }));
  const localSimulator = Object.values(simctl.devices).flat().find((device) => device.udid?.toLowerCase() === String(targetDevice).toLowerCase());
  if (!localSimulator || localSimulator.state !== 'Booted' || !localSimulator.deviceTypeIdentifier?.startsWith('com.apple.CoreSimulator.SimDeviceType.')) {
    throw new Error('Target device is not a booted Apple CoreSimulator device; refusing any interaction');
  }
  if (approved.name && approved.name !== localSimulator.name) throw new Error('Mobile MCP device name does not match local CoreSimulator inventory');
  const lunaWarmup = await warmLuna();
  startScorer();
  const ready = await scorerReadyPromise;
  const syntheticObservation = { settingsForeground:true, foregroundText:`Foreground app: Settings (${SETTINGS_BUNDLE})`, searchField:{ref:'synthetic',type:'SearchField',value:'',focused:true}, query:'', outcome:'incomplete', elements:[{ref:'synthetic',type:'SearchField',value:'',focused:true}] };
  const warmCandidates = [{ id:'block', description:'No action for warmup.' }];
  const warmRecord = makeClefRecord(syntheticObservation, warmCandidates, 'clef-warmup');
  // Score a harmless synthetic record to warm CLEF; never interpret or dispatch its choice.
  const clefWarm = await askClef(warmRecord, [], { warmup:true });
  console.log(JSON.stringify({ warmup:{ luna_seconds:lunaWarmup.seconds, luna_selected_action:lunaWarmup.selected_action, clef_load_seconds:ready.model_load_seconds, clef_inference_seconds:clefWarm.data.timing.inference_seconds } }));

  const firstSystem = Math.random() < 0.5 ? 'LUNA' : 'CLEF';
  const secondSystem = firstSystem === 'LUNA' ? 'CLEF' : 'LUNA';
  const orderPlan = Array.from({ length: pairCount }, (_, i) => i % 2 === 0
    ? [firstSystem, secondSystem]
    : [secondSystem, firstSystem]);
  const pairs = [];
  for (let pair=1; pair<=pairCount; pair+=1) {
    const runs=[];
    for (const system of orderPlan[pair-1]) {
      const setupCalls=[];
      await resetBaseline(setupCalls);
      const baseline=await observe(setupCalls,{setup:true});
      if (!baseline.settingsForeground || baseline.query !== '' || baseline.searchField?.focused === true) {
        throw new Error('The Settings blank/unfocused baseline changed immediately before the timed run');
      }
      const calls=[];
      const run = await runOne(system,pair,calls);
      run.setup_calls_excluded=setupCalls;
      run.baseline_verified=true;
      runs.push(run);
      console.log(JSON.stringify({ run }));
      if (run.device_state_uncertain || scorerUncertain) throw new Error('Device or scorer state uncertain; aborting remaining pairs');
    }
    pairs.push({ pair, order:orderPlan[pair-1], runs });
  }
  const stats=summarizePairs(pairs);
  const report = {
    schema_version:1,
    created_at:new Date().toISOString(),
    configuration:{ settings_bundle:SETTINGS_BUNDLE, search_text:SEARCH_TEXT, pairs:pairCount, action_budget:actionBudget },
    warmup:{ luna_seconds:lunaWarmup.seconds, luna_selected_action:lunaWarmup.selected_action, clef_load_seconds:ready.model_load_seconds, clef_inference_seconds:clefWarm.data.timing.inference_seconds },
    pairs,
    summary:{
      pairs_requested:pairCount,
      valid_successful_pairs:stats.successfulPairs,
      median_luna_seconds:stats.medianLunaSeconds,
      median_clef_seconds:stats.medianClefSeconds,
      median_luna_minus_clef_seconds:stats.medianLunaMinusClefSeconds,
      paired_deltas:stats.pairedDeltas,
      clef_load_seconds_excluded:ready.model_load_seconds,
      luna_warmup_seconds:lunaWarmup.seconds,
      caveat:'Exploratory paired system-pipeline comparison, not model-only; small sample and different decision interfaces.',
    },
  };
  console.log(JSON.stringify({ summary:report.summary }));
  if (resultPath) {
    const fs = await import('node:fs/promises');
    const out = path.resolve(resultPath);
    await fs.mkdir(path.dirname(out),{recursive:true});
    await fs.writeFile(out,`${JSON.stringify(report,null,2)}\n`,{mode:0o600});
    console.log(JSON.stringify({results_file:out}));
  }
}

async function cleanup() {
  if (mcpPid !== null) { try { process.kill(mcpPid,'SIGTERM'); } catch {} }
  if (scorer?.exitCode === null) {
    scorer.kill('SIGTERM');
    await new Promise((resolve)=>{const timer=setTimeout(resolve,3000);scorer.once('exit',()=>{clearTimeout(timer);resolve();});});
    if (scorer.exitCode === null) scorer.kill('SIGKILL');
  }
}

main().catch((error)=>{console.error(safeFailure(error?.stack ?? error));process.exitCode=1;}).finally(cleanup);
