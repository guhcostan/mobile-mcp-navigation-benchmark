import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { classifySearchOutcome, SETTINGS_BUNDLE, SEARCH_TEXT } from './clef_mobile_core.mjs';

const baseUrl = (process.env.LUNA_BASE_URL ?? 'http://127.0.0.1:10100/v1').replace(/\/$/, '');
const mcpUrl = process.env.MOBILE_MCP_URL ?? 'http://127.0.0.1:30100/mcp';
const model = process.env.LUNA_MODEL ?? 'codeen/gpt-6-luna';
const device = process.env.MOBILE_DEVICE_ID;
if (!device) throw new Error('Set MOBILE_DEVICE_ID to the intended simulator UDID');
const settingsBundle = process.env.MOBILE_SETTINGS_BUNDLE ?? 'com.apple.Preferences';
let modelCalls = [];
const allModelCalls = [];
let activeTrial = 0;
const mcpClient = new Client({ name: 'luna-mobile-benchmark', version: '1.0.0' });

const strictSchema = (properties, required) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const deviceArg = { type: 'string', enum: [device] };
const tools = [
  {
    type: 'function',
    name: 'mobile_launch_app',
    description: 'Open the Settings app on the assigned iPhone simulator.',
    parameters: strictSchema(
      { device: deviceArg, packageName: { type: 'string', enum: [settingsBundle] } },
      ['device', 'packageName'],
    ),
    strict: true,
  },
  {
    type: 'function',
    name: 'mobile_list_elements_on_screen',
    description: 'Read visible Settings accessibility labels, values, and tappable element refs.',
    parameters: strictSchema(
      { device: deviceArg, format: { type: 'string', enum: ['json'] } },
      ['device', 'format'],
    ),
    strict: true,
  },
  {
    type: 'function',
    name: 'mobile_click_on_screen_at_coordinates',
    description: 'Tap the visible Settings search field or its exact Clear Text control (Portuguese: Limpar texto), never the Close button or a result row.',
    parameters: strictSchema(
      { device: deviceArg, ref: { type: 'string' } },
      ['device', 'ref'],
    ),
    strict: true,
  },
  {
    type: 'function',
    name: 'mobile_type_keys',
    description: 'Type exactly Wi-Fi into the focused Settings search field; do not submit.',
    parameters: strictSchema(
      {
        device: deviceArg,
        text: { type: 'string', enum: ['Wi-Fi'] },
        submit: { type: 'boolean', enum: [false] },
      },
      ['device', 'text', 'submit'],
    ),
    strict: true,
  },
  {
    type: 'function',
    name: 'mobile_get_foreground_app',
    description: 'Verify which app is currently in the foreground on the assigned simulator.',
    parameters: strictSchema({ device: deviceArg }, ['device']),
    strict: true,
  },
];

const uiActions = new Set([
  'mobile_launch_app',
  'mobile_click_on_screen_at_coordinates',
  'mobile_type_keys',
]);
let latestElements = [];
let latestForeground = '';
let latestObservation = null;
let latestOutcome = 'unknown';
let latestSearchQuery = '';

function parseElements(text) {
  const prefix = 'Found these elements on screen: ';
  const start = text.indexOf(prefix);
  if (start === -1) return [];
  try {
    return JSON.parse(text.slice(start + prefix.length));
  } catch {
    return [];
  }
}

function isSearchField(element) {
  const text = [element.type, element.label, element.name, element.identifier]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return element.type === 'SearchField' || /search|buscar|busca/.test(text);
}

