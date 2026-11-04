import test from "node:test";
import assert from "node:assert/strict";
import {
  getSiteSubscriberCount,
  publishSiteEvent,
  subscribeToSite,
} from "../infrastructure/realtime.js";

test("site events are isolated to subscribers for the matching site", () => {
  const receivedA = [];
  const receivedB = [];
  const unsubscribeA = subscribeToSite("site_a", (event) => receivedA.push(event));
  const unsubscribeB = subscribeToSite("site_b", (event) => receivedB.push(event));

  const event = { event: "commerce.event", eventId: "evt_1" };
  assert.equal(publishSiteEvent("site_a", event), 1);
  assert.deepEqual(receivedA, [event]);
  assert.deepEqual(receivedB, []);
  assert.equal(getSiteSubscriberCount("site_a"), 1);

  unsubscribeA();
  unsubscribeB();
  assert.equal(getSiteSubscriberCount("site_a"), 0);
  assert.equal(getSiteSubscriberCount("site_b"), 0);
});

test("unsubscribe is idempotent and listener errors do not break publishing", () => {
  const unsubscribe = subscribeToSite("site_c", () => {
    throw new Error("disconnected client");
  });

  assert.equal(publishSiteEvent("site_c", { eventId: "evt_2" }), 0);
  unsubscribe();
  unsubscribe();
  assert.equal(getSiteSubscriberCount("site_c"), 0);
});
