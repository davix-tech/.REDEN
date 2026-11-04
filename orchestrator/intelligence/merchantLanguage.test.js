import test from "node:test";
import assert from "node:assert/strict";
import { toMerchantLanguage } from "./merchantLanguage.js";

test("translates internal event names into plain merchant language", () => {
  const answer = toMerchantLanguage(
    "PAGE_VIEW, PRODUCT_VIEW, ADD_TO_CART, CHECKOUT_STARTED and PURCHASE"
  );
  assert.equal(
    answer,
    "store visits, product-page views, items added to cart, checkouts started and purchases"
  );
});

test("explains buying-intent language without exposing internal scoring terms", () => {
  const answer = toMerchantLanguage(
    "3 high-behavioural-intent sessions were found. The intent score is a behavioural proxy."
  );
  assert.match(answer, /3 shoppers showing strong signs of wanting to buy/i);
  assert.match(answer, /buying-interest measure/i);
  assert.doesNotMatch(answer, /high-behavioural-intent|intent score|behavioural proxy/i);
});

test("translates internal REDEN state names into merchant language", () => {
  const answer = toMerchantLanguage(
    "PURCHASE_INTENT HIGH_INTENT LOW_INTENT ABANDONED_CART RECOVERY_SUCCESS BANDIT_STATE"
  );
  assert.match(answer, /ready to buy/i);
  assert.match(answer, /strong signs of wanting to buy/i);
  assert.match(answer, /limited signs of wanting to buy/i);
  assert.match(answer, /cart with items left before purchase/i);
  assert.match(answer, /sale recovered after a reminder/i);
  assert.doesNotMatch(answer, /PURCHASE_INTENT|HIGH_INTENT|LOW_INTENT|ABANDONED_CART|RECOVERY_SUCCESS|BANDIT_STATE/);
});

test("translates internal decision lifecycle labels", () => {
  assert.equal(
    toMerchantLanguage("Check SCORED → ACTIONED → COMPLETED."),
    "Check recorded, carried out, and measured."
  );
});

test("leaves ordinary merchant language unchanged", () => {
  const answer = "Your store recorded 12 purchases today.";
  assert.equal(toMerchantLanguage(answer), answer);
});
