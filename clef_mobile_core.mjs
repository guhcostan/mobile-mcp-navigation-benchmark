export const TARGET_DEVICE = process.env.MOBILE_DEVICE_ID ?? '';
export const SETTINGS_BUNDLE = 'com.apple.Preferences';
export const SEARCH_TEXT = 'Wi-Fi';

export function isApprovedSimulator(device) {
  return device?.platform === 'ios'
    && (device?.type === 'simulator' || device?.kind === 'simulator' || device?.deviceType === 'simulator');
}

const normalize = (value = '') => value
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .replace(/[‐‑‒–—]/g, '-')
  .trim()
  .toLowerCase();

export function parseElementsOutput(text) {
  const prefix = 'Found these elements on screen: ';
  const start = text.indexOf(prefix);
  if (start < 0) throw new Error('Mobile MCP response did not contain accessibility elements');
  const elements = JSON.parse(text.slice(start + prefix.length));
  if (!Array.isArray(elements)) throw new Error('Mobile MCP accessibility response was not an array');
  return elements;
}

export function findSearchField(elements) {
  const matches = elements.filter((element) => element?.type === 'SearchField');
  if (matches.length > 1) throw new Error(`Expected one Settings SearchField, found ${matches.length}`);
  return matches[0] ?? null;
}

export function findClearControl(elements) {
  const matches = elements.filter((element) => {
    if (element?.type !== 'Button') return false;
    const text = normalize(element.label ?? element.name ?? element.identifier ?? '');
    return text === 'limpar texto' || text === 'clear text' || text === 'clear search text';
  });
  if (matches.length > 1) throw new Error(`Ambiguous Clear Text controls (${matches.length})`);
  return matches[0] ?? null;
}

export function findCloseSearchControl(elements) {
  const matches = elements.filter((element) => {
    if (element?.type !== 'Button') return false;
    const text = normalize(element.label ?? element.name ?? element.identifier ?? '');
    return ['fechar', 'cancelar', 'cancel', 'close'].includes(text);
  });
  if (matches.length > 1) throw new Error(`Ambiguous Close/Cancel controls (${matches.length})`);
  return matches[0] ?? null;
}

export function classifySearchOutcome(elements, searchField) {
  const query = typeof searchField?.value === 'string' ? searchField.value.trim() : '';
  if (query !== SEARCH_TEXT) return 'incomplete';

  const noResults = elements.some((element) => {
    const text = normalize([element.label, element.name, element.value].filter(Boolean).join(' '));
    return /nenhum resultado para.*wi-fi|no results for.*wi-fi/.test(text);
  });
  if (noResults) return 'no_results';

  const result = elements.some((element) => {
    if (!['StaticText', 'Button', 'Cell', 'Other'].includes(element.type)) return false;
    const text = [element.label, element.name].filter(Boolean).join(' ');
    const normalized = normalize(text);
    if (!/wi-fi/.test(normalized)) return false;
    if (/barras wi-fi|no results|nenhum resultado|buscar|search|wifi settings|wifi calling/.test(normalized)) return false;
    return /^(wifi|wi-fi)$/.test(normalized) || /^(wi-fi|wifi)\s*[·:-]\s*.+/.test(normalized);
  });
  return result ? 'result_found' : 'pending';
}

export function observeScreen(foregroundText, elements) {
  const settingsForeground = new RegExp(`\\(${SETTINGS_BUNDLE.replaceAll('.', '\\.')}\\)$`, 'i').test(foregroundText.trim());
  const searchField = findSearchField(elements);
  const query = typeof searchField?.value === 'string' ? searchField.value.trim() : '';
  const outcome = classifySearchOutcome(elements, searchField);
  return { foregroundText, settingsForeground, elements, searchField, query, outcome };
}

function action(id, description, ref = null) {
  return { id, description, ref };
}

export function eligibleActions(observation, { reset = false } = {}) {
  const block = action('block', 'Stop without touching the UI and report blocked if the current state does not support a safe action.');
  if (!observation.settingsForeground) {
    return [
      action('launch_settings', 'Open Apple Settings, package com.apple.Preferences, on the already approved test simulator.'),
      block,
    ];
  }
  if (!observation.searchField) return [block];

  const { searchField, query, outcome, elements } = observation;
  if (reset && query === SEARCH_TEXT) {
    const clear = findClearControl(elements);
    if (clear) return [action('clear_query', 'Clear the existing Wi-Fi query using the currently visible Clear Text button.', clear.ref), block];
    throw new Error('The query must be reset, but no exact Clear Text control is visible');
  }
  if (reset && query === '' && searchField.focused === true) {
    const close = findCloseSearchControl(elements);
    if (close) return [action('dismiss_search', 'Close the search overlay without submitting or changing a setting.', close.ref), block];
    return [block];
  }
  if (query && query !== SEARCH_TEXT) {
    const clear = findClearControl(elements);
    if (clear) return [action('clear_query', 'Clear the existing text from the currently focused Settings search field.', clear.ref), block];
    if (searchField.focused !== true) {
      return [action('focus_search', 'Focus the current Settings search field so its exact Clear Text control can be exposed.', searchField.ref), block];
    }
    return [block];
  }
  if (query === SEARCH_TEXT) {
    if (outcome === 'no_results' || outcome === 'result_found') {
      return [action('stop', 'Stop: the exact Wi-Fi query has an observed terminal result state.'), block];
    }
    return [action('wait_for_results', 'Wait briefly for the current exact Wi-Fi search result state to settle without tapping anything.'), block];
  }
  if (searchField.focused === true) {
    return [action('type_wifi', 'Type the fixed text Wi-Fi into the focused empty search field; do not submit.'), block];
  }
  return [action('focus_search', 'Tap the unique visible Settings search field to focus it.', searchField.ref), block];
}

