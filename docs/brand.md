# Aetos Websites — brand

**Charcoal & Eagle Gold.** Premium, trustworthy, calm. Mostly neutral, with gold used sparingly.

## Colour palette

| Role | Name | Hex | RGB | Use |
| --- | --- | --- | --- | --- |
| Main | Charcoal | `#1F2124` | 31, 33, 36 | Headings, logo background, dark sections, footer |
| Logo | White | `#FFFFFF` | 255, 255, 255 | The eagle and wordmark on Charcoal |
| Secondary | Graphite | `#2E3135` | 46, 49, 53 | Cards and panels on dark sections |
| Background | Marble | `#F6F4EF` | 246, 244, 239 | Page background (warm white, easier on the eye than pure white) |
| Line | Stone | `#D9D4CA` | 217, 212, 202 | Borders, dividers |
| Body text | Slate | `#5C6066` | 92, 96, 102 | Paragraph text on Marble |
| Accent | Eagle Gold | `#C9A13B` | 201, 161, 59 | Buttons, highlights: on Charcoal, or as a button with Charcoal text |
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
- **Logo:** a white bald-eagle head (realistic silhouette, detail made with Charcoal cut-outs) on Charcoal, beside a white wordmark. On light backgrounds: the Charcoal eagle on Marble. Gold is never in the logo: it stays the accent colour for buttons and highlights.
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
- Icon and logo: the white eagle on Charcoal

## Logo prompt (ChatGPT / image generator)

Reference look: a realistic **bald eagle head in profile**, built from bold white shapes and charcoal negative space,
like a stencil or a sports-crest silhouette. Not a geometric or faceted eagle, and not a cartoon.

> Create a minimalist two-colour logo mark: the head of a bald eagle in side profile, facing left, in solid pure white (#FFFFFF) on a solid charcoal (#1F2124) square background. Realistic proportions and a natural silhouette, not geometric facets and not a cartoon. Show the detail only through charcoal negative space cut into the white shape: a heavy, low brow ridge over a narrow, focused eye giving a stern, serious expression; a large hooked beak with a clear line separating the upper and lower beak; and a few short, sharp, jagged feather points where the neck ends at the bottom. The head fills most of the square and is cropped tightly, like a crest or emblem. Flat vector style: exactly two colours, no gradients, no shading, no outlines, no texture, no gold, no text. Clean, bold shapes that still read clearly at 32×32 pixels as a favicon.

Follow-ups that help:

- "Simpler: fewer feather cut-outs, bigger and bolder shapes."
- "Make the brow heavier and the eye narrower: more serious, less friendly."
- "Same eagle, but white on a transparent background."
- "Now put it to the left of the word AETOS in bold, wide-spaced white capitals (Inter ExtraBold) on charcoal #1F2124."

Image generators can't output a true vector file. Once you like one, trace it into an SVG with vectorizer.ai, Illustrator's Image Trace, or Inkscape's Trace Bitmap. Then fix the exact colours to the hex codes above.
