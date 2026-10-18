const charsFromRange = (start: number, end: number): string =>
  Array.from({ length: end - start + 1 }, (_, index) =>
    String.fromCodePoint(start + index),
  ).join("");

// Representative GB 2312 level-1 common Hanzi sample, kept at 200 code points
// so it is large enough to exercise CJK subset cmap paths without becoming
// expensive for regular regression runs.
export const commonHanzi =
  "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总";

// Mixes GB 2312 level-2 Hanzi with an Extension-B Hanzi covered by the
// bundled SC/JP export fonts. Unsupported glyph coverage is tested
// separately so this visual release artifact only gates renderer behavior.
export const rareHanzi =
  "亍丌兀丐廿卅丕亘丞鬲孬噩丨禺囟胤馗毓睾鼐乜乩仄仃仉仂𠮷";

export const kana = [
  charsFromRange(0x3041, 0x3096),
  "ゝゞゟ",
  charsFromRange(0x30a1, 0x30fa),
  "ヽヾヿ",
  charsFromRange(0xff66, 0xff9f),
].join("");

export const traditional = "臺灣廣體龍門裏著眾髮";

export const fullWidthPunct = "、。「」《》…—，．？！：；（）【】“”‘’";

export const mixedScripts = [
  "Shiori 中文 overlay 123 ABC",
  "かなカナ半角ｶﾅ mixed text",
  "繁體臺灣 + 简体中国 + English",
  "Rare CJK 𠮷 with punctuation 、。「」",
  "PDF Standard-14 Helvetica + Noto Sans CJK",
] as const;

export const cjkRegressionSampleCategories = [
  { key: "commonHanzi", label: "GB 2312 level-1 common Hanzi", text: commonHanzi },
  { key: "rareHanzi", label: "GB 2312 level-2 and Extension B Hanzi", text: rareHanzi },
  { key: "kana", label: "Hiragana, Katakana, and half-width Katakana", text: kana },
  { key: "traditional", label: "Traditional Hanzi variants", text: traditional },
  { key: "fullWidthPunct", label: "Full-width punctuation", text: fullWidthPunct },
  { key: "mixedScripts", label: "Mixed script strings", text: mixedScripts.join(" | ") },
] as const;