function checkArguments(name, args) {
  if (args.device !== device) throw new Error(`Refusing unexpected device for ${name}`);
  if (name === 'mobile_launch_app' && args.packageName !== settingsBundle) {
    throw new Error('Refusing to launch anything except Settings');
  }
  if (name === 'mobile_type_keys' && (args.text !== 'Wi-Fi' || args.submit !== false)) {
    throw new Error('Refusing text or submit action outside the approved search');
  }
  if (name === 'mobile_type_keys') {
    const search = latestObservation?.searchField;
    if (!latestObservation?.settingsForeground || !search || search.focused !== true || (search.value ?? '').trim() !== '') {
      throw new Error('Refusing to type unless fresh Settings state has a focused, empty SearchField');
    }
  }
  if (name === 'mobile_click_on_screen_at_coordinates') {
    const target = latestElements.find((element) => element.ref === args.ref);
    const description = target ? [target.label, target.name, target.identifier].filter(Boolean).join(' ') : '';
    const normalizedDescription = description.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const allowedTarget = target && (
      isSearchField(target)
      || (/limpar texto|clear text|clear search text/.test(normalizedDescription) && target.type === 'Button')
    );
    if (!allowedTarget) {
      throw new Error(`Refusing tap: ${args.ref} is neither a current search field nor a clear-text control`);
    }
    if (!latestObservation?.settingsForeground) {
      throw new Error('Refusing tap unless Settings is the current observed foreground app');
    }
  }
}

async function callMcp(name, args) {
  checkArguments(name, args);
  const started = performance.now();
  const result = await mcpClient.callTool({ name, arguments: args });
  const elapsed = performance.now() - started;
  const text = (result.content ?? [])
    .map((item) => item.type === 'text' ? item.text : `[${item.type}]`)
    .join('\n');
  if (result.isError || /^Error:/.test(text)) {
    throw new Error(`${name} failed: ${text.slice(0, 1000)}`);
  }
  if (name === 'mobile_get_foreground_app') {
    latestForeground = text;
    latestObservation = null;
  }
  if (name === 'mobile_list_elements_on_screen') {
    latestElements = parseElements(text);
    if (!latestElements.length) throw new Error('Could not parse the current accessibility tree');
    latestObservation = observeScreen(latestForeground, latestElements);
  }
  return { text, elapsed };
}

async function requestModel(payload) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json();
  const elapsed = performance.now() - started;
  const callRecord = { trial: activeTrial, elapsed };
  modelCalls.push(callRecord);
  allModelCalls.push(callRecord);
  if (!response.ok || body.error) {
    throw new Error(`Luna Responses API returned HTTP ${response.status}: ${JSON.stringify(body.error ?? body).slice(0, 1500)}`);
  }
  return { body, elapsed };
}

