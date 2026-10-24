import test from "node:test";
import assert from "node:assert/strict";
import { composeKnowledgeGuidance } from "./knowledgeAdvisor.js";

test("profit questions use the profitability knowledge domain and avoid claiming profit from revenue", () => {
  const answer = composeKnowledgeGuidance("How can I make my store more profitable?");
  assert.match(answer, /Merchant profitability decision framework/);
  assert.match(answer, /Revenue is not profit/);
  assert.match(answer, /cannot calculate verified profit from revenue alone/);
});

test("discount questions include margin-aware promotion guidance", () => {
  const answer = composeKnowledgeGuidance("Should I give customers a discount?");
  assert.match(answer, /Pricing, discounts, and promotion decisions/);
  assert.match(answer, /contribution profit/);
  assert.match(answer, /Measure the result using/);
});

test("retention questions disclose missing merchant-specific cohort evidence", () => {
  const answer = composeKnowledgeGuidance("How do I improve repeat purchases?");
  assert.match(answer, /Customer retention and repeat purchase/);
  assert.match(answer, /do not have enough customer-cohort/);
});

test("unmatched questions leave the existing advice path available", () => {
  assert.equal(composeKnowledgeGuidance("What should I do?"), null);
});
