import assert from "node:assert/strict";
import test from "node:test";
import { isVerifiedFamilyUser, normalizeFamilyEmail } from "./auth-policy";

test("both approved domains accept normalized valid addresses", () => {
  assert.equal(normalizeFamilyEmail(" Alice@OROLE.BE "), "alice@orole.be");
  assert.equal(normalizeFamilyEmail(" Bob+drive@RONZANI.BE "), "bob+drive@ronzani.be");
});

test("the whitelist rejects subdomains, lookalikes, malformed addresses and other domains", () => {
  for (const email of [
    "member@sub.orole.be", "member@sub.ronzani.be",
    "member@orole.be.evil.example", "member@ronzani.be.evil.example",
    "member@notorole.be", "member@notronzani.be", "member@gmail.com",
    "member@orole.be@ronzani.be", "@ronzani.be", "member@ronzani.be.",
    "member @ronzani.be", "member@rоnzani.be", "", null, 123,
  ]) assert.equal(normalizeFamilyEmail(email), null, String(email));
});

test("approved domains still require verified email for membership", () => {
  for (const email of ["member@orole.be", "member@ronzani.be"]) {
    assert.equal(isVerifiedFamilyUser({ email, emailVerified: true }), true);
    assert.equal(isVerifiedFamilyUser({ email, emailVerified: false }), false);
  }
  assert.equal(isVerifiedFamilyUser({ email: "member@example.com", emailVerified: true }), false);
});
