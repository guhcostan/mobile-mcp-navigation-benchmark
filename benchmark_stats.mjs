export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizePairs(pairs) {
  const pairedDeltas = pairs.map(({ pair, runs }) => {
    const luna = runs.find((run) => run.system === 'LUNA');
    const clef = runs.find((run) => run.system === 'CLEF');
    const bothPassed = Boolean(luna?.success && clef?.success);
    return {
      pair,
      luna_minus_clef_seconds: bothPassed ? luna.seconds - clef.seconds : null,
      both_passed: bothPassed,
      luna_success: luna?.success ?? false,
      clef_success: clef?.success ?? false,
    };
  });
  const successfulPairs = pairs.filter((pair) => pair.runs.length === 2 && pair.runs.every((run) => run.success));
  const successfulLuna = successfulPairs.map((pair) => pair.runs.find((run) => run.system === 'LUNA').seconds);
  const successfulClef = successfulPairs.map((pair) => pair.runs.find((run) => run.system === 'CLEF').seconds);
  const successfulDeltas = pairedDeltas.filter((pair) => pair.both_passed).map((pair) => pair.luna_minus_clef_seconds);
  return {
    pairedDeltas,
    successfulPairs: successfulPairs.length,
    medianLunaSeconds: median(successfulLuna),
    medianClefSeconds: median(successfulClef),
    medianLunaMinusClefSeconds: median(successfulDeltas),
  };
}
