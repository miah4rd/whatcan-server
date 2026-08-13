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
  ran; `v86` reconciles them, see `copilot-extension/CHANGELOG.md`.) Current: **ext93.zip (1.0.93)**.
  **As of 1.0.93, `content.js` is a thin bridge (~350 lines, was ~2600), not a
  second UI.** It only does what needs page-level amoCRM access — which lead is
  open, who's logged in, did the broker reply directly in amoCRM's own chat —
  and embeds `/m` itself in an iframe for everything else (same postMessage
  handshake shape as `/m`'s own `openPropertyPicker`, host and guest swapped).
  Every past drift bug in this project's history (a fix landing in mobile.ts
  but not content.js, or the reverse) happened because these were two separate
  implementations of the same features; from 1.0.93 on, feature/bug work lives
  in `mobile.ts` alone and reaches both surfaces the moment the page reloads —
  the extension itself should rarely need a new version.
  To release a bridge change (rare): edit files in `copilot-extension/`, bump
  `manifest.json` version + add a `CHANGELOG.md` line, rebuild the zip **with the
  files at the archive ROOT** (`zip -r extNN.zip copilot-extension/* ...` — files
  at the archive root, not inside a `copilot-extension/` folder), commit, then on
  the VPS copy it to `artifacts/landing/dist/public/` — only `dist/public` is
  actually served at `https://copilot.globalapplab.ru/extNN.zip`.
  **The extension is ALSO published to the Chrome Web Store** as "Copilot — AI
  follow-up nudges" — this is a SEPARATE upload step (Chrome Web Store Developer
  Dashboard, needs the owner's own Google account) that nothing in this repo or
  deploy process pushes to automatically. It fell 6 versions behind self-host
  once (stuck at 1.0.86 while self-host reached 1.0.92) purely because no one
  remembered to also upload there — treat a Store update as a manual step every
  release, not an assumption that self-host + Store stay in sync on their own.

