import test from "node:test";
import assert from "node:assert/strict";
import { composeConversationResponse, getResponsePolicy } from "./responsePolicy.js";

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
