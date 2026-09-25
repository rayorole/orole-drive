import assert from "node:assert/strict";
import test from "node:test";
import { CHUNK_OVERLAP, CHUNK_TARGET, chunkSections, normalizeText } from "./search-chunk";

const sentence = (index: number) => `Zin nummer ${index} gaat over de vakantie in Zeeland en het weer daar.`;
const prose = (count: number, from = 0) => Array.from({ length: count }, (_, index) => sentence(from + index)).join(" ");

test("short content is one chunk prefixed with the file name", () => {
  assert.deepEqual(chunkSections("notes.txt", [{ text: "  Hello\r\n\r\n\r\nworld  ", location: null }]), [
    { ordinal: 0, location: null, text: "notes.txt\n\nHello\n\nworld" },
  ]);
});

test("only the first chunk carries the name, even across sections", () => {
  const chunks = chunkSections("deck.pptx", [{ text: "Intro", location: "slide 1" }, { text: "Budget", location: "slide 2" }]);
  assert.deepEqual(chunks.map((chunk) => [chunk.location, chunk.text]), [["slide 1", "deck.pptx\n\nIntro"], ["slide 2", "Budget"]]);
});

test("long text is split within the target size with overlapping sentence-aligned chunks", () => {
  const text = prose(120);
  const chunks = chunkSections("a.txt", [{ text, location: null }]);
  assert.ok(chunks.length > 3);
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.ordinal, index);
    const body = index ? chunk.text : chunk.text.slice("a.txt\n\n".length);
    assert.ok(body.length <= CHUNK_TARGET, `chunk ${index} is ${body.length} characters`);
    assert.ok(text.includes(body), "chunks are verbatim slices of the normalized text");
    if (index < chunks.length - 1) assert.match(body, /\.$/, "cut after a sentence");
  });
  for (let index = 1; index < chunks.length; index++) {
    const previous = chunks[index - 1].text;
    const head = chunks[index].text.slice(0, 60);
    assert.ok(previous.includes(head) && previous.indexOf(head) >= previous.length - CHUNK_OVERLAP, "each chunk starts inside the previous chunk's last 200 characters");
    const position = text.indexOf(chunks[index].text);
    assert.match(text[position - 1], /\s/, "never starts mid-word");
  }
  // Everything is covered: the last sentence ends the last chunk.
  assert.ok(chunks.at(-1)!.text.endsWith(sentence(119)));
});

test("paragraph breaks win over sentence breaks", () => {
  const first = prose(15);
  const chunks = chunkSections("p.md", [{ text: `${first}\n\n${prose(15, 100)}`, location: null }]);
  assert.equal(chunks[0].text, `p.md\n\n${first}`);
});

test("never splits across sections and keeps each location", () => {
  const chunks = chunkSections("book.xlsx", [{ text: prose(40), location: "Sheet1" }, { text: prose(40, 500), location: "Sheet2" }]);
  const sheet1 = chunks.filter((chunk) => chunk.location === "Sheet1");
  const sheet2 = chunks.filter((chunk) => chunk.location === "Sheet2");
  assert.ok(sheet1.length > 1 && sheet2.length > 1);
  assert.ok(sheet1.every((chunk) => !chunk.text.includes("nummer 500 ")));
  assert.ok(sheet2.every((chunk) => !chunk.text.includes("nummer 0 ")));
  assert.deepEqual(chunks.map((chunk) => chunk.ordinal), chunks.map((_, index) => index));
});

test("unbroken text is hard-cut and always makes progress", () => {
  const chunks = chunkSections("blob", [{ text: "x".repeat(CHUNK_TARGET * 3 + 10), location: null }]);
  assert.equal(chunks.length, 4);
  assert.equal(chunks.slice(1).reduce((sum, chunk) => sum + chunk.text.length, 0) + chunks[0].text.length - "blob\n\n".length, CHUNK_TARGET * 3 + 10);
});

test("empty sections produce nothing and the chunk count is capped", () => {
  assert.deepEqual(chunkSections("empty.txt", [{ text: " \n\t ", location: null }]), []);
  assert.equal(chunkSections("big.txt", [{ text: prose(2_000), location: null }], { maxChunks: 5 }).length, 5);
});

test("normalizeText collapses whitespace but keeps paragraphs", () => {
  assert.equal(normalizeText("a\t\tb  \n  c\n\n\n\nd"), "a b\nc\n\nd");
});
