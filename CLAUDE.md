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
- **A lead who arrives on a specific listing gets an answer about THAT listing.**
  The anchor is read ONLY from what the LEAD wrote — reading the whole
  conversation fed our own sent links back as "the answer". It used to return
  the anchor PLUS "comparable alternatives", and on an ad lead that reads as not
  listening: "Hi! I saw your ad for R-YUD-038 — 3BR near Seseh Beach, Rp 79.2
  million/month" came back with three options — the villa asked about, a 2BR at
  Rp 28.6M and a 3BR in Balangan. ±1 bedroom is allowed, the ad template arrived
  with the budget line still blank, so with nothing to filter on the rest of the
  order fell to whatever ranks well (804 views won) — a different size at the
  opposite end of the island. Now the anchor is returned ALONE unless we must
  move them off it: over a stated budget (the DOUBLE CHECK) or not offerable.
  This is the deliberate exception to "always 2-3 listings, never one".
  The text is written concurrently with the matching, so the writer is told
  separately that the client came in on one villa — otherwise it still opens
  "Here are a few options for you:" over a single link.
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
- **We serve the property link's preview ourselves** (`routes/property-share.ts`).
  Links used to point straight at the public site, and the site is a
  client-rendered SPA: a crawler asking for any `/property/<ID>` gets the same
  `index.html`, so WhatsApp read ONE generic Open Graph block for every villa —
  verified against three listings, identical `og:title` ("Unicorn Property Bali
  — Trusted Real Estate Agency") and identical `og:image`. Sending each link as
  its own message therefore produced three identical grey banners with no villa
  name, no price and no photo, which is a large part of why 24 of Amelia's 44
  rental leads never replied at all. Our route renders the real title, price
  (via the shared `priceLabel`, so the card and the catalog can never quote
  different money) and first photo, then hops the human to
  `unicorn-properties.com`. Two things must not be "cleaned up": the path stays
  **`/property/<ID>`** — that exact shape is what ~20 regexes read back out of
  conversation text to know which listings a lead has already seen, and only the
  HOST moved; and the page answers **200 with a client-side hop, never a 3xx** —
  a crawler follows a redirect straight back to the SPA's generic tags.
  `og:image` points at our own `/property/<ID>/preview` because every photo in
  the storage bucket is served as `application/octet-stream` and a crawler may
  refuse an og:image that does not declare itself an image.
  The link host is `PUBLIC_BASE_URL` (falls back to copilot.globalapplab.ru).
  Pointing a branded subdomain at this route is a DNS change, not a code one.
- **Every edit teaches, server-side.** The correction store existed but only the
  Chrome extension wrote to it — edits from the mobile page taught nothing, which
  read as "the bot never learns". `learnFromRevision` now distils and stores the
  lesson on the `/suggest` endpoint itself, and `correctionsPromptBlock` injects
  the lessons into BOTH generation paths via `buildPromptAdditions` (they used to
  reach only the revision prompt, so fresh drafts ignored everything taught).
- **A lesson the broker reversed must stop applying, or the window can't widen.**
  `correctionsPromptBlock` used the newest **8** lessons. Amelia had taught 242,
  so anything older than roughly two days silently stopped being honoured and she
  had to teach it again — which is what "бот не учится" actually meant. Simply
  widening the window makes it worse, because the store had accumulated direct
  reversals: she taught "Avoid using the word 'proactive'" and "Use proactive
  language" on the SAME day and both were live. So the window is 30 AND a new
  lesson retires the earlier ones it contradicts (`retireContradicted`, one
  cheap Haiku call on write, deliberately conservative — a false positive erases
  a preference the broker still holds). Rows are marked `superseded_at`, never
  deleted. The backlog taught before any of this existed was cleaned once via
  `POST /api/admin/corrections/dedupe` (supports `?broker=` and `?dry=1`);
  newest always wins. Anything that widens this window again has to keep the
  invariant: what survives must be followable all at once.
- **A lesson belongs to the MOMENT it was taught in, and the owner's end state
  is per-situation autopilot.** His words: the broker should eventually stop
  editing entirely — the bot must know "к какому лиду, в каком случае, при
  какой ситуации, что реально нужно отправлять". A flat lesson list cannot get
  there: "skip qualification, go straight to action items" was taught on an
  owner conversation and is wrong on a first client contact. So: lessons carry
  a `situation` tag (SITUATIONS in broker-corrections.ts + `style` for
  universal tone rules), assigned in the SAME Haiku call that distils the
  lesson (zero extra spend); `deriveSituation()` reconstructs the current
  moment deterministically (zero AI calls) and `correctionsPromptBlock(broker,
  situation)` injects only this moment's lessons plus style. ALL reads go
  through that one selector — two raw queries (suggest.ts,
  followup-scheduler.ts) had kept leaking retired lessons and double-injecting.
  The backlog was tagged once via `POST /api/admin/corrections/classify`.
  Progress toward autopilot is measured, not felt:
  `GET /api/public/autopilot-readiness?broker=X&pipeline=Y` scores each
  situation (share of drafts sent untouched, 14d vs prev) — pure SQL over
  pending_suggestions, its situation CASE must stay in step with
  `deriveSituation`. First real reading: Amelia followup 92% clean (ready),
  options 50% (learning); Yudi owner_intake 79% (close). Turning any
  situation to auto-send stays the OWNER's decision — the endpoint reports,
  it never flips anything.
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
- **A manual WhatsApp reply must move the amoCRM TASK, not just the clock.**
  The open task is the scheduling source of truth — `syncTaskSchedule` reads it
  back into `nextFollowupAt` every 5 minutes, so resetting only the clock is
  undone within one cycle. A broker answering a client by hand was detected by
  the timeline sweep, which reset only the clock; the still-open overdue task
  re-pinned the lead "Overdue Nd" forever, and Amelia read it as "the bot
  doesn't see my WhatsApp replies" (2026-08-18). The webhook's
  brokerRepliedFresh block does the full job when it fires, but it does not
  always fire, and `syncOutgoingEvents` (v4 events) has returned ZERO outgoing
  events since at least 2026-07-24 — the 30-minute timeline sweep is the only
  guaranteed detector of a manual reply. It now calls
  `reconcileTasksAfterManualReply` (manual-reply-followup.ts): an open FUTURE
  task means the reply was already handled (webhook/approve/broker's own plan)
  — close only stale tasks and stop; otherwise close the stale tasks and chase
  from the reply. Bot-sent messages never enter this path — approve.ts manages
  their tasks, sometimes on an adaptive cadence a flat reschedule would break.
  Backlog was cleared once via `POST /api/admin/repair-manual-reply-overdue`
  (`?dry=1` to preview). Anything new that schedules or unschedules a chase
  must decide against the TASK, not the clock.
- **An open FUTURE task is not proof the reply was handled.** The first version
  of the rule above skipped any lead that had one — which broke the ordinary
  GOOD case: a broker answering within the 24h the previous send scheduled
  leaves that send's chase task sitting minutes ahead of the reply, so it came
  due right after and pinned the lead "Overdue" with the client already
  answered (Larissalara / 23213079: answered 12:59, task due 13:28, overdue
  four days — Amelia photographed it). A task is judged by its amoCRM
  `created_at`: made BEFORE the reply, it cannot reflect it (fallback: due
  sooner than the reply's own cadence). Only tasks THIS system wrote qualify —
  `OUR_TASK_TEXT` in manual-reply-followup.ts — because a task a human wrote is
  their plan and outranks ours. The repair sweep uses the matching SQL: a clock
  closer than 20h to our last reply was set by an earlier send, not by that
  reply. Add every new bot-written task text to `OUR_TASK_TEXT` or that task
  becomes unrecognisable and pins its lead the same way.
- **One bad filter value 400s the WHOLE amoCRM events request.**
  `syncOutgoingEvents` asked for `outgoing_lead_message` AND
  `outgoing_chat_message`. The first is not a valid type on this account, so
  amoCRM answered 400 to every call and the detector found nothing for weeks —
  which is why a broker's manual WhatsApp reply depended entirely on the
  30-minute timeline sweep. Verified live 2026-08-18: both types 400, lead-only
  400, chat-only 200 with real events. It is now chat-only and reconciles the
  TASK as well as the clock (mode "repair" — this feed cannot tell a Salesbot
  send from a human's, so it never moves a stage). A silent zero from an amoCRM
  filter means "check the status code", not "there is nothing there".
- **A lone surrogate kills the whole AI request.** WhatsApp text arrives through
  amoCRM with half an emoji in it; that cannot be encoded as JSON, so the
  Anthropic call fails with 400 "invalid high surrogate in string" and the lead
  gets NO draft at all while the log shows only an API error (23258097).
  `stripLoneSurrogates` in ai-client.ts cleans every string in the body —
  complete emoji PAIRS must survive, only orphan halves go.
- **The scout creates duplicate leads, and the same phone must never be
  messaged twice.** Two leads with two DIFFERENT contact ids can carry the same
  phone: Larissalara (+4917662830225 → 23213079 / 23213261) and Anna Shahumyan
  (+48535010821 → 23213075 / 23213145) were each seeded twice on 2026-08-13 and
  each received two different opening messages about a minute apart. Contact id
  is NOT a dedupe key here; the normalised phone is. `sourced-lead-outreach.ts`
  already resolves the contact — anything that sends a first-touch message must
  check the phone before sending, and say so in the log rather than skipping
  silently.
- **Everything the broker reads is ENGLISH, and the recogniser must stay
  bilingual.** The brokers work in English, but every task the bot wrote into
  amoCRM was Russian ("Отправлено (push): …", "Ожидать ответа клиента",
  "Закрыто автоматически"), and the morning report mixed Russian promise
  reminders ("уточнить цену у хозяина") into an English page — the owner saw
  both on one screen (2026-08-19). Task texts, the commitment `promiseText`
  prompt, and the auto-close result are English now. The trap: `OUR_TASK_TEXT`
  in manual-reply-followup.ts decides whether a task is OURS, and 212 tasks
  with the old Russian wording were still open on the day of the change —
  deleting those patterns would have turned each into "a human's plan" and
  re-pinned every one of their leads. Keep both languages until no open task
  uses the old wording. Stored rows were translated once by hand
  (`lead_commitments.promise_text`).
- **A lead's display name is cleaned in ONE place** (`cleanLeadName`,
  lead-display-name.ts). amoCRM appends "(клиент - …)" and the old stripper
  `/\s*\([^)]*\)\s*$/` could not survive a name that already contains
  brackets — "刘豪 (Liu Hao) (клиент - 刘豪 (Liu Hao))" reached the morning
  report verbatim, because `[^)]*` stops at the inner ")". Cut from the suffix
  marker instead. The report and the inbox card each had their own copy of that
  regex; that is how they drifted.
- **Badge count and inbox must share visibility rules** (`lib/pending-visibility.ts`)
  or the number on the app icon disagrees with what the broker sees.
- **A notification that reached nobody is not a notification.** The broker's own
  promise to a client ("I'll check with the owner and get back to you") is
  detected and scheduled correctly — but the reminder was a push and ONLY a
  push, and `notifiedAt` was stamped whether or not anything was delivered. Most
  brokers have no subscription, so their promises were marked handled the moment
  they came due, once, forever. That is how a rental client who had stated a 50
  million budget and asked to move in immediately sat seven days behind "I'll
  get back to you shortly with a few options" — detected, scheduled, fired,
  received by no one. Now `sendPushToBroker` returns how many devices took it,
  `processCommitmentReminders` stamps only on real delivery and retries for 3
  days, and the report carries `openPromises` (`stateNow`) so the surface does
  not depend on push at all — it leads the headline, above waiting clients,
  because a promised client is not merely unanswered. Any new "we owe this
  broker a nudge" feature gets the same two halves: a delivery that knows
  whether it landed, and a surface that works when it didn't.

## The paid ad lead is answered in seconds, and its silence is read in 15 minutes

The opening on a Meta ad lead is an auto-welcome that sits OUTSIDE the count,
then the broker's first message. The owner decided the shape (2026-08-19) and
the naming (2026-08-21) — see "the numbering is not cosmetic" below.
`lib/ad-lead-autoreply.ts`:

- **The auto-welcome — outside the count, automatic.** Greeting + the villa they
  clicked + their own request read back + one question, sent the moment the lead
  is seeded, with no broker tap. This is the
  ONLY message in the system that reaches a client unattended, which is why it
  is a template and not a model call: nothing that sends itself may be capable
  of inventing a price or a date. Kill switch: `broker_settings.ad_auto_welcome`
  = `off`. The text goes first and the link follows as its own message — a bare
  link as the first thing from an unknown number is what spam looks like to
  WhatsApp, and only a lone link unfurls a preview.
- **The welcome does not re-ask what the form already asked.** Every ad lead now
  answers the qualifying questions before reaching us, and the closing line used
  to be "is this the villa you had in mind, or would you like something
  different — another area, size or budget?" — put to someone who had just
  finished typing exactly that. It reads as proof nobody looked. The answers are
  on the card in plain English the moment the welcome fires (lead 23365161:
  "3BR", "Seseh", "Rp 30–50 million/month", "3–6 months", "Big garden"), so the
  line is read, not inferred. It stays a QUESTION on purpose — an opening that
  ends in a full stop gives a stranger no reason to reply, and the owner's point
  (2026-08-26) is that a question is how you start a conversation, not how you
  verify a fact. What changed is what it asks FOR: not the request again, but
  the next thing they need — more villas to compare, since nobody rents the
  first place they see.
- **What the client reads back is quoted VERBATIM from the card, never from the
  parsed criteria.** `getLeadCardCriteria` returns both: parsed values for
  filtering and `answers` as untouched strings. Parsing flattens "Rp 30–50
  million/month" to its 50000000 ceiling — correct for a shortlist filter, wrong
  in the client's own mouth, because quoting their "30–50" back as "50" says we
  misread the one thing they took the trouble to fill in. A field we cannot
  repeat word for word is left out: a gap the form left belongs to the broker's
  message 15 minutes later, which a human approves. No answers at all on the
  card means we genuinely do not know the request, and the old open question is
  the honest thing to send.
- **The broker's FIRST message — 15 minutes of silence, ordinary Copilot path.**
  Bot drafts, broker approves. Kind `live`, never `push`: it is still the
  opening conversation, so it must not count as a chase in the report or burn a
  follow-up level. The 24h clock then counts from whatever the broker actually
  sends. It carries its own `taskBrief` instead of the qualifying ladder — see
  below.
- **The numbering is not cosmetic.** While this was called "touch 2" it behaved
  like a second message: it fell through to the ladder in `generate-suggestion.ts`,
  which picks its question by counting lead messages. A seeded enquiry is
  exactly one, so every draft opened with "when would you be looking to move
  in?" — the thing the Meta form had already asked. The auto-welcome is a
  brochure, not a turn in the conversation; the 15-minute draft is the FIRST
  thing a broker says. `generateSuggestion` takes `taskBrief` for exactly this:
  a caller whose message opens a conversation rather than continuing one.
- **The form answers are the request; work from them, not from the click.** The
  brief leads with fitting options when the request is known, and when it is
  not, asks only for what a shortlist needs — stating why — rather than a bare
  move-in question that hands the client work and gives nothing back.
- **A client who answers inside the 15 minutes cancels the broker opening entirely** — they
  become a normal LIVE lead answering on their own words. Reacting to silence is
  the whole point; talking over a client who just replied would undo it.
- **The Meta form answers are the request; the clicked villa is only a signal.**
  The seeded enquiry used to be a ternary — a listing code in the lead name made
  it the bare link and threw the note away, and nothing in the generation path
  reads `leadNotes`. A qualified lead was answered as if they had said only "I
  like this villa". Both halves go into the seeded message now.
- **`describePropertiesByIds().label` is for the MATCHER, not for a client.** It
  carries the purpose tag and the view count; use `clientLabel` in anything a
  person reads, or the welcome opens with "(rent), 804 views".
- **The phone, not the contact id, is the dedupe key** — the ad forms and the
  scout both create duplicate cards for one number. A failed phone lookup skips
  the send rather than risking a second opening message.
- **A DRAFT on a duplicate card is its own bug, not a lesser one.** The phone
  dedupe lived privately inside ad-lead-autoreply.ts, so it guarded only the
  automatic welcome and the scout path had nothing. The scout re-found Yuliia's
  FB post on its 26.08 sweep; amoCRM saw an unrelated contact (new id, and the
  same name in a different alphabet — "Yuliia Nikonenko" 25.08 / "Юлія
  Ніконенко" 26.08), so lead 23365147 was seeded from the 465-byte scout note
  and drafted a cold "so to confirm, you're after a 3-4BR villa" — while on
  23353083 that same person sat at "viewing Suggested" with 3101 bytes of
  conversation, having just agreed to a Sunday viewing. Amelia reported it as
  the bot no longer processing the conversation, and she was right to: a draft
  is not harmless because a human still has to tap it, since it presents itself
  in the inbox as the current state of that client. Everything phone-shaped now
  lives in `lib/phone-dedupe.ts`, and anything that OPENS a conversation asks
  `phoneIsAlreadyInConversation` first. That guard is deliberately wider than
  the send guard (any open sibling we have spoken on, not just one that
  received a message), ignores CLOSED siblings (a fresh request months later is
  a real enquiry), and fails OPEN where the send guard fails closed — refusing
  to send twice costs nothing, refusing to seed drops real leads on an amoCRM
  hiccup.

**There is now ONE send path** (`lib/outbound-send.ts`): channel guards,
delivery record, link pacing. `approve.ts` and the auto-welcome both go through
it. Do not grow a second one — every drift bug in this project's history is two
implementations of the same behaviour.

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
- **Rental's funnel was restructured on 2026-08-18** (owner's decision):
  Options sent → **Viewing scheduled** → **Viewing done** → Negotiation done →
  Contract signed → CHECK IN (INVENTORY). The split is the whole point of it —
  "scheduled" is a commitment that has not happened yet, "done" is a client who
  has already stood in the villa, and the two conversion rates they produce
  (does the shortlist work? / does the broker execute?) need opposite fixes.
  Before it, 50 of 53 rental leads sat in Options sent with nowhere else to go.
  Three places had to learn the new names and any future rename must visit the
  same three: `STAGE_MEANINGS` in stage-classifier.ts (a single `/viewing/` rule
  gave BOTH stages the identical description, so the model chose between them at
  random), `STAGE_ORDER` in daily-report.ts (exact name match — the OLD names
  stay in the list beside the new ones, or every week/month comparison loses its
  history), and `WORKFLOW_STAGE_PATTERNS`. Note Rental's `need assessed` means
  "the first outreach was sent", NOT "requirements are known" — it has its own
  meaning override in the classifier and is deliberately NOT mapped to the
  `needs_assessed` routing group.
- **CHECK IN (INVENTORY) is never auto-set, and never chased — but never hidden
  either.** Keys and an inventory walk happen off WhatsApp, so the chat can't be
  evidence they occurred; the broker sets it. It suppresses proactive follow-up
  (a signed tenant does not want "any thoughts on the options?") while still
  surfacing the client's OWN incoming messages in LIVE via `isPostSigningStage`
  — a tenant moving in writes a lot. Same shape as the Closed-won exception in
  `pending-visibility.ts`; anything else added to `PUSH_SUPPRESSED_RAW` that is
  a live human rather than a dead lead needs that exception too.
- **A stage id MOVES a lead between funnels — there is no "set the stage but
  stay put".** Status ids are unique per funnel, so writing one from the wrong
  funnel relocates the card. Lead 23290763 came in on UNICORN, the owner moved
  it to Rental by hand, and our row kept UNICORN's `Contact established`
  (68024554) while the stage NAME and `pipeline` had both moved to Rental —
  every sync path writes `leadStageId: id ?? undefined`, and in drizzle
  `undefined` means "keep the old value". The mobile card falls back to the
  stored id on approve (`stageIdForName(...) || item.lead_stage_id`), so each
  message the broker sent dragged the card back into sales. `safeStageIdForLead`
  (stage-classifier.ts) now validates the id against the funnel **amoCRM** says
  the lead is in — never our own `pipeline` column, which is exactly what lags
  when a human moves a card — resolves by stage name inside the right funnel,
  and refuses to move the card when that stage does not exist there. Anything
  new that calls `updateLeadStatus` goes through it. `routes/admin/bulk-import.ts`
  still writes stored ids straight through and would relocate every lead whose
  id is stale: it is a manual admin tool, do not run it before it is converted.
- A backlog that predates a funnel change is moved once with
  `POST /api/admin/reclassify-stages?pipeline=rental` — it re-reads each open
  conversation and puts the card where it actually is. **Dry by default**
  (`?apply=1` to write), unlike the other repair endpoints, because this one
  moves cards in the owner's live CRM and can trigger amoCRM's own automations.
  Terminal stages are skipped in bulk too.
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

- **A rental is booked in time, not just in space.** The catalog query read
  `properties` alone, so the bot had no idea a villa was taken and offered leads
  villas rented until August 2027 (R-YUD-033/034/037, sent 14-18 Aug 2026). The
  website hides those, but that is a front-end filter — the database still hands
  every non-draft villa to anyone reading it, and the bot reads the database.
  The brokers' model (Yudi): a villa is either free, or free from a date; within
  ~3 months that is a real option, beyond it it is effectively rented.
  `applyAvailability` (property-catalog.ts) joins `property_availability` onto
  EVERY catalog read — one function, so matching, stock checks, price lookup and
  area vocabulary all inherit it — and stamps each villa with `free_from`, which
  `toPick` puts on the label the writer sees. It does NOT drop them: the site
  shows every listing now and marks the far-out ones red instead of hiding them,
  so a lead can be looking at one and ask about it, and a catalog that had
  deleted the row could not even say when it frees up. `offerableNow` decides
  offerability instead, applied where it matters — both shortlist pools
  (`candidatesForLead`, `matchProperties`) and the stock check. The rule itself lives in the RENTAL rulebook (cached prefix), not
  in `buildPromptAdditions`: sale listings have no availability calendar, and the
  tail is re-sent uncached on every draft. A calendar that fails to load is
  treated as "everything free" — a villa wrongly offered is a bad day, an empty
  shortlist is a broker with nothing to send at all.

## Notifications

Web Push, built in this repo: `lib/push-notifications.ts`,
`routes/public/push.ts`, service worker at `routes/public-sw.ts` (`/m/sw.js`).
VAPID keys in the VPS `.env`. Notifications carry the lead's **own incoming
message** (not our draft), the lead name/id/stage, and deep-link to
`/m?lead=<id>`; the SW navigates an already-open tab so it lands on that lead.

**A notification never quotes our own draft.** LIVE carries the lead's incoming
message; a follow-up has no incoming message, so it states the JOB
(`followupNoticeBody` — "Follow-up ready to send — quiet for 3 days"). Shipping
the draft text as the body made the broker's phone look like the client had
written it: Amelia flagged it the same morning ("it's not a message from the
client, it's a suggestion for me"). Anything new that notifies gets the same
test — would the broker read this body as coming FROM the lead?

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

## The bot going silent must be noticed by someone

`lib/ai-health.ts` + `lib/ai-watchdog.ts`, alarm surface `GET /api/public/ai-health`.

On 2026-08-20 the Anthropic credit balance ran out and generation stopped for
about two hours: 38 leads got no draft. Every call threw, every caller logged
its own error, and **nothing anywhere added them up** — so a broken bot and a
quiet morning looked identical, and it was found only because someone read the
logs by hand. The brokers just saw a slow day.

- **Silence is not a fault.** An outage is failures piling up while nothing
  succeeds (3+ in 15 min with no success in that window). At 04:00 nobody is
  writing to us and there is genuinely nothing wrong, so a no-traffic period
  must never alarm. Equally, failures AFTER a recent success do not alarm — the
  bot is partly working, and crying wolf is how alarms get ignored.
- **The alert names the FIX, not the symptom.** An empty balance and a rejected
  key are different mornings; "AI is down" makes the owner go and work out which
  one it is. `classifyAiFailure` splits credit / auth / rate_limit / overloaded.
- **It goes to the owner, not to every broker.** A rental agent told to "add
  funds in the Anthropic Console" has an alarm she cannot act on. `HoS,Admin`,
  overridable with `AI_ALERT_BROKERS`; if none of them is reachable it falls
  back to everyone with push, because noisy beats invisible.
- **Both halves, same as the commitment reminders:** a delivery that knows
  whether it landed (`sendPushToBroker` returns a device count; zero is logged
  as an error) and a surface that works when it didn't. The endpoint reads
  memory, not the database — an outage is exactly when the status page must not
  need more moving parts.
- **`POST /api/admin/test-ai-alert` fires the real alert through the real path**
  and reports the device count. Without it the alarm's first ever run would be
  during an outage. Verified 2026-08-20: delivered to 3 devices across hos and
  admin. Re-run it after any change to push or to the recipient list.
- State is in memory on purpose: it answers "is it working RIGHT NOW", which a
  restart cannot make stale. A restart mid-outage re-alerts once — deliberate.
- Logic is covered by a standalone test (17 checks, including the exact error
  text Anthropic returned that day). Bundle it with
  `npx esbuild <file> --bundle --platform=node --format=cjs --packages=external`
  — the default ESM bundle dies on pino's `require("node:os")`.

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
- **A stage event without its pipeline is unreadable.** `stageIndex` resolves a
  funnel's stage ORDER by pipeline name, so a null pipeline scored every move as
  "not progress": `advanced` and `listingsTaken` read **0 for every broker in
  every period** while `stage_events` held 54 "New LEAD → Options sent" moves and
  Yudi had 10 listings in TAKEN TO WORK. Every row in the table was null, because
  the caller of `/api/amocrm/sync-stage` does not always send one. The write path
  now falls back to the lead's own `leads_sync.pipeline`, and existing rows are
  backfilled on boot. `lost` and `viewings` hid the bug — they match on the stage
  NAME and never needed the pipeline, so the report looked alive.
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
- **Answer the owner in English** (he asked for it explicitly on 2026-08-18; this
  line used to say Russian). He still wants plain-language explanations of what
  broke and why, not jargon.
