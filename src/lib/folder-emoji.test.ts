import assert from "node:assert/strict";
import test from "node:test";
import { folderEmojiSchema } from "./folder-emoji";

test("folder emoji accepts composed emoji without splitting flags, skin tones or families", () => {
  for (const emoji of ["📁", "❤️", "❤", "👍🏽", "👨‍👩‍👧‍👦", "🇧🇪", "1️⃣", "#⃣", "🏳️‍🌈", "🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}"]) {
    assert.equal(folderEmojiSchema.parse(emoji), emoji);
  }
  assert.equal(folderEmojiSchema.parse(null), null);
});

test("folder emoji rejects arbitrary text, invisible controls and multiple emoji", () => {
  for (const value of ["", "hello", "1", "#", "🇧", "📁📁", "📁a", " 📁", "📁\n", "📁\u200b", "<svg>", "a\u0301", "👨‍" , "📁".repeat(40)]) {
    assert.equal(folderEmojiSchema.safeParse(value).success, false, JSON.stringify(value));
  }
});
