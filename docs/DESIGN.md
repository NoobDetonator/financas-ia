---
name: KAKEIBO.SYS
colors:
  void-black: '#06060F'
  deep-navy: '#101028'
  indigo: '#1B1B3C'
  slate: '#3A4568'
  grey-blue: '#6B7F9C'
  pale-grey: '#A7B6CC'
  bone-white: '#F0EEE6'
  pure-white: '#FFFFFF'
  blue: '#4A6AD4'
  sky: '#4BB0F7'
  pale-cyan: '#5CE8F2'
  cyan: '#5CE8F2'
  green: '#3CC976'
  amber: '#F0B429'
  pink: '#E84B72'
  purple: '#B04A98'
  tan: '#E6A878'
themes:
  dark:
    chassis: '#101028'
    panel: '#1B1B3C'
    well: '#06060F'
    raised: '#2A2A52'
    text: '#F0EEE6'
    muted: '#A7B6CC'
    chart-bg: '#06060F'
  light:
    chassis: '#C5C2D4'
    panel: '#F6F5FB'
    well: '#FFFFFF'
    raised: '#E5E3EF'
    text: '#141428'
    muted: '#3F3F66'
    chrome: '#282850'
    chart-bg: '#FFFFFF'
typography:
  display-currency:
    fontFamily: VT323
    fontSize: 32px
    fontWeight: '400'
    lineHeight: 36px
  display-metric:
    fontFamily: VT323
    fontSize: 26px
    fontWeight: '400'
    lineHeight: 28px
  headline:
    fontFamily: DotGothic16
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 22px
  body:
    fontFamily: DotGothic16
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-ui:
    fontFamily: DotGothic16
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: DotGothic16
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  body-xs:
    fontFamily: DotGothic16
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  body-lg:
    fontFamily: VT323
    fontSize: 22px
    fontWeight: '400'
    lineHeight: 24px
  label-status:
    fontFamily: Silkscreen
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 14px
  label-micro:
    fontFamily: Silkscreen
    fontSize: 10px
    fontWeight: '400'
    lineHeight: 12px
    letterSpacing: 0.5px
  label-nano:
    fontFamily: Silkscreen
    fontSize: 9px
    fontWeight: '400'
    lineHeight: 11px
spacing:
  pixel_unit: 4px
  margin_sm: 8px
  margin_md: 16px
  margin_lg: 32px
  gutter: 8px
  window_padding: 10px
---

## Brand & Style
KAKEIBO.SYS is a high-fidelity retro-technical personal finance workstation inspired by NEC PC-9800 software and 90s Japanese anime sci-fi UIs. The brand persona is **Cybernetic Utility** — dense, precise, nostalgic, and operational. It targets power users who prefer information density and mechanical feedback over sparse minimalism.

The committed visual world is **Neo-Retro Anime Sci-Fi**: dark navy chassis, gold/pink double-bevel window frames, segmented dither bars, CRT scanlines, and 48×48 animated pixel mascots. Classic grey Win3.1 chrome is an anti-reference — do not regress to it. Generic white SaaS sheets and Material purple are also anti-references.

## Colors

### Primitive palette
The live 16-color token set lives in `src/styles/pc98-tokens.css` (`:root`).

- **Surfaces (dark):** `void-black` wells, `deep-navy` chassis, `indigo` window bodies, `slate` chrome.
- **Text (dark):** `bone-white` primary, `pale-grey` secondary, `pale-cyan` interactive/data labels.
- **Primary actions / selection:** `blue` and `pale-cyan` for active nav.
- **Sky accent:** `sky` for secondary highlights and avatar accents.

### Semantic roles (both themes)
| Token | Role |
|---|---|
| `--c-income` | Income / success / bull candles |
| `--c-expense` | Expense / danger / bear candles |
| `--c-warn` | Warning / gold frames / at-risk |
| `--c-critical` | Overrun / behind goal |
| `--c-info` | Info / on-track / cyan series |
| `--c-focus-ring` | Keyboard focus outline |
| `--shadow-hard` | Hard bevel offset shadow |

Never encode budget overrun with color alone — keep `[ESTOUROU!]` / `[RISCO]` text chips.

### Themes
**Default theme is light.** Toggle via status bar `THEME: DARK/LIGHT` (`data-theme` on `<html>`, persisted in `localStorage` key `kakeibo.theme`; unset → light).

Light mode is the **same product**, cooled for contrast: chassis `#C5C2D4`, windows `#F6F5FB`, raised controls `#E5E3EF` (must differ from windows), wells `#FFFFFF`, chrome `#282850`. Prefer cool paper over warm cream — keeps Neo-Retro identity without the terracotta/cream cluster. Use semantic surfaces (`--c-surface-*`, `--c-border-strong`, `--shadow-hard`) — never invert `--c-void-black` into a light border color. Accents are darkened for WCAG AA on paper. Title/status chrome keep light-on-dark ink via `--c-paper-fixed`. Chart hosts fill `--c-chart-bg` (= `--c-surface-well`) so canvases never float as a mismatched square.

Dark mode elevates deliberately: well `#06060F` → window `#1B1B3C` → raised `#2A2A52` on chassis `#101028`, with muted text `#A7B6CC` for AA on indigo panels.

