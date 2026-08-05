# Copilot extension — changelog

Single source of truth for the Chrome extension. Everyone (owner, Nikita,
Alexander) edits `copilot-extension/` in this repo and adds a line here on each
release, so all changes are shared and visible. Build: zip the folder CONTENTS
(files at the archive root) to `artifacts/landing/public/extNN.zip`, then copy to
the VPS `artifacts/landing/dist/public/` (only that is served).

## 1.0.94 — bring back the always-visible bubble

1.0.93 required clicking the extension's Chrome toolbar icon to open the
panel at all — no visible sign on the page itself that the extension was
even running, which is exactly the "плагин обновился, но не вижу его в
АМО" report this fixes. A small floating bubble (same spot the old
full-UI version lived) is back: click it to open/close the same panel the
toolbar icon also controls. Also a reminder for next time: after "Update"
in chrome://extensions, the already-open amoCRM tab is still running the
PREVIOUS content script — it needs a manual reload (F5) to pick up new
code, same as any content-script update.

## 1.0.93 — the panel now IS `/m`, not a second copy of it

`content.js` stopped reimplementing the suggestion/inbox UI a second time.
Every single drift bug this session (curated-panel links overwritten, links
duplicated on edit, stage never advancing past New LEAD, "choose on site"
missing here) happened because this file and the server's own `/m` PWA were
two separate implementations of the same features, and a fix only ever
landed in one of them. `content.js` is now a small bridge (~350 lines, was
~2600): it detects which amoCRM lead is open, who's logged in, and whether
the broker replied directly in amoCRM's own chat (things only page-level
access can do) — then embeds `/m` itself in an iframe for literally
everything else. Every future feature/fix lives in `mobile.ts` and applies
to both surfaces the moment the page reloads — no new extension version,
no Store review wait.

User-visible changes:
- The panel is now `/m`'s own layout inside the iframe — same features,
  same buttons, same "Choose on site" picker (which this file's old
  version never had at all).
- Push notifications inside the embedded panel are hidden — Notifications
  permission doesn't reliably work from a cross-origin iframe; push still
  works normally in the standalone `/m` PWA (install to home screen).
- A broker's `guide`/`outputLanguage` set on the options page still applies
  (carried into the iframe), same as before.
- Known gap: opening a lead in amoCRM that has no pending suggestion yet
  (created moments ago, nothing has processed it) shows nothing, same as a
  push notification deep-link always did — generating one on the spot needs
  a new server endpoint that doesn't exist yet, tracked as a follow-up.

## 1.0.92

- Pipeline switcher: a broker who genuinely works both Rental and Unicorn
  (not just the fully Rental-scoped roster) can now tap a small button in the
  panel header to filter the inbox to one pipeline or back to auto/both.
  Server honors an explicit `?pipeline=` override on `/api/suggestions`.

## 1.0.91

- Picker overlay reveals faster: it now shows the site as soon as its React
  app is actually ready, instead of waiting for the iframe's `load` event —
  which was also waiting on GTM/Meta Pixel/Yandex Metrika and every image.

## 1.0.90

- Picker overlay fades/scales in instead of popping up, and the iframe stays
  hidden behind the dark modal until it finishes loading — no more white
  flash before the site paints.

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
