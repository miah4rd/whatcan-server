---
name: whatcan-extension-ui
description: The design system and layout rules for the whatcan Chrome-extension copilot panel (content.js) — colors, chip/badge styles, spacing, the resizable/split panel structure. Load before changing ANY extension UI so new controls match the existing look instead of adding one-off inline styles, and use it (with the frontend-design skill) to clean up the scattered-chip clutter the owner has flagged.
---

# whatcan Extension UI

The Chrome extension is a single floating panel that overlays amoCRM. Its source is one
big `content.js` (unbundled, not in the server repo — prebuilt zips are shipped and the
broker reinstalls). The owner's standing complaint: chips/badges look scattered and
"понатыкано". The fix is a shared vocabulary, not more one-off inline styles. Follow this
before adding UI; pair it with the `frontend-design` skill for larger reworks.

**Precedence:** the existing panel conventions and this skill are authoritative for the
copilot UI. General design skills (`frontend-design`, etc.) are used within these
constraints — the goal here is clean, consistent restraint, never distinctive risk-taking
that would fight the established look. If their advice conflicts, this skill wins.

## Panel structure (detail view)

The panel is a flex column that fills its resized height. The lead-detail view is:

```
cardtop (Back / Open Lead)         fixed
lead-hdr (name + task chip + temp) fixed
[temp picker / reschedule popover] fixed, toggled
thread  (conversation)             flex-grow  ← resizable
conv-divider (drag handle)         fixed, draggable — persists convSplit
lowerpane (suggested msg + stage)  flex-grow, scrolls
actions (Approve / Skip / Edit)    fixed at bottom
```

Both `thread` and `lowerpane` grow to fill (no dead space); the `conv-divider` sets the
split (`convSplit`, saved to `copilotConvSplit`). Window size persists as
`copilotPanelSize`. When adding a section, decide: does it belong to the fixed header,
the scrolling lowerpane, or the fixed footer — never leave it floating between panes.

## Color tokens (use these, don't invent new hexes)

- Surfaces: panel `#273444`; header/footer bars `#2c3e50`; deep/sticky `#16202e`;
  conversation `#1c2a3a`; input bg `#0f1826`.
- Borders: `#3a4a5e` (structural), `#2a3a50` (subtle divider).
- Text: primary `#e6e8ee`/`#e2e8f0`; muted `#8a96a8`/`#94a3b8`; faint `#6b7488`/`#56687e`.
- Accents by meaning — keep them consistent: primary/action blue `#60a5fa`; LIVE green
  `#34d399`; PUSH amber `#fbbf24`; REACH purple `#a78bfa`; danger/overdue red `#f87171`.
- Temperature: hot red (`#fca5a5` on `rgba(239,68,68,.16)`), warm orange (`#fdba74` on
  `rgba(251,146,60,.16)`), cold blue (`#93c5fd` on `rgba(96,165,250,.14)`).

## Chip / badge pattern (this is where clutter creeps in)

Every small status pill should read as the same family: `font-size:10px; font-weight:700;
border-radius:3px (pills 10px); padding:1px 6-7px`, a tinted translucent background of its
accent, and text in the accent color. Task status (`taskStatusBadge`), temperature
(`li-temp`), stage (`li-stage`) already follow this — match it. Rules to keep it tidy:

- One row, consistent gap (`gap:6-7px`), aligned baseline; don't stack chips on separate
  lines or scatter them across the card.
- A chip is either **status** (read-only) or **action** (tap to change). Action chips get
  `cursor:pointer` and a hover/affordance and open an inline picker in place (see the
  temperature picker and reschedule popover) — not a new modal.
- Max ~3 chips visible at once; if more, collapse the rest behind a control. Order by
  importance (task/urgency → temperature → stage).
- Reuse a helper (`tempChipHtml`, `taskStatusBadge`) instead of re-writing inline styles;
  if you need a new chip type, add a helper next to those so the style stays in one place.

## Interaction conventions

- English labels, sentence case, terse ("Open now", "Set task", "Reschedule").
- Editing: the ✓ checkmark ALWAYS saves the manual edit verbatim; AI rewriting is a
  separate explicit "↑ Send" in the AI box (never conflate them — this was a real bug).
- Broker identity is auto-detected and read-only (no manual broker switching).
- Persist any new layout preference to `chrome.storage.local` like `copilotPanelSize` /
  `copilotConvSplit`, and guard every `chrome.*` call in try/catch.

## Shipping a change

Bump `manifest.json` version, `node --check content.js`, rezip with files at the archive
ROOT (no subfolder), name it `copilot-extension-extNN.zip`. The broker reinstalls the
unpacked/zip build — so batch UI changes to avoid repeated reinstalls. You cannot load the
extension in a headless browser here (it lives over amoCRM in the broker's Chrome), so
reason about the CSS carefully and let the broker verify; for standalone web UI use the
`webapp-testing` skill instead.
