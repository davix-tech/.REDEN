import test from "node:test";
import assert from "node:assert/strict";
import { LANGUAGE_DICTIONARY, findDictionaryEntry, normalizeMerchantQuestion } from "./languageDictionary.js";
import { detectIntents } from "./intentRouter.js";
import { composeCommerceKnowledge } from "./commerceKnowledge.js";

test("normalizes merchant synonyms", () => {
  assert.match(normalizeMerchantQuestion("How have my takings changed?"), /\\brevenue\\b/);
  assert.match(normalizeMerchantQuestion("What is basket abandonment?"), /\\bcart abandonment\\b/);
  assert.match(normalizeMerchantQuestion("How much footfall did we get?"), /\\btraffic\\b/);
  assert.match(normalizeMerchantQuestion("Explain buying interest"), /\\bpurchase intent\\b/);
});

test("preserves ordinary question tokenization", () => {
  assert.equal(normalizeMerchantQuestion("What's my store called?"), "what s my store called");
});

test("dictionary entries provide canonical meaning and intent", () => {
  assert.ok(LANGUAGE_DICTIONARY.length >= 8);
  const entry = findDictionaryEntry("What does turnover mean?");
  assert.equal(entry.id, "revenue");
  assert.equal(entry.intent, "revenue");
});

test("routes alternate merchant wording", () => {
  assert.deepEqual(detectIntents("Why have my takings dropped?"), ["diagnostic", "revenue"]);
  assert.deepEqual(detectIntents("What is basket abandonment?"), ["commerce_knowledge"]);
  assert.deepEqual(detectIntents("Explain buying interest"), ["commerce_knowledge"]);
  assert.deepEqual(detectIntents("What is footfall?"), ["commerce_knowledge"]);
});

test("answers definitions through synonyms", () => {
  assert.match(composeCommerceKnowledge("What does turnover mean?"), /Revenue is the value recorded from sales/i);
  assert.match(composeCommerceKnowledge("What is basket abandonment?"), /Cart abandonment generally means/i);
  assert.match(composeCommerceKnowledge("What is footfall?"), /Store traffic means visits/i);
  assert.match(composeCommerceKnowledge("Explain buying interest"), /Purchase intent is an estimate/i);
});
