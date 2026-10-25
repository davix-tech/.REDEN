import test from "node:test";
import assert from "node:assert/strict";
import { composeConversationResponse, getResponsePolicy } from "./responsePolicy.js";
import { composeCommerceKnowledge } from "./commerceKnowledge.js";

test("greeting response is natural and does not expose an analytics dump", () => {
  const answer = composeConversationResponse("greeting");
  assert.match(answer, /Hi\./);
  assert.match(answer, /commerce intelligence assistant/);
  assert.doesNotMatch(answer, /sessions|revenue today/i);
});

test("capability response distinguishes recorded revenue from profit", () => {
  const answer = composeConversationResponse("capabilities");
  assert.match(answer, /won.t call revenue profit/);
  assert.match(answer, /evidence-based next steps/);
});

test("general fallback does not invent an answer", () => {
  const answer = composeConversationResponse("general_help", "Who won an event yesterday?");
  assert.match(answer, /not confident I can answer that reliably/);
  assert.match(answer, /rather than guess/);
});

test("response policy exposes versioned, structured principles", () => {
  const policy = getResponsePolicy();
  assert.ok(policy.version);
  assert.ok(policy.knowledgeVersion);
  assert.ok(policy.principles.length >= 5);
  assert.ok(policy.responseShapes.diagnosis);
});


test("REDEN answers its own name and product identity", () => {
  assert.match(composeConversationResponse("reden_identity", "What is your name?"), /My name is REDEN/);
  assert.match(composeConversationResponse("reden_identity", "What is REDEN?"), /PRETHIM's e-commerce product/);
  assert.match(composeConversationResponse("reden_identity", "Who built you?"), /PRETHIM/);
});

test("commerce knowledge answers common definitions without inventing store facts", () => {
  assert.match(composeCommerceKnowledge("What is conversion rate?"), /proportion of a defined group/);
  assert.match(composeCommerceKnowledge("What is an abandoned cart?"), /do not prove an abandonment count/);
  assert.match(composeCommerceKnowledge("What is profit?"), /Revenue is money recorded from sales/);
  assert.match(composeCommerceKnowledge("What is a thing outside my knowledge?"), /don’t have enough information/);
});


test("capability answer describes REDEN as a decision layer and states execution limits", () => {
  const answer = composeConversationResponse("capabilities");
  assert.match(answer, /decision layer/i);
  assert.match(answer, /not merely send another recovery email/i);
  assert.match(answer, /automatically executed/i);
});