- **Website assistant** — the "Add a listing" bubble logged-in brokers see on
  unicorn-property.com (a Lovable project, `bali-villa-rentals`, same Supabase
  project `yrtteclvrtqobjnpxqck` our catalog reads). Its edge function
  `broker-assistant` checks the broker's role and forwards the chat to
  `POST /api/public/broker-agent` here; see "The listing assistant has three
  surfaces" below.

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
- **A lead quoting our own link back must not un-exclude it.** The "already
  sent" list was built by scanning the whole conversation, then subtracting any
  link found in the LEAD's own messages — a real earlier fix, because an
  ad-lead's opening message names the villa they clicked, and that link is
  theirs, not ours. But quoting a link back ("is this one available?") is the
  ordinary way a listing comes up a second time on WhatsApp, and it looked
  identical to the ad-lead case: either way the ID sat in the lead's own text,
  so either way it got erased from the exclusion list. A villa already sent
  came back next message as a "similar alternative" and got re-attached as
  new — while the reply TEXT, built from the same conversation, correctly
  remembered it as sent ("of the three I sent earlier"). Text and links looked
  desynced, but the real fault was the exclusion state itself, wrong before
  either ran. Now a lead-mentioned ID is subtracted only when it does NOT also
  appear in what WE sent (`alreadySentPropertyIds`'s new `ourSentText` param).
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
- **A pure-text edit must not attach a link nobody asked for.** The
  `composeReplyWithListings` "none_this_message" branch carried a carve-out —
  attach the villa the CLIENT themselves named, "usually []" otherwise — meant
  for a lead's first message on an ad-lead villa. It fired instead on an
  ordinary mid-conversation "is this available?", attaching a link the client
  already had, on a message whose whole point was "let me check and get back
  to you" — the broker never asked for a link, only for words. His own
  description: "ссылки в своей жизни живут." Fixed: this mode now returns
  `listing_ids: []` unless the BROKER'S OWN INSTRUCTION says to send/attach/
  confirm a link — the reply text naming a villa is not itself a request to
  attach it.
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
- **A stated budget RANGE has a floor too, and one code path never read it.**
  `extractBudgetIdr` on "40-50 million" returns 50 — the ceiling, correct for
  "don't show anything over budget". The 40 was simply discarded, everywhere.
  A lead's own two-sided budget therefore filtered nothing on the low end: two
  of three slots filled with villas well under her stated floor, and a broker
  edit repeating "stay in that range" didn't move them either, because nothing
  downstream had ever been told where the range started. `extractBudgetFloorIdr`
  reads the other half (null when it's a single figure, not a range — a bare
  ceiling isn't a promise of no cheaper option) and now ranks in-range listings
  above merely-under-ceiling ones in BOTH shortlist implementations
  (`matchProperties` and `candidatesForLead` — the one the edit path's composer
  reads from).
- **A budget range's floor still has to survive contact with the AI.** Fixing
  the shortlist BUILDER to know the floor (above) wasn't enough — the edit
  path's actual attachments come from `composeReplyWithListings`, an AI call
  that picks freely, and the only code-level guard on its picks was the
  ceiling swap. A model picking a villa well under a stated "60-65 million"
  sailed straight through, since being cheap is never "over budget."
  `enforceBudgetFloor` (suggest.ts) mirrors the ceiling-swap logic for the
  low side: drop a below-floor pick only when a genuinely better in-range
  alternative exists, never below two.
- **The floor gets the same +15% headroom the ceiling gets, mirrored down
  (floor × 0.85).** A villa at 55 against a stated 60-65 range is a fair
  answer — the owner's own words were "that one's right" — a villa at 39.8 is
  not. Comparing against the floor exactly instead of with headroom stripped
  a real shortlist down to one villa on the first pass. Applied consistently
  in the ranking (`matchProperties`, `candidatesForLead`) and in
  `enforceBudgetFloor`, or the composer's candidate order and the code-level
  swap disagree about what "in range" means.
- **`areaMatches` compared a listing's area as one whole string.** Two catalog
  listings carry the sub-area AND its parent combined in one field
  ("Tumbak Bayuh, Pererenan"), which matched neither name in it — a lead
  asking for Pererenan was never shown a villa that is, in fact, in Pererenan.
  Split on the comma, match either part.
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
- **A follow-up is timed from THAT lead's own last message.** `nextFollowupDate`
  snapped every result to 23:59:59 Bali of the target day, which collapsed a
  whole day of leads onto one instant — seven follow-ups arrived "ровно в
  двенадцать". Rental sends pass `exact` so the time is literally last message
  + 24h; the day-snap remains for the funnels that were built around it.
- **A follow-up nobody wrote cannot learn anything.** Rental used to fall back
  to a hardcoded `TOUCH_TEMPLATES` variant when the broker had configured no
  script: canned text he never loaded, signed with a default name, identical
  across leads, and — since no model ran — untouched by every correction he had
  dictated. That fallback is Rental-off; the message is generated with the
  conversation, `correctionsPromptBlock`, and `brokerDisplayName`. Non-Rental
  funnels keep the templates: theirs are configured, not accidental.
- **Every message in `/m` shows its time.** Without it a thread cannot be placed
  in time and the broker cannot tell a ten-minute-old reply from a three-day-old
  one. `fmtAt` is written with no backslashes (template-literal trap).
- **The prompt is split where it stops being the same for everyone.** The Rental
  system prompt is 8,840 tokens (5,961 of them the knowledge base) and was
  re-sent in full on every draft. It is now two blocks: a cached prefix (rulebook
  + KB, 1-hour TTL) and a per-lead tail of ~67 tokens (CRM stage + the broker's
  learned lessons). The stage line HAD to move to the end — caching matches from
  the start of the prompt, so a stage name in the middle threw away the KB behind
  it. `buildRentalPromptParts` returns the two halves; `buildRentalSystemPrompt`
  still returns them joined, byte-identical, for callers that don't split.
  Anything new that varies per lead goes in the TAIL or the cache dies.
- **Both funnels' prompts are split for caching, and Sales lives in ONE file now.**
  `lib/rental-prompt.ts` and `lib/sales-prompt.ts` each expose
  `build*PromptParts` → `{prefix, tail}`. The prefix (rules + knowledge base) is
  sent as a cached block; the tail is the CRM stage plus the broker's lessons.
  The sales prompt used to be the same 16,000-character literal duplicated in
  `generate-suggestion.ts` AND `amocrm-webhook.ts`, and the copies had already
  drifted — one carried corrections, the other didn't. Never re-inline it.
  Verified character-for-character against the pre-split text before shipping.
- **The daily bill is recorded, not estimated.** `ai_usage` gets a row per API
  call with its cost already worked out (`PRICE_PER_MTOK` in ai-client.ts) and a
  `label` saying what it was for. `GET /api/public/ai-spend` totals it by day in
  Bali time plus today by purpose. Give every new AI call a label — unlabelled
  ones land in "other" and the breakdown stops being useful. Note the API path:
  public routes are mounted at **/api/public/**, not /api/.
- **The property matcher CANNOT be cached — don't try again.** Its static rules
  are 557 tokens, below Anthropic's 1024-token minimum, so a cache_control there
  silently does nothing while still costing the write premium. The catalog is the
  expensive part (up to 5,389 tokens) and it is filtered per lead by design
  (bedrooms, budget, area, dedupe), so it is never byte-identical twice. Sending
  the whole catalog uncached to make it cacheable would move budget enforcement
  from code back into the prompt — the thing "A stated budget is enforced in
  code, not asked of the model" exists to prevent.
- **The knowledge base is a SALES guide — Rental gets only the part that applies.**
  It talks about developers, leasehold, ROI, resale and buyer objections, and it
  was pasted whole into every rental draft: a client asking about a villa for
  three months was answered by a bot holding 6,000 tokens of investment material.
  `filterKnowledgeBaseForRental` keeps tone of voice, message endings, the Bali
  area map, the do-not list and the mission (8,840 tok → 4,188), and strips any
  surviving line about buying. It DERIVES from the stored text, so the broker's
  own edits still reach rental — do not fork it into a second copy. Sales keeps
  the full guide.
- **A version bump must never overwrite a knowledge base the broker edited.**
  `ensureKnowledgeBaseVersion` used to replace it unconditionally, so a deploy
  silently destroyed his wording. It now installs the new default only when the
  stored text is still the untouched old one.
- **Every AI call logs what it cost** (`ai usage` in `ai-client.ts`: input, output,
  cache read, cache write). Before this, "the tokens are burning fast" could only
  be answered by guesswork. Check a cache hit with
  `pm2 logs whatcan --nostream | grep "ai usage"` — `cacheRead` should be ~8,835
  on the main generation.
- **Sonnet writes what a client reads; nothing else.** Objection labelling,
  follow-up timing, and the is-this-lead-alive check are Haiku (`HELPER_MODEL`).
  The owner's rule is "оставь соннет" for client-facing text — that is the line,
  not a blanket ban on cheaper models.
- **A send is a 10-15 second request, and a restart used to cut it in half.**
  Approving writes the amoCRM field, triggers Salesbot, then paces the property
  links out one message at a time. The delivery was recorded in `sent_messages`
  only at the END of that request — and that row is exactly what the retry guard
  reads to answer "did this already go out?". A `pm2 restart` (i.e. any deploy)
  landing in the gap left no trace of a message the client already had, so the
  broker's retry delivered the whole thing a second time; all they saw was a
  bare "Webhook 502". Now: the row is written the instant the text leaves and
  carries `links k/n` as each link lands, so a retry resumes with the missing
  links and never replays the text; `index.ts` drains in-flight requests on
  SIGINT/SIGTERM (and on an uncaught exception) with PM2's `kill_timeout` at
  25s to allow it; a stray unhandled rejection is logged, not fatal. Never move
  the delivery record back behind the attachment loop.
- **The stage-change block must not erase the follow-up clock a send just set.**
  Approving a reply sets `nextFollowupAt`; the stage block in the SAME request
  used to write `nextFollowupAt: null` unconditionally. While auto-stage was off
  this was rare, but once the classifier began applying "Options sent" on nearly
  every send (2026-08-06), nearly every answered lead lost its chase and went
  silent forever — the "answered → nothing scheduled" bug kept "returning"
  because each fix set the clock and this block kept wiping it a second later.
  It now clears the clock only on a stage-only move (skipMessage) or a move to
  a dead stage (`shouldSuppressPush`). Many places null this clock on purpose
  (whitelist misses, bot-excluded, relevance-rejected, task-driven warmup,
  Rental Listings) — do NOT add a blanket "repair" pass that re-sets it; that
  exact loop is warned about in followup-scheduler.ts.
- **Badge count and inbox must share visibility rules** (`lib/pending-visibility.ts`)
  or the number on the app icon disagrees with what the broker sees.

## The listing assistant has three surfaces, one implementation

Adding a listing is a conversation, not a form (`lib/listing-intake.ts`). It is
reached from the review queue at `/listings`, from the intake chat in `/m`, and
from the "Add a listing" bubble on the website. They share
`runListingIntakeTurn` and, since the website was connected,
`lib/listing-publish.ts` — one submission row, one completeness check, one
Supabase insert, one cache invalidation. Do not add a fourth copy.

- **The website surface has no listing card.** `/m` shows the fields filling in
  beside the chat and a Publish button; the site has only the reply text. So the
  `noCard` surface flag tells the model to recap the listing in words, in the
  broker's own language, and ask for confirmation itself — and never to claim
  the listing is published, because only the server knows that.
- **"Publish" is decided by a model, not by keywords.** `да, только цену
  поменяй на 90` starts with "да" and is not an approval. `classifyPublishIntent`
  (Haiku) is asked only once the draft is complete and the recap has been shown,
  and it fails CLOSED — a failed check costs one more confirmation round, a
  failed-open check publishes a villa to a live website on a maybe.
- **The property code is resolved again at publish time.** The code in the recap
  is a proposal; minutes may pass before the broker answers, and another broker
  may take it. `publishListingDraft(propertyId: "auto")` picks the next free code
  and steps past a collision, reusing the same submission row.
- **Photos arrive as signed URLs into a private bucket and expire in a week.**
  The bytes are copied into our own `uploads/` and it is our permanent URL that
  reaches the `properties` row — a signed URL there would 404 for a client a
  month later. Only the site's own Supabase host may be fetched
  (`BROKER_AGENT_ATTACHMENT_HOSTS` widens it); the URL comes from a browser.
- **Session state is in `broker_agent_sessions`, not memory.** The browser
  re-sends the transcript on every turn but NOT the draft, and never re-sends a
  photo it already uploaded — a `pm2 restart` mid-conversation would publish the
  villa with no pictures.
- **Two secrets, both required.** `BROKER_AGENT_WEBHOOK_SECRET` in the VPS `.env`
  and the same value in the site's Supabase secrets, alongside
  `BROKER_AGENT_WEBHOOK_URL`. With no secret configured the endpoint answers 503
  rather than serving whoever finds the URL: a request that reaches it can
  publish to the live catalog.
- **Publishing needs `SUPABASE_SERVICE_ROLE_KEY` on the VPS.** The anon key is
  read-only by RLS design. Without it every publish — from any of the three
  surfaces — fails with "not set on the server", which is what it did from the
  day the /m intake chat shipped until someone checked.
- **Seeing the bubble requires an `admin`/`agent` row in the site's
  `user_roles`.** The brokers work in amoCRM and mostly have no account on the
  site at all, so this feature reaches only the people who have been granted a
  role — the same shape of gap as push notifications reaching 2 brokers of 12.

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

**A per-device feature still needs a product-level enrolment path — this is not
a technical excuse.** Push reached 2 brokers out of 12 for a month. The
constraint is real (a subscription is minted by the broker's own browser after
they grant permission; no server call can do it for them), but the failure was
ours: it was opt-in behind a small bell, and the bell was rendered only when
`!EMBEDDED` — invisible inside the extension, which is exactly where the rental
brokers work. Nothing anywhere showed the other ten were dark, so "notifications
are on" and "this broker has been unreachable since July" looked identical, and
the owner was expected to remember per person. Now: `/m` re-subscribes silently
on every load when permission is already granted (`syncPushSubscription`, which
also repairs a rotated endpoint — invisible before, and permanently silent), a
banner states plainly when it is off instead of leaving an unreachable broker
looking like an idle one, and `GET /api/public/push/coverage` answers "who is
dark" for the 🤖 panel and the team report. Anything else that must be switched
on per person gets the same three parts: enrol automatically where possible, say
so loudly where not, and expose coverage — never a switch someone has to
remember to flip for each broker.

## Reports (discipline, not dashboards)

`lib/daily-report.ts` → `GET /api/public/report` (one broker) and
`/report/team` (everyone, admin view), rendered in the **Report tab of `/m`**
with Day / Week / Month, and pushed at **08:00 Bali** by
`lib/report-scheduler.ts`. `POST /api/admin/send-daily-report?broker=x` fires it
on demand; with `?broker` it does not mark the day done, so a test send never
swallows the real one.

- **The report is a to-do list, not statistics.** What the broker is SITTING ON
  comes first and is the only thing the push says — waiting / waiting over a day
  / overdue follow-ups / warm going cold. A morning message of percentages gets
  swiped away; "12 clients are waiting" gets worked. Activity and outcomes sit
  underneath, and the previous-period comparison exists only on week and month,
  where a trend is real rather than noise.
- **Days are Bali days** (`(ts AT TIME ZONE 'Asia/Makassar')::date`) — a
  broker's "yesterday" is the day they worked.
- **Closed and bot-excluded leads are never counted as work owed.** A report
  that bills dead leads is believed exactly once.
- **Median reply time reads LIVE drafts only.** A scheduled follow-up's draft is
  queued ahead of its send time, so including it measures the schedule, not the
  broker (it dragged Amelia's median to 3.9 days when the live figure was 3h).
- Stage vocabularies differ per funnel (`STAGE_ORDER`), and Rental Listings runs
  the opposite way round; a stage in neither list is ignored rather than guessed
  at, so an administrative move never reads as progress.
- **Known gap the report cannot paper over:** the Rental funnel has no viewing
  stage, so `viewings` is structurally 0 there. The main step of a rental deal
  is unmeasurable until "Viewing Scheduled"/"Viewing Done" exist in amoCRM
  (Alexander's side). Do not fake it from message text.

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