async function runTrial(index) {
  activeTrial = index;
  latestElements = [];
  modelCalls.length = 0;
  const mcpCalls = [];
  const start = performance.now();
  let payload = {
    model,
    instructions: [
      'You control one iOS simulator using only the supplied Mobile MCP tools.',
      'Open Apple Settings (the Portuguese UI may call it Ajustes). Search for the exact text Wi-Fi.',
      'You may launch only com.apple.Preferences, inspect visible accessibility elements, tap the current search field, clear any prior text before typing, type exactly Wi-Fi without submitting, and verify the foreground app.',
      'Do not open a search result, change a setting, use any other device or app, or claim success unless the visible accessibility results support it. The simulator may have no Wi-Fi Settings result; accurately report any visible no-results message.',
      'Stop as soon as the Wi-Fi result is visibly confirmed and Settings is foregrounded.',
    ].join(' '),
    input: 'Perform the approved Settings search now. Use the tools to inspect the screen, search Wi-Fi, and verify the result.',
    tools,
    tool_choice: 'auto',
    max_output_tokens: 512,
  };
  let responseId;
  let finalText = '';
  let uiError;
  let resultValidated = false;

  for (let turn = 0; turn < 12; turn += 1) {
    const { body } = await requestModel(payload);
    responseId = body.id ?? responseId;
    const calls = (body.output ?? []).filter((item) => item.type === 'function_call');
    finalText = (body.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text)
      .join('\n');

    if (!calls.length) break;
    if (!responseId) throw new Error('Responses API omitted its response id');

    const outputs = [];
    for (const call of calls) {
      if (!tools.some((tool) => tool.name === call.name)) {
        uiError = `Luna requested a disallowed tool: ${call.name}`;
        break;
      }
      let args;
      try {
        args = JSON.parse(call.arguments);
        const { text, elapsed } = await callMcp(call.name, args);
        let outputText = text;
        mcpCalls.push({ name: call.name, ms: +elapsed.toFixed(1), action: uiActions.has(call.name) });
        if (call.name === 'mobile_list_elements_on_screen') {
          latestObservation = observeScreen(latestForeground, latestElements);
          const search = latestObservation.searchField;
          const priorQuery = search?.value?.trim() ?? '';
          if (priorQuery && priorQuery !== 'Wi-Fi') {
            const clear = latestElements.find((element) => {
              const description = [element.label, element.name, element.identifier].filter(Boolean).join(' ')
                .normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
              return element.type === 'Button' && /limpar texto|clear text|clear search text/.test(description);
            });
            if (clear) {
              const cleared = await callMcp('mobile_click_on_screen_at_coordinates', { device, ref: clear.ref });
              mcpCalls.push({ name: 'mobile_click_on_screen_at_coordinates(search reset)', ms: +cleared.elapsed.toFixed(1), action: false });
              const resetScreen = await callMcp('mobile_list_elements_on_screen', { device, format: 'json' });
              mcpCalls.push({ name: 'mobile_list_elements_on_screen(search reset verification)', ms: +resetScreen.elapsed.toFixed(1), action: false });
              const resetSearch = latestElements.find((element) => element.type === 'SearchField');
              if (resetSearch?.value?.trim()) throw new Error('Could not safely clear stale Settings search query');
              outputText = `${text.slice(0, 6000)}\\nBenchmark setup cleared the prior query; current screen: ${resetScreen.text.slice(0, 6000)}`;
            } else {
              throw new Error(`Stale Settings query (${priorQuery}) remains and no safe Clear Text control is visible`);
            }
          }
          latestObservation = observeScreen(latestForeground, latestElements);
          const currentSearch = latestObservation.searchField;
          latestSearchQuery = currentSearch?.value?.trim() ?? '';
          latestOutcome = latestObservation.outcome;
          resultValidated = latestSearchQuery === SEARCH_TEXT
            && ['result_found', 'no_results'].includes(latestOutcome)
            && latestObservation.settingsForeground;
        }
        if (call.name === 'mobile_get_foreground_app') {
          resultValidated = resultValidated && /foreground app:.*\(com\.apple\.preferences\)/i.test(text);
        }
        outputs.push({ type: 'function_call_output', call_id: call.call_id, output: outputText.slice(0, 12000) });
      } catch (error) {
        uiError = error instanceof Error ? error.message : String(error);
        outputs.push({ type: 'function_call_output', call_id: call.call_id, output: `ACTION_REFUSED_OR_FAILED: ${uiError}` });
        break;
      }
    }
    if (uiError) break;
    payload = {
      model,
      previous_response_id: responseId,
      input: outputs,
      tools,
      tool_choice: 'auto',
      max_output_tokens: 512,
    };
  }

  if (!uiError) {
    const screen = await callMcp('mobile_list_elements_on_screen', { device, format: 'json' });
    mcpCalls.push({ name: 'mobile_list_elements_on_screen(final verification)', ms: +screen.elapsed.toFixed(1), action: false });
    const fg = await callMcp('mobile_get_foreground_app', { device });
    mcpCalls.push({ name: 'mobile_get_foreground_app(final verification)', ms: +fg.elapsed.toFixed(1), action: false });
    latestForeground = fg.text;
    latestObservation = observeScreen(latestForeground, latestElements);
    latestSearchQuery = latestObservation.query;
    latestOutcome = latestObservation.outcome;
    resultValidated = latestObservation.settingsForeground
      && latestSearchQuery === SEARCH_TEXT
      && ['result_found', 'no_results'].includes(latestOutcome);
  } else {
    resultValidated = false;
  }

  return {
    trial: index,
    elapsed_s: +((performance.now() - start) / 1000).toFixed(3),
    model_calls: modelCalls.length,
    model_call_latencies_s: modelCalls.map((call) => +(call.elapsed / 1000).toFixed(3)),
    mcp_calls: mcpCalls,
    ui_action_calls: mcpCalls.filter((call) => call.action).length,
    result_visible: resultValidated,
    settings_foreground: latestObservation?.settingsForeground === true,
    final_query: latestSearchQuery,
    final_outcome: latestOutcome,
    final_text: finalText,
    error: uiError,
  };
}

