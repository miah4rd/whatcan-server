# whatcan — AI copilot for Unicorn Property (Bali real estate)

Context for any new session. Read this before changing behaviour — several rules
here exist because the obvious implementation was tried and broke in production.

## What it is

A broker copilot on top of amoCRM. When a lead replies on WhatsApp, the bot
drafts the answer, picks matching listings, and the broker approves it with one
tap. Two surfaces, one server:

- **Mobile web** `/m` — a single-file PWA served from
  `artifacts/api-server/src/routes/mobile.ts` (page HTML lives in one big
  template literal). Updates the moment the server restarts; nothing to install.
- **Chrome extension** — plain unbundled files. **The source now lives IN this
  repo at `copilot-extension/`** — this is the SINGLE source of truth. Everyone
  (owner, Nikita, Alexander) edits there and commits, so every change is shared
  and versioned; no more parallel local copies. (History: two lines had forked —
  Nikita's served `ext71` and the owner's local `v85` that the brokers actually
  ran; `v86` reconciles them, see `copilot-extension/CHANGELOG.md`.) Current: **ext88.zip (1.0.88)**.
  To release a change: edit files in `copilot-extension/`, bump
  `manifest.json` version + add a `CHANGELOG.md` line, rebuild the zip **with the
  files at the archive ROOT** (`Compress-Archive -Path copilot-extension/* -Dest
  artifacts/landing/public/extNN.zip`), commit, then on the VPS copy it to
  `artifacts/landing/dist/public/` — only `dist/public` is actually served at
  `https://copilot.globalapplab.ru/extNN.zip`. The extension does NOT auto-update;
  brokers reinstall the new zip (see the open auto-update decision: Chrome Web
  Store vs self-host).

## Deploy

Production is a single VPS behind Traefik, PM2 process `whatcan`, SSH host alias
`whatcan`. The VPS's GitHub deploy key is **read-only** — it can never push, so
anything edited directly there must be reconciled by hand.

```bash
git push origin master
ssh whatcan "cd /opt/whatcan && git fetch github && git merge github/master --no-edit \
  && cd artifacts/api-server && pnpm run build \
  && cd /opt/whatcan && pm2 restart ecosystem.config.cjs --update-env && pm2 save"
```

- `pm2 restart whatcan` does **not** reload env vars. You must reference the
  **file** (`ecosystem.config.cjs`) — it reads `.env` via a custom loader
  because PM2's native `env_file` didn't work.
- `pnpm run build` is esbuild and does **not** type-check. `pnpm run typecheck`
  has pre-existing failures in files nobody touched — check only the files you
  changed.
- **`mobile.ts` gotcha:** the page is one template literal. A backtick anywhere
  in it — including inside a code comment — terminates the string and breaks the
  build. Verify with a balanced-backtick count before deploying.
- Secrets live only in `/opt/whatcan/.env` on the VPS (never in git).

## Architecture, in the order a message flows

1. **Two independent detectors** notice a lead replied:
   - `routes/amocrm-webhook.ts` — real-time amoCRM webhook (~8-15s).
   - `lib/amo-timeline-sync.ts` — quick poll every 45s over amoCRM's internal
     `events_timeline` (Puppeteer-authenticated). Safety net for missed webhooks.
2. Both route through **`lib/live-reply-debounce.ts`** — a per-lead 5s quiet
   window. Without it, both detectors fire for the same burst of messages and
   the lead gets near-duplicate replies minutes apart.
3. **`lib/generate-suggestion.ts`** writes the reply. The main completion and
   `matchProperties` run **concurrently** — serialising them delayed the push
   notification by seconds.
4. **`queueSuggestion`** (in `amocrm-webhook.ts`) persists to
   `pending_suggestions`, fires the push notification, **then** classifies the
   stage in the background (deliberately after the notification).
5. **`routes/public/approve.ts`** sends via amoCRM Salesbot (bot 22127, writes
   the text into custom field 965907), applies the stage, creates the CRM task.

## Rules that exist because of a production bug

- **amoCRM `content` timestamps are Moscow time (UTC+3), not UTC.** Parsing them
  as UTC stored every message 3h in the future, which made the poll's
  "is this newer than what I know?" check discard real replies for hours.
  (`lib/dialog-parser.ts`)
- **`events_timeline` returns events NEWEST-FIRST** and its time field is
  `date_create` / `msec_created_at`, **not** `created_at`. Reading `created_at`
  silently fell back to `now()`; consuming the raw order made "latest message"
  actually the oldest. `parseTimelineEvents` now sorts ascending — keep it that way.
- **A new incoming message must always refresh the pending LIVE suggestion.**
  Skipping when one already existed left a stale answer in the inbox and the bot
  looked blind after the first exchange. But **update the row in place** — a
  delete+reinsert changed the id under a broker with the card open, so approve
  404'd.
- **Never re-offer a listing the lead has seen.** The exclusion list is derived
  from `/property/<ID>` links **in the conversation text**, which covers every
  send path. Reading only `pending_suggestions.attachments` missed links sent
  elsewhere, and they leaked back via the explicit-mention fast path.
