export function attributionEngine(executions = []) {
  let revenueImpact = 0;
  let conversionBoostEvents = 0;
  let recoveryEvents = 0;

  for (const e of executions) {
    if (e.impact === "revenue_recovery") {
      revenueImpact += 15; // baseline recovery estimate
      recoveryEvents++;
    }

    if (e.impact === "conversion_boost") {
      revenueImpact += 8;
      conversionBoostEvents++;
    }
  }

  return {
    revenueImpact,
    recoveryEvents,
    conversionBoostEvents,
    roiScore: executions.length
      ? revenueImpact / executions.length
      : 0
  };
}
