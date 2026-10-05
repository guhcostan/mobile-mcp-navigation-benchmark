import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eligibleActions,
  makeClefRecord,
  observeScreen,
  classifySearchOutcome,
  validateChoice,
  decideAnswer,
  SEARCH_TEXT,
  isApprovedSimulator,
} from './clef_mobile_core.mjs';

function settingsObservation({ query = '', focused = false, extra = [] } = {}) {
  const search = { ref: '@search', type: 'SearchField', label: 'Buscar', name: 'Buscar', focused };
  if (query) search.value = query;
  const elements = [search, ...extra];
  return observeScreen('Foreground app: Settings (com.apple.Preferences)', elements);
}

test('device preflight only accepts explicitly identified iOS simulators', () => {
  assert.equal(isApprovedSimulator({ platform: 'ios', type: 'simulator' }), true);
  assert.equal(isApprovedSimulator({ platform: 'ios', type: 'device' }), false);
  assert.equal(isApprovedSimulator({ platform: 'android', type: 'simulator' }), false);
});

test('candidate generation only exposes fixed safe action IDs', () => {
  const root = settingsObservation();
  assert.deepEqual(eligibleActions(root).map((candidate) => candidate.id), ['focus_search', 'block']);
  const focused = settingsObservation({ focused: true });
  assert.deepEqual(eligibleActions(focused).map((candidate) => candidate.id), ['type_wifi', 'block']);
  const terminal = settingsObservation({
    query: SEARCH_TEXT,
    focused: true,
    extra: [
      { ref: '@no-results', type: 'StaticText', label: 'Nenhum Resultado para “Wi-Fi”' },
      { ref: '@clear', type: 'Button', label: 'Limpar texto' },
    ],
  });
  assert.deepEqual(eligibleActions(terminal).map((candidate) => candidate.id), ['stop', 'block']);
  assert.deepEqual(eligibleActions(terminal, { reset: true }).map((candidate) => candidate.id), ['clear_query', 'block']);
  const blankFocused = settingsObservation({ focused: true, extra: [{ ref: '@close', type: 'Button', label: 'fechar' }] });
  assert.deepEqual(eligibleActions(blankFocused, { reset: true }).map((candidate) => candidate.id), ['dismiss_search', 'block']);
});

test('search result classification excludes status-bar Wi-Fi signal', () => {
  const observation = settingsObservation({
    query: SEARCH_TEXT,
    focused: true,
    extra: [{ type: 'Other', name: '3 de 3 barras Wi-Fi', value: 'SSID, 3 de 3 barras Wi-Fi' }],
  });
  assert.equal(observation.outcome, 'pending');
});

test('unrelated Wi-Fi text in labels is not enough to count as a result', () => {
  const search = { type: 'SearchField', value: SEARCH_TEXT };
  assert.equal(classifySearchOutcome([{ type: 'StaticText', label: 'Wi-Fi calling' }], search), 'pending');
  assert.equal(classifySearchOutcome([{ type: 'StaticText', label: 'Wi-Fi Settings' }], search), 'pending');
  assert.equal(classifySearchOutcome([{ type: 'Cell', label: 'Wi-Fi' }], search), 'result_found');
});

test('explicit Portuguese no-results text is terminal', () => {
  const observation = settingsObservation({
    query: SEARCH_TEXT,
    focused: true,
    extra: [{ type: 'StaticText', label: 'Nenhum Resultado para “Wi-Fi”' }],
  });
  assert.equal(observation.outcome, 'no_results');
  assert.deepEqual(eligibleActions(observation).map((candidate) => candidate.id), ['stop', 'block']);
});

test('stale element refs and invented choices fail closed', () => {
  const observation = settingsObservation();
  const candidates = eligibleActions(observation);
  assert.throws(() => validateChoice('tap_result', candidates, observation), /ineligible/);
  assert.throws(() => validateChoice('focus_search', candidates, { ...observation, elements: [], searchField: null }), /stale/);
});

test('CLEF answers must agree with deterministic screen classification before stop', () => {
  const observation = settingsObservation({
    query: SEARCH_TEXT,
    focused: true,
    extra: [{ type: 'StaticText', label: 'Nenhum Resultado para “Wi-Fi”' }],
  });
  const candidates = eligibleActions(observation);
  const answer = decideAnswer({
    answers: {
      next_action: { type: 'choice', choice: 'stop', probabilities: { stop: 1 } },
      search_state: { type: 'noul', noul: 0.99 },
      terminal_outcome: { type: 'choice', choice: 'no_results', probabilities: { no_results: 1 } },
    },
  }, candidates, observation);
  assert.equal(answer.choice.id, 'stop');
});

test('CLEF disagreement about terminal state is refused', () => {
  const observation = settingsObservation({
    query: SEARCH_TEXT,
    focused: true,
    extra: [{ type: 'StaticText', label: 'Nenhum Resultado para “Wi-Fi”' }],
  });
  assert.throws(() => decideAnswer({
    answers: {
      next_action: { type: 'choice', choice: 'stop', probabilities: { stop: 1 } },
      search_state: { type: 'noul', noul: 0.99 },
      terminal_outcome: { type: 'choice', choice: 'result_found', probabilities: { result_found: 1 } },
    },
  }, eligibleActions(observation), observation), /disagrees/);
});

test('record includes accessibility state and host-bounded options', () => {
  const observation = settingsObservation();
  const candidates = eligibleActions(observation);
  const record = makeClefRecord(observation, candidates, 'unit-test');
  assert.equal(record.questions.next_action.type, 'choice');
  assert.deepEqual(Object.keys(record.questions.next_action.criteria), ['focus_search', 'block']);
  assert.equal(record.questions.search_state.type, 'noul');
  assert.equal(record.questions.terminal_outcome.type, 'choice');
});
