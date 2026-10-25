// The demo's brand colour (pure). It only ever sits behind white text (buttons, hero panel, footer) or as a thin
// accent line, so it must give white text a WCAG contrast of at least 4.5:1. Their own colour when it does; else the
// first 10% darker shade of it (same hue, up to 50% darker) that does; else Charcoal. No usable colour: the trade's
// default. Only an exact "#rrggbb" counts as a colour, so nothing scraped can reach the CSS (e.g. "red;}body{...}").

export const CHARCOAL = "#1a1c20";
export const MIN_CONTRAST = 4.5;
export const TRADE_DEFAULT = Object.freeze({ landscaper: "#2f6b3a", generic: "#1a1c20" });

const HEX = /^#[0-9a-f]{6}$/i;
const WHITE = "#ffffff";
const DARKEN = [0.9, 0.8, 0.7, 0.6, 0.5];

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function luminance(hex) {
  if (typeof hex !== "string" || !HEX.test(hex)) throw new TypeError("contrastRatio needs two #rrggbb colours");
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two "#rrggbb" colours (1 to 21, order doesn't matter). */
export function contrastRatio(hexA, hexB) {
  const a = luminance(hexA);
  const b = luminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const toHex = (rgb) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

/** The colour to put behind white text: {colour: "#rrggbb", source: "theirs"|"darkened"|"trade"|"charcoal"}. */
export function pickColour(theirs, templateId) {
  if (typeof theirs !== "string" || !HEX.test(theirs)) {
    const colour = Object.hasOwn(TRADE_DEFAULT, templateId) ? TRADE_DEFAULT[templateId] : TRADE_DEFAULT.generic;
    return { colour, source: "trade" };
  }
  const colour = theirs.toLowerCase();
  if (contrastRatio(colour, WHITE) >= MIN_CONTRAST) return { colour, source: "theirs" };
  const rgb = channels(colour);
  for (const f of DARKEN) {
    const darker = toHex(rgb.map((c) => c * f));
    if (contrastRatio(darker, WHITE) >= MIN_CONTRAST) return { colour: darker, source: "darkened" };
  }
  return { colour: CHARCOAL, source: "charcoal" };
}
