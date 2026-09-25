import { z } from "zod";

// Pictographs (including ZWJ families and skin tones), flags, keycaps, and subdivision flags.
// No text, whitespace, control characters, or multiple graphemes can enter folder metadata.
const emojiSequence = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*|\u{1F3F4}[\u{E0061}-\u{E007A}]{2,7}\u{E007F})$/u;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

export const folderEmojiSchema = z.string().max(64, "Choose one emoji for the folder.").refine((value) => {
  if (!emojiSequence.test(value)) return false;
  const iterator = graphemes.segment(value)[Symbol.iterator]();
  return !iterator.next().done && Boolean(iterator.next().done);
}, "Choose one emoji for the folder.").nullable();
