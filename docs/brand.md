# Aetos Websites — brand

**Charcoal & Eagle Gold.** Premium, trustworthy, calm. Mostly neutral, with gold used sparingly.

## Colour palette

| Role | Name | Hex | RGB | Use |
| --- | --- | --- | --- | --- |
| Main | Charcoal | `#1F2124` | 31, 33, 36 | Headings, logo, dark sections, footer |
| Secondary | Graphite | `#2E3135` | 46, 49, 53 | Cards and panels on dark sections |
| Background | Marble | `#F6F4EF` | 246, 244, 239 | Page background (warm white, easier on the eye than pure white) |
| Line | Stone | `#D9D4CA` | 217, 212, 202 | Borders, dividers |
| Body text | Slate | `#5C6066` | 92, 96, 102 | Paragraph text on Marble |
| Accent | Eagle Gold | `#C9A13B` | 201, 161, 59 | Buttons, highlights, logo mark: on Charcoal, or as a button with Charcoal text |
| Accent text | Deep Gold | `#7A5C14` | 122, 92, 20 | Gold-coloured text or links on Marble |

### Contrast (checked against WCAG)

| Pair | Ratio | OK for |
| --- | --- | --- |
| Charcoal on Marble | 14.7 : 1 | All text |
| Eagle Gold on Charcoal | 6.6 : 1 | All text, gold buttons with Charcoal text |
| Slate on Marble | 5.8 : 1 | Body text |
| Deep Gold on Marble | 5.7 : 1 | Links, gold text on light backgrounds |
| Eagle Gold on Marble | 2.2 : 1 | **Never use for text.** Decoration only (lines, icons next to a label) |

## Rules

- **70 / 25 / 5:** about 70% Marble or Charcoal, 25% Slate and Stone, 5% Gold. The less gold, the more expensive it looks.
- **Gold means "click here" or "this matters".** It isn't used for decoration.
- **One font: Inter.** Body is Regular 400. Headings are Bold 700.
- **Wordmark:** "AETOS" in capitals, Bold or ExtraBold, letter-spacing +8 to +12%. Optionally add "WEBSITES" underneath, smaller, in Slate, with wide spacing.
- **Logo:** a flat eagle-head mark in Eagle Gold beside the Charcoal wordmark. No gradients, shadows or 3D. Reversed version: the Gold mark and a Marble wordmark on Charcoal.
- **Scope:** this is Aetos's own brand (website, emails, invoices, Stripe checkout, Control Room). Client demo sites get their own colours per trade.

## CSS tokens

```css
:root {
  --charcoal: #1F2124;
  --graphite: #2E3135;
  --marble:   #F6F4EF;
  --stone:    #D9D4CA;
  --slate:    #5C6066;
  --gold:     #C9A13B;
  --gold-text:#7A5C14;
}
```

## Stripe checkout (Settings → Branding)

- Brand colour: `#1F2124`
- Accent colour: `#C9A13B`
- Icon and logo: the eagle mark, on a Marble or Charcoal background

## Logo prompt (ChatGPT / image generator)

> Design a minimalist logo mark of an eagle's head in profile, facing right, for a premium web design company called "Aetos". Style: sharp, angular, geometric. Built from clean straight lines and pointed facets, like it was cut from metal. No soft curves, no round or cartoon shapes, no circles enclosing it. A hooked, razor-sharp beak, a narrow focused eye made from a single angular cut-out, and swept-back feather points at the back of the head forming a crest. The look is fierce, focused and confident, not aggressive or mascot-like.
>
> Exactly two colours: the eagle head in solid flat gold #C9A13B on a solid charcoal #1F2124 square background. Flat vector style, no gradients, no shadows, no 3D, no texture, no outlines, no text. Bold, simple silhouette that still reads clearly when shrunk to a 32×32 pixel favicon. Centred with generous empty space around it. Think of the sharp geometry of modern sports-team or aviation logos, simplified to the essentials.

Follow-ups that help:

- "Make it simpler: fewer facets, it needs to work at favicon size."
- "Make the beak sharper and the eye narrower."
- "Now place it to the left of the word AETOS in bold, wide-spaced capitals (Inter ExtraBold), charcoal #1F2124 on #F6F4EF."
- "Give me a version with the gold eagle on a transparent background."

Image generators can't output a true vector file. Once you like one, trace it into an SVG with vectorizer.ai, Illustrator's Image Trace, or Inkscape's Trace Bitmap. Then fix the exact colours to the hex codes above.