Never introduce soft purple-on-white gradients, glassmorphism, or rounded pill chrome. Sharp corners only.

## Typography
Three families carry the hierarchy:

- **VT323** — currency and large metrics (`.num-currency`, `.text-metric`, `.text-display`).
- **DotGothic16** — body UI in PT-BR (`.text-body`, `.text-sm`, `.text-xs`). No Japanese UI copy.
- **Silkscreen** — micro labels, status chrome, hotkeys, chart titles/legends (`.micro-label`, `.text-micro`, `.text-nano`).

Use the CSS type tokens (`--fs-*`) rather than one-off pixel sizes. Keep `-webkit-font-smoothing: none` / pixel rendering for the CRT feel.

### Type ramp
| Token | Size | Use |
|---|---|---|
| `--fs-nano` | 9px | Chart axis micro, dense badges |
| `--fs-micro` | 10px | Status buttons, chart titles |
| `--fs-label` | 11px | Window chrome, Silkscreen labels |
| `--fs-xs`–`--fs-ui` | 12–15px | Body UI |
| `--fs-metric` / `--fs-display` | 26–32px | VT323 money readouts |

## Chart language
All canvas charts in `src/scripts/charts.ts` share one PC-98 system:

1. **Palette from CSS vars** via `readChartPalette()` — adapts to dark/light automatically.
2. **`imageSmoothingEnabled = false`** — pixel-aligned fills; no soft anti-aliased needles.
3. **Title plate** + **legend plates** (right-aligned when space is tight) + **axis ticks/grid** + **value callouts** with background plates.
4. **Segment/block meters** for gauges and budget bars (same chunky language).
5. **Units in R$** on axes and node labels; projection events use a numbered **EVENTOS** rail (no overlapping callouts).
6. **Status chips** like `[ON TRACK]` / `[AT RISK]` / `[ESTOUROU!]` — never color-only.
7. **SR summaries** — each renderer updates `aria-label` + a visually hidden `.chart-sr-summary` live region.

Chart CSS tokens: `--c-chart-bg`, `--c-chart-grid`, `--c-chart-axis`, `--c-chart-label`, `--c-chart-title`, `--c-chart-plot`, `--c-chart-plot-fill`, `--c-series-1`…`--c-series-6`.

Covered renderers: Radar, Gauge/Savings meter, Sankey, Waterfall, Donut, Candlestick, Flow line, Projection. DOM budget bars stay segmented blocks with the same fill semantics (`filled-cyan` / `filled-amber` / `filled-pink`).

## Accessibility (WCAG AA)
- Body text contrast ≥ 4.5:1 on both themes; large metrics ≥ 3:1.
- Focus-visible amber/warn ring (`--c-focus-ring`) on all interactive controls.
- Theme / CRT / SND toggles are buttons with `aria-pressed`.
- Chart canvases expose `role="img"`, meaningful `aria-label`, and SR text summaries.
- Budget bars are keyboard-activatable (`role="button"`, Enter/Space).
- `prefers-reduced-motion` collapses non-essential animation; state changes remain visible.
- Do not rely on color alone for critical finance states.

## Layout & Spacing
Fullscreen 3-column Operate shell:

1. **Status bar** (~30px) — theme / CRT / SND / help (no duplicate AI entry strip)
2. **Left nav** (~220px) with hotkey badges — finance views only (AI lives solely in the right dock; hotkey `2` focuses it)
3. **Center workspace** — one active `view-panel`
4. **Right AI dock** (~320px) persistent communicator + NL ledger entry

Internal spacing uses the 4px pixel grid (`--space-1`…`--space-5`). Window content padding is 8–10px; gutters between windows are 8–10px. Dashboard bottom dock stays pinned.

Responsive collapse (required):
- **≤1100px:** AI dock becomes an overlay opened by Chat / hotkey `2`
- **≤800px:** Nav becomes a horizontal chip rail; center stacks full-width; metric cards go 2×2 then 1-col

## Elevation & Depth
Depth is hard bevel + solid offset shadow (`--shadow-hard`), never soft blur halos.

1. **Raised windows/buttons:** 2px border + `4px 4px 0` hard shadow
2. **Sunken wells:** inset 2px deep-navy / well shadow
3. **Gold / pink frames:** border color swaps to amber/pink; title bar fills match

## Shapes
**0px radius everywhere.** Segmented progress blocks stay rectangular. No pills.

## Components
- **System windows:** indigo/paper body, titled chrome, optional `gold-frame` / `pink-frame` / `accent-header` / `alert-header`
- **Buttons:** raised slate; `btn-primary` blue; `btn-gold` amber; `btn-alert` pink; press translates 1px
- **Progress:** segmented tracks or dither fills animated via `transform: scaleX`, not width
- **Journal rows:** dense grid with batch checkbox column; selection = pale-cyan fill
- **Modals:** centered PC-98 windows on dimmed void backdrop; Escape closes
- **Mascots:** canvas pixel sprites, image-rendering: pixelated
- **Theme toggle:** status-bar `THEME: DARK/LIGHT` next to CRT/SND (default light)
- **Sidebar:** hotkey badge + pixel SVG icon + label (PT-BR)