- **There are TWO `generateSuggestion` implementations** — `lib/generate-suggestion.ts`
  and a copy inside `routes/amocrm-webhook.ts` (which serves regen and the live
  webhook). Every rule added to only one of them silently did nothing on the main
  path: first the attachment picker, then the client's name, then the inventory
  check. Anything that shapes the prompt goes in **`buildPromptAdditions`**, which
  both call.
- **Always a real choice: 2-3 listings, never one.** A hard filter that leaves a
  single survivor is widened (bedrooms ±1) before it's accepted, and the shortlist
  is topped up in code — the model's "at most 3" was read as permission to send one.
- **The reply text is written CONCURRENTLY with property matching**, so it cannot
  know what got attached. Don't try to fix that with prompt wording alone — it kept
  ending in "want me to send them over?" with three links already attached.
  `reconcileTextWithAttachments` checks the invariant after both finish and only
  pays for a rewrite when the text actually contradicts the links.
- **A truncated AI answer is not a failed one.** `chatCompletionJSON` repairs a
  JSON object cut off by `max_tokens` — the matcher explained its reasoning first,
  ran out of room mid-array, and three chosen villas became an empty shortlist.
- **A listing with no price is held back from the first shortlist** — the client
  can't judge it. Priced and most-viewed rank first. If the lead's own area holds
  fewer than two priced villas of that size, the map widens; unpriced stock is not
  what fills the gap.
- **Two listings with the same title are not a choice** — the catalog holds
  same-named units and the client reads the repeat as a mistake (`dedupeByTitle`).
- **Budget unknown → spread the three across price points** rather than asking.
  The reaction names the budget for us (`spreadByPrice`).
- **Core criteria, the owner's hierarchy: bedrooms → area → budget.** Everything
  else (style, features, views) is secondary and only breaks ties. An ad lead
  inherits missing core criteria from the anchor villa they clicked (bedrooms
  exact-or-bigger, area widened to the parent district); the client's own words
  always override the inherited values.
- **A lead who arrives on a specific listing anchors the shortlist**: that listing
  plus comparable alternatives. The anchor is read ONLY from what the LEAD wrote —
  reading the whole conversation fed our own sent links back as "the answer".
- **Rentals are priced in rupiah, and the catalog says so** — `monthly_price_idr` /
  `yearly_price_idr`. The code originally selected only the `*_usd` columns, so the
  bot quoted dollars at clients budgeting in juta and counted rupiah-priced villas
  as having no price at all. Never convert a currency: read the rupiah column.
  The site already renders rupiah by default, so property links carry no
  `?currency` parameter (verified on a bare URL: "Rp 88M / month").
- **The lead's stated budget filters the shortlist** (`extractBudgetIdr`, +15%
  headroom). When nothing fits, the closest are offered and the reply says so
  rather than pretending the budget was met.
- **Each property link is sent as its own WhatsApp message** — glued together,
  WhatsApp only unfurls a preview banner for the first one.
- **Every edit teaches, server-side.** The correction store existed but only the
  Chrome extension wrote to it — edits from the mobile page taught nothing, which
  read as "the bot never learns". `learnFromRevision` now distils and stores the
  lesson on the `/suggest` endpoint itself, and `correctionsPromptBlock` injects
  the lessons into BOTH generation paths via `buildPromptAdditions` (they used to
  reach only the revision prompt, so fresh drafts ignored everything taught).
- **The broker signs with their display name, never the login.** A prompt rule
  said "sign off as 'HoS'" with absolute priority — fighting the owner's repeated
  correction to sign as Nick. `brokerDisplayName` (broker-identity.ts) maps
  account labels to real names; nothing reaches for the raw login anymore.
- **Earlier instructions in an editing session still stand.** Each revision pass
  saw only the newest feedback, so a name fixed in step one silently reverted in
  step two; the composer now receives the whole chain as standing instructions.
- **On the edit path the broker's instruction is LAW.** Baseline rules exist for
  the bot's own drafts; a dictated edit means the broker has seen the result and
  decided. The one-pass composer (`composeReplyWithListings`) gets the
  instruction as highest authority and decides text + links together; the code
  applies its choice without budget swaps, language overrides or dedupe on this
  path. Only facts survive as hard limits: no invented prices/demand, no URLs in
  the body, no internal codes. Named listings even disable the budget swap.
  Known ways this law has been silently broken — check for their pattern before
  adding ANY logic to the edit path: a keyword layer guessing intent between the
  command and the execution; the server inferring "hand-curated" from a link
  diff the bot's own re-pick created; a parser distorting the world (a yearly
  budget read as monthly, "3 or 4" read as exactly 4) so the bot obeyed inside
  a wrong picture. Any "я сказал X, бот сделал Y" report outranks feature work,
  and the fix is verified by replaying the broker's EXACT edit sequence.
