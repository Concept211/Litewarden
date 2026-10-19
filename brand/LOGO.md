# Litewarden logo

The mark is **Keep**: a castle tower whose battlements are a key's teeth and whose base is the key's bow.
Chosen 2026-10-19 from three shortlisted marks (`_mockups/logo/index.html` has the alternates and the process).
Wordmark: "lite" in Hanken Grotesk Light next to "warden" in Hanken Grotesk ExtraBold (SIL OFL, outlined, no live text).

## Files

| File | Use |
|---|---|
| `symbol.svg` | The mark, one ink, primary blue. Single path, no strokes. |
| `symbol-white.svg` | Same path in white, for blue tiles and dark photos. |
| `symbol-dark.svg` | Same path in the dark-mode primary (#65ABFF), for dark grounds. |
| `favicon.svg` | The 16 px drawing (shorter neck, wider tower, bigger ring) on a square canvas. Switches to #65ABFF in dark browser UIs. |
| `wordmark.svg` | "litewarden" alone, ink. |
| `readme/logo-light.svg`, `readme/logo-dark.svg` | README header lockup, transparent, for light and dark GitHub themes. |
| `icons/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png` | Chrome extension icons for `manifest.json`. Blue tile, white mark. `icon-128.png` is 96 px artwork with 16 px transparent padding. |
| `icons/locked-16.png`, `locked-32.png` | Toolbar icon while the vault is locked: slate tile, pale mark, small padlock badge. Use `icon-*` when unlocked. |
| `store/icon-128.png` | Web Store icon (same file as `icons/icon-128.png`). |
| `store/promo-440x280.png`, `.svg` | Web Store small promo tile. |
| `_src/` | `keep-exact.mjs` builds the mark from exact arcs; `build.mjs` regenerates every file here; `toolbar-proof.png` is the proof below. |

## Colours

| Role | Light | Dark |
|---|---|---|
| Primary (mark, links) | #1252A3 | #65ABFF |
| Primary hover | #0D3C77 | n/a |
| Tint | #DBE5F6 | n/a |
| Ink (wordmark, text) | #1B2029 | #F1F3F7 |
| Ground | #F1F3F7 | #202733 |
| Locked state (icon only) | tile #5C6779, mark #DCE2EC, badge #F1F3F7 with #1B2029 padlock | same |

The mark is one flat colour. Only these colours; do not tint it or add a gradient.

## Toolbar icon decision

Proofed in `_src/toolbar-proof.png` at true pixels on #F1F3F4 and #202124. **Chosen: blue tile with a white mark.**
A transparent #1252A3 mark disappears on the dark toolbar (about 2:1) and a transparent #65ABFF mark would need
theme-aware icon switching code; the tile reads on both with one PNG set. At 16 px the tile shows a white tower and
ring, and the crenels are visible as a notched top.

## Clear space and minimum size

- Clear space: one merlon width (a quarter of the mark's width) on every side of the mark; one "l" height around a lockup.
- Minimum: the tile icon is designed down to 16 px. The bare mark needs 24 px height (the notches close up below that). The lockup needs 24 px height; use the symbol alone below that.
- Do not stretch, rotate, outline or recolour the mark; do not put the blue mark on a dark ground (use `symbol-dark.svg`).

## Notes

- `_mockups/r3/shared/keep.js` `tall` matches `symbol.svg` (same geometry, 187 of 312,800 px differ at 800 px high, anti-aliasing only), but its path is 18 KB of polygonised micro-segments; `symbol.svg` is the same shape in 61 commands with true arcs, so use that. The `square` favicon in `keep.js` is an older drawing with a shorter neck; `favicon.svg` here has a slightly longer neck and is the refined one.
- `favicon.svg`'s dark-mode rule is one `<style>` block, the only thing the lint warns about (the second colour is never drawn at the same time as the first).
- `_src/build.mjs` reads the outlined wordmark from `_mockups/logo/directions/keep/wordmark.svg` and the skill scripts under `~/.claude/skills/concept-logo-design/scripts`. Edit those paths if you rebuild elsewhere.
- Not done: no `favicon.ico`, no PDF, no PNG above 128 px, no OG image. Say so if you want them.
