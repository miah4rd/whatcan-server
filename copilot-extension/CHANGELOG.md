# Copilot extension — changelog

Single source of truth for the Chrome extension. Everyone (owner, Nikita,
Alexander) edits `copilot-extension/` in this repo and adds a line here on each
release, so all changes are shared and visible. Build: zip the folder CONTENTS
(files at the archive root) to `artifacts/landing/public/extNN.zip`, then copy to
the VPS `artifacts/landing/dist/public/` (only that is served).

## 1.0.89

- New "🌐 Choose on site" button in the edit panel, next to the manual
  "paste a link" box. Opens unicorn-properties.com in a full-screen overlay
  in picker mode; the broker clicks listings there, hits "Send to Copilot" on
  the site, and the chosen links land in the attachments automatically — no
  more tabbing to the site, copying a URL, and pasting it back by hand.
  Requires the matching site-side picker mode (unicorn-properties.com) to be
  live. The manual paste box stays as a fallback.

## 1.0.87

- Links the broker curated by hand are no longer overwritten. Removing the bot's
  listings and adding your own, then asking for a rewrite, used to bring the
  removed ones straight back and append yours on top — a chosen shortlist of two
  came back as five. The panel now tells the server the list was curated, and the
  server rewrites only the words, leaving the links exactly as chosen.

## 1.0.86 — 2026-07-29 — reconcile the two forked lines + fixes

Before this, the extension had **forked into two lines that never merged**:
- **Nikita/Alexander's served line** reached `ext71` (its only change over v70 was
  applying server re-picked links on edit — the "edit moves the listings too" fix).
- **The owner's local line** reached `v85` (temperature chip, screenshot-as-context,
  "No reply needed", draggable divider, "Move stage", reschedule, etc.) — and this
  is the version the brokers (Robert, Amelia) actually had installed.

Neither had the other's work. `v86` reconciles them into one source in git.

- **Merged Nikita's ext71 change into our `rewriteServer`**: it now sends the
  current `attachments` and applies the server's re-picked `json.attachments`
  (keeping links the broker added by hand), alongside our screenshot/temperature
  logic. So an edit like "these are too expensive" now updates the LINKS too, not
  just the text — matching the mobile `/m` behaviour. (Was missing on v85, so
  brokers had that gap.)
- **Default expanded size on first install.** With no saved size the panel fell
  back to a tiny height and the conversation/suggestion collapsed to a sliver —
  new brokers opened a squished bot and didn't know it could be resized. It now
  opens at a comfortable height (≈ viewport − 40, capped 760px); the broker can
  still drag the grip to resize, which persists as before.

Carries everything from the owner's v72–v85 line (all the UI features above).