await mcpClient.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
try {
  const listed = await mcpClient.callTool({ name: 'mobile_list_available_devices', arguments: {} });
  if (listed.isError) throw new Error('Mobile MCP device listing failed');
  const deviceText = listed.content?.find((item) => item.type === 'text')?.text ?? '';
  const parsed = JSON.parse(deviceText);
  if (!parsed.devices?.some((item) => item.id === device && item.state === 'online')) {
    throw new Error('The approved clean test simulator is not listed as online');
  }
  console.log(JSON.stringify({ preflight: 'pass', target: device, model, target_name: parsed.devices.find((item) => item.id === device)?.name }));

  const trials = [];
  for (let index = 1; index <= 3; index += 1) {
    const trial = await runTrial(index);
    trials.push(trial);
    console.log(JSON.stringify({ trial }));
    if (trial.error || !trial.result_visible) break;

    if (index < 3) {
      const current = await callMcp('mobile_list_elements_on_screen', { device, format: 'json' });
      const cancel = latestElements.find((element) => {
        const description = [element.label, element.name, element.identifier].filter(Boolean).join(' ');
        return /^(cancel|cancelar|fechar)$/i.test(description.trim())
          || /^(cancel|cancelar|fechar)$/i.test((element.label ?? '').trim())
          || /cancel|cancelar|close|fechar/i.test(element.identifier ?? '');
      });
      if (cancel) {
        const resetStarted = performance.now();
        const reset = await mcpClient.callTool({
          name: 'mobile_click_on_screen_at_coordinates',
          arguments: { device, ref: cancel.ref },
        });
        const resetSeconds = (performance.now() - resetStarted) / 1000;
        const resetText = reset.content?.find((item) => item.type === 'text')?.text ?? '';
        if (reset.isError || /^Error:/.test(resetText)) throw new Error(`Could not dismiss search before trial ${index + 1}`);
        const root = await callMcp('mobile_list_elements_on_screen', { device, format: 'json' });
        const rootQuery = latestElements.find((element) => element.type === 'SearchField')?.value?.trim();
        if (rootQuery) throw new Error('Search query remained after closing; refusing next trial');
        console.log(JSON.stringify({ normalization_after_trial: index, method: 'dismissed search with Cancel', ms: +(resetSeconds * 1000).toFixed(1), verified_root: root.text.slice(0, 80) }));
      } else {
        throw new Error('No visible Cancel control to safely return Settings to its root');
      }
    }
  }
  const durations = trials.map((trial) => trial.elapsed_s).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const median = durations.length === 0
    ? null
    : durations.length % 2 === 1
      ? durations[middle]
      : (durations[middle - 1] + durations[middle]) / 2;
  console.log(JSON.stringify({
    summary: {
      completed_trials: trials.length,
      successful_trials: trials.filter((trial) => trial.result_visible && !trial.error).length,
      median_end_to_end_s: median,
      range_s: durations.length ? [durations[0], durations.at(-1)] : null,
      model_request_latencies_s: allModelCalls.map((call) => ({ trial: call.trial, seconds: +(call.elapsed / 1000).toFixed(3) })),
      note: 'Model latency measurements exclude initial endpoint discovery; the first successful trial request may still have a cold-start contribution.',
    },
  }));
} finally {
  await mcpClient.close();
}
