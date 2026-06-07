export function learningEngine(intentHistory = [], executionHistory = []) {
  const adjustments = {
    cartWeight: 1,
    checkoutWeight: 1,
    urgencyMultiplier: 1
  };

  let successRate = 0;

  for (const e of executionHistory) {
    if (e.impact === "revenue_recovery") {
      successRate += 1;
      adjustments.cartWeight += 0.01;
    }

    if (e.impact === "conversion_boost") {
      successRate += 0.5;
      adjustments.urgencyMultiplier += 0.01;
    }
  }

  return {
    successRate,
    adjustments
  };
}
