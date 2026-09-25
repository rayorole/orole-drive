import assert from "node:assert/strict";
import test from "node:test";
import { fuseRankings, passageSnippet, queryTerms, RRF_K } from "./search-rank";

test("reciprocal rank fusion rewards agreement between both lists", () => {
  const fused = fuseRankings([["a", "b", "c"], ["c", "d", "a"]]);
  assert.deepEqual([...fused.keys()], ["a", "c", "b", "d"]);
  assert.equal(fused.get("a"), 1 / (RRF_K + 1) + 1 / (RRF_K + 3));
  assert.equal(fused.get("d"), 1 / (RRF_K + 2));
});

test("fusion dedupes ids within a list and tolerates an empty list", () => {
  const fused = fuseRankings([["x", "x", "y"], []]);
  assert.equal(fused.get("x"), 1 / (RRF_K + 1));
  assert.equal(fused.get("y"), 1 / (RRF_K + 3));
  assert.equal(fuseRankings([[], []]).size, 0);
});

test("query terms ignore negations, operators and single characters", () => {
  assert.deepEqual(queryTerms('Huur "Amsterdam 2025" or a -oud contract'), ["huur", "amsterdam", "2025", "contract"]);
});

test("snippets center on the first matching term and trim on word boundaries", () => {
  const text = `${"voorwoord ".repeat(60)}De huurprijs bedraagt 950 euro per maand. ${"bijlage ".repeat(60)}`;
  const snippet = passageSnippet(text, ["huurprijs"], 120);
  assert.match(snippet, /^…/);
  assert.match(snippet, /…$/);
  assert.ok(snippet.includes("De huurprijs bedraagt 950 euro"));
  assert.ok(snippet.length <= 122);
  const words = snippet.slice(1, -1).split(" ");
  assert.ok(["voorwoord", "De"].includes(words[0]) && ["bijlage", "maand."].includes(words.at(-1)!), "no partial words at the edges");
  assert.equal(passageSnippet("  short\n\ntext ", ["x"]), "short text");
  assert.match(passageSnippet("woord ".repeat(100), ["missing"], 50), /^woord.*…$/);
});