export function makeClefRecord(observation, candidates, id = 'decision') {
  const state = {
    task: 'Use iOS Settings search to inspect Wi-Fi preferences without opening a result or changing any setting.',
    app_foreground: observation.foregroundText,
    settings_foreground: observation.settingsForeground,
    search_query: observation.query,
    search_focused: observation.searchField?.focused === true,
    observed_outcome: observation.outcome,
    visible_elements: observation.elements
      .filter((element) => {
        const text = normalize([element.label, element.name, element.value, element.identifier].filter(Boolean).join(' '));
        return candidates.some((candidate) => candidate.ref && candidate.ref === element.ref)
          || element.type === 'SearchField'
          || /wi-fi|nenhum resultado|no results|ajustes|settings/.test(text);
      })
      .slice(0, 16)
      .map((element) => ({
        ref: element.ref,
        type: element.type,
        label: element.label,
        name: element.name,
        value: element.value,
        focused: element.focused,
      })),
    eligible_actions: candidates.map(({ id: actionId, description }) => ({ id: actionId, description })),
  };
  const questions = {
    next_action: {
      type: 'choice',
      instructions: 'Choose exactly the safest eligible next action for this current mobile screen. Do not invent actions.',
      criteria: Object.fromEntries(candidates.map(({ id: actionId, description }) => [actionId, description])),
    },
    search_state: {
      type: 'noul',
      instructions: 'Does the visible Settings accessibility state confirm that the exact Wi-Fi query is in the focused search field?',
      criteria: {
        true: 'Settings is foreground and its current focused SearchField value is exactly Wi-Fi.',
        false: 'Settings is not foreground, the search field is missing or unfocused, or its value is not exactly Wi-Fi.',
      },
    },
    terminal_outcome: {
      type: 'choice',
      instructions: 'What outcome is supported by this fresh accessibility snapshot?',
      criteria: {
        result_found: 'A Settings search result about Wi-Fi is visible; exclude the status-bar Wi-Fi indicator.',
        no_results: 'Settings explicitly displays Nenhum Resultado para Wi-Fi or No Results for Wi-Fi.',
        incomplete: 'The exact query is absent or results have not settled; no terminal search outcome is supported.',
      },
    },
  };
  return { model: 'Cloudflare/clef-flash', id, state, questions };
}

export function validateChoice(choiceId, candidates, observation) {
  const selected = candidates.find((candidate) => candidate.id === choiceId);
  if (!selected) throw new Error(`CLEF selected an ineligible action: ${choiceId}`);
  if (selected.id === 'block') return selected;
  if (selected.id === 'focus_search') {
    if (!selected.ref || selected.ref !== observation.searchField?.ref) throw new Error('Candidate search-field ref is missing or stale');
    const currentSearch = observation.elements.find((element) => element.ref === selected.ref);
    if (!currentSearch || currentSearch.type !== 'SearchField') throw new Error('Search-field ref is missing or stale');
  }
  if (selected.ref) {
    const element = observation.elements.find((candidate) => candidate.ref === selected.ref);
    if (!element) throw new Error(`Selected ref is stale: ${selected.ref}`);
    if (selected.id === 'clear_query' && element !== findClearControl(observation.elements)) {
      throw new Error('Clear target is no longer the exact current Clear Text control');
    }
    if (selected.id === 'dismiss_search' && element !== findCloseSearchControl(observation.elements)) {
      throw new Error('Dismiss target is no longer the exact current Close/Cancel control');
    }
  }
  if (selected.id === 'stop' && (!observation.settingsForeground || !['no_results', 'result_found'].includes(observation.outcome))) {
    throw new Error('Refusing stop without deterministic terminal-state evidence');
  }
  if (selected.id === 'clear_query' && observation.searchField?.focused !== true) {
    throw new Error('Refusing Clear Text unless the search field is focused');
  }
  if (selected.id === 'type_wifi' && (observation.query !== '' || observation.searchField?.focused !== true)) {
    throw new Error('Refusing text entry unless the current Settings search field is focused and empty');
  }
  return selected;
}

export function decideAnswer(response, candidates, observation) {
  const answer = response?.answers?.next_action;
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string') {
    throw new Error('CLEF response has no next_action choice');
  }
  const choice = validateChoice(answer.choice, candidates, observation);
  const searchState = response.answers.search_state;
  const terminal = response.answers.terminal_outcome;
  if (searchState?.type !== 'noul' || typeof searchState.noul !== 'number') {
    throw new Error('CLEF response has no search_state Noul score');
  }
  if (terminal?.type !== 'choice' || typeof terminal.choice !== 'string') {
    throw new Error('CLEF response has no terminal_outcome choice');
  }
  if (choice.id === 'stop' && (searchState.noul < 0.9 || terminal.choice !== observation.outcome)) {
    throw new Error('CLEF semantic judgement disagrees with deterministic mobile state');
  }
  if (choice.id === 'block') throw new Error('CLEF chose BLOCK; stopping safely without dispatching a UI action');
  return {
    choice,
    searchStateProbability: searchState.noul,
    terminalOutcomeChoice: terminal.choice,
    terminalOutcomeProbabilities: terminal.probabilities ?? {},
    choiceProbabilities: answer.probabilities ?? {},
  };
}