- **An edit must move the links too, not just the words.** `/suggest` returned
  text only, so a broker dictating "these are too expensive" got a rewritten
  message with the same expensive links. The revision now feeds the matcher
  (`brokerInstruction`), and a price or area named in it outranks the lead's
  earlier words. A style-only edit ("shorter, warmer") leaves the links alone —
  `REVISION_TOUCHES_LISTINGS` decides, so a good shortlist is never churned.
- **A broker who curates the links by hand wins outright.** A revision used to
  re-pick from scratch and append their additions, so removing two listings and
  adding one came back as four. The surfaces send `attachmentsCurated` and the
  server then rewrites only the words.
- **A stated budget is enforced in code, not asked of the model.** Handed an
  affordable-first catalog it still picked villas at double the figure; told the
  broker objected to the current links it dropped even the cheapest. The ceiling
  is applied to the final shortlist, and it may not cut it below two.
- **The rental budget gate (owner's explicit exception to "never auto-close").**
  `lib/budget-filter.ts`: Rental leads whose own stated budget (or ad/scout form
  note) parses below the broker-set threshold are closed to Lost BEFORE any
  generation — "чтобы не тратить ни время, ни энергию, ни токены". Ranges take
  the upper bound, equal-to-threshold stays, no parsed budget = worked normally.
  The dial lives in the mobile 🤖 panel next to the autopilot.
- **Rental changes must not leak into Unicorn.** The sales funnel is configured
  the way the owner wants it — leave its cadence and flow alone. Anything shaped
  for Rental is gated: the ad-lead and scout seeding is `pipeline='rental'` only,
  the rupiah formatting keys off `listing_type='rent'`, the budget filter is
  rentals-only, and the follow-up clock after a reply uses each funnel's OWN
  cadence via `followupClockAfterReply` (Rental 1 day, Unicorn 1/3/5) rather than
  a flat 24h. Fixes to genuine bugs (a reply scheduling no follow-up at all, an
  invented price, a wrong-language message) do apply everywhere — those were
  never anyone's configuration.
- **Badge count and inbox must share visibility rules** (`lib/pending-visibility.ts`)
  or the number on the app icon disagrees with what the broker sees.

## Funnel stages move themselves

`lib/stage-classifier.ts` derives the stage from the conversation and it's
applied on send (`approve.ts`). Brokers no longer drag cards. Decisions the
owner made explicitly — do not change without asking:

- Moves **both forward and backward** (backward only on genuine regression, not
  a passing clarifying question).
- **`Closed - won` / `Closed - lost` are never applied automatically.** They're
  classified, flagged `terminal`, and surfaced pre-filled for the broker to
  confirm with one tap.
- Only **Rental** and **Unicorn** pipelines. Stage IDs differ per pipeline even
  when names match — they're verified against `GET /api/admin/pipelines`.
- Administrative stages (Mailing, Long-Term Cycle, TAKEN TO WORK, Неразобранное)
  are never auto-set: they describe work outside the chat.
- The manual picker in `/m` is collapsed behind "Change stage", kept for
  closes, administrative stages, and overrides.

Verified with 11 synthetic cases including the dangerous ones (silence and mild
hesitation must NOT close a deal; an explicit "we booked elsewhere" must).

## Rental conversation rules (`lib/rental-prompt.ts`)

- Offer a shortlist once **~2 criteria** are roughly known. Don't interrogate.
- **When the lead likes a specific villa, stop sending options** — confirm
  availability and propose an **in-person viewing with a concrete time slot**.
  Viewings on Bali are live; video walkthrough only if the lead says they're not
  on the island. This is also enforced in code (`shouldSkipNewListings` in
  `generate-suggestion.ts`) because the model ignored the instruction.

## Notifications

Web Push, built in this repo: `lib/push-notifications.ts`,
`routes/public/push.ts`, service worker at `routes/public-sw.ts` (`/m/sw.js`).
VAPID keys in the VPS `.env`. Notifications carry the lead's **own incoming
message** (not our draft), the lead name/id/stage, and deep-link to
`/m?lead=<id>`; the SW navigates an already-open tab so it lands on that lead.

iOS caveat: push only works for a home-screen-installed PWA, and if Safari has
recorded a denial it will not re-prompt — the site's data must be cleared.

## Working conventions

- **Other people push to `master` concurrently** (Alexander, other sessions).
  Always `git fetch` and inspect `git log HEAD..origin/master` before merging,
  and never assume the VPS working tree is clean.
- A stale branch caused real confusion once: `claude/amo-copilot-project-qt3tex`
  was cut before ~22 commits landed and re-implemented push, deep-linking and
  stage advance that already existed, with rules contradicting the owner's
  decisions. It was not merged; only its conversation auto-scroll was taken.
- **Do not run synthetic tests against live leads.** Injecting fake messages
  into lead 22962823 put invented client requirements into a real WhatsApp
  conversation. Test the prompts/classifiers standalone instead.
- Owner communicates in Russian and wants plain-language explanations of what
  broke and why, not jargon.
