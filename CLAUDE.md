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
ssh whatcan /opt/whatcan/deploy.sh
```

`deploy.sh` merges, builds, checks that `dist/index.mjs` exists, restarts PM2
**only if the build succeeded**, and prints `deployed: api HTTP 200, pm2 online`.
Anything else is not a deploy. It exists because a hand-typed chain with the
build piped through `tail` masked a build failure on 2026-09-05; a failed esbuild
leaves NO bundle, so the PM2 restart that followed was a crash loop — the whole
API down for ~15 minutes, 202 restarts, webhooks refused. Never write
`pnpm run build | tail` in a `&&` chain; never restart PM2 without a green build.

- `pm2 restart whatcan` does **not** reload env vars. You must reference the
  **file** (`ecosystem.config.cjs`) — it reads `.env` via a custom loader
  because PM2's native `env_file` didn't work.
- `pnpm run build` is esbuild and does **not** type-check. `pnpm run typecheck`
  has pre-existing failures in files nobody touched — check only the files you
  changed. The honest gate is `scripts/typecheck-worktree.sh`, run ON THE
  SERVER between the push and `deploy.sh`: it checks out `github/master` into
  `/tmp/tc`, links prod's `node_modules` (with `@workspace/*` pointing at the
  worktree's own `lib/*`), builds `lib/db` first, and exits 1 only for errors
  in files the push changes — the ~10 baseline errors elsewhere are listed, not
  counted.
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
3. **`lib/generate-suggestion.ts`** writes the reply. Since 2026-09-04 the
   villas are picked FIRST and the writer is handed the exact attached list
   (`attachedVillasBlock`); the few seconds this costs were the owner's
   explicit trade for text and links that agree.
4. **`queueSuggestion`** (in `amocrm-webhook.ts`) persists to
   `pending_suggestions`, fires the push notification, **then** classifies the
   stage in the background (deliberately after the notification).
5. **`routes/public/approve.ts`** sends via amoCRM Salesbot (bot 22127, writes
   the text into custom field 965907), applies the stage, creates the CRM task.

## Video-tour compressor (2026-09-05)

`lib/video-compress.ts`, started from `app.ts`. Every 60 s it reads the
site's `properties.video_url`, and for any file still sitting raw in the
`property-videos` bucket it downloads, re-encodes with ffmpeg (H.264, long
side <=1920, <=6 Mbit/s, about a third of a phone clip), uploads
`<name>-web.mp4` next to it, repoints `video_url` and deletes the original.
Decisions live in the local table `video_compress_jobs` (`done`, `skipped`,
`failed`, `done_unlinked`) so nothing is encoded twice and failures are
visible: `SELECT * FROM video_compress_jobs ORDER BY updated_at DESC`.
Needs `ffmpeg`/`ffprobe` on PATH (apt, installed 2026-09-05) and the same
Supabase service credentials listing-publish uses; `VIDEO_COMPRESS_DISABLED=1`
pauses it. One file per tick, `nice -n 10`, two threads, so the bot stays
responsive.

## Website photo variants (2026-09-13)

`lib/photo-variants.ts` + `routes/photo-variants.ts`. The website serves every
catalog photo through its own worker (`/img/...`, bali-villa-rentals
`worker/image-edge.js`), which caches per Cloudflare location. On a cold
location it used to fall back to Supabase: 1.5–3 s per photo for a render,
1.8–2.1 s even for a plain object, so new listings and old villas lagged for
their first visitors. This server renders each photo once with ffmpeg (webp
q75, 600/900/1600 wide) into `/opt/photo-variants` and serves
`/photo-variants/w<width>/<bucket>/<path>`; the worker asks here first.
- Every 60 s the pass reads `properties.images`, newest listings first; a 404
  from the route puts that photo first. Progress: `GET /photo-variants/_status`.
- Files are named by a sha1 of the object path — a URL never becomes a
  filesystem path.
- It stops while the disk has under 1.5 GB free: this is the bot's server. The
  whole catalog (~6,800 photos) is about 1.7 GB.
- A photo with an EXIF rotation is skipped and stays on the transformer.
- `nice -n 10`, one ffmpeg thread, one photo at a time, 50 s per tick.
  `PHOTO_VARIANTS_DISABLED=1` pauses it.

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
- **One request, one filter, one final check (owner, 2026-09-14: «количество
  комнат, бюджет и район — это основа запроса, и предлагать нужно только в
  нём»).** Ten days after the rule below, a thread-by-thread read of 86
  "Options sent" cards still found villas outside the request in September,
  because the rule lived in five copies that disagreed: matchProperties added
  +15% to every budget and, for a villa the lead named, offered ±1-bedroom
  alternatives from any area; candidatesForLead had its own filter;
  availabilityForCriteria counted stock a third way for the prompt;
  criteriaFromListing turned the clicked ad villa's price × 1.15 into the
  client's "budget"; and pickPropertyAttachments attached the clicked villa
  "fit or not" (R-YUD-066, let until Oct 2027, to a client moving in
  tomorrow; R-YUD-050, 3BR at 66M, to 2BR-under-50M and Ubud-only clients).
  Nothing read the move-in date, the stay length or a listing's minimum stay;
  "minimum 3 bedrooms" was read as exactly 3; a place the site does not list
  (Kedungu) was silently dropped, so the area filter vanished; and a scout
  lead's request in the card notes never reached the matcher at all. Now, in
  `property-catalog.ts`:
  - `resolveClientRequest` is the ONLY reader of the request: broker edit
    instruction > client's own messages (newest wins) > form answers > scout
    notes; the clicked villa fills only bedrooms (as a floor) and area when
    nobody stated them — never money. Never our own messages. Budget goes
    through `extractBudgetIdr`/`extractBudgetFloorIdr` source by source; one
    Haiku call reads the rest (`client-request` label), cached 10 min.
    `lead-profile.ts` stores `req_bedrooms/req_areas/req_budget_idr_monthly`
    from it too (they had stored villas WE sent as the client's request).
  - `requestMisfits` is the ONLY judge: bedrooms exactly as asked (range /
    "at least" as stated, no ±1); only the named areas (neighbours only when the
    client said nearby is fine; an unlisted place matches nothing); the
    published monthly price ≤ the stated ceiling with NO headroom (a range's
    floor keeps its ×0.85); free on the move-in date and not booked during the
    stay (`busy` periods); `min_stay_months` ≤ their stay, no yearly-only for a
    short stay.
  - `strictShortlistPool` is the ONLY candidate list: `matchPropertiesDetailed`
    (every bot draft, via `pickPropertyAttachmentsDetailed`) and
    `candidatesForLead` (the edit path's composer) both draw from it. The model
    only chooses among fits; top-ups come from fits; nothing is added to make
    up numbers. A named/clicked villa rides along only if it fits.
  - Nothing fits → nothing attached, and `shortlistPromptBlock` tells the
    writer to say honestly that nothing is exactly within the request right
    now and ask ONE question about the dimension that would open the most real
    options (`relaxationHint`: nearby area / budget / bedrooms / dates).
    Everything fitting already sent → no new links, refer back.
  - `enforceRequestOnDraft` (generate-suggestion.ts) is the final check every
    generator runs — both generateSuggestion copies, generateFollowup,
    generatePushFollowup: drops attachments that are unpublished or outside the
    request; forces the rewrite when the text misses an attached villa, gives a
    different NUMBER of villas ("two more options" over three links), or names a
    villa neither attached nor already sent; removes "links below" with no link.
    `approve.ts` drops links to unpublished listings before sending
    (`dropUnpublishedAttachments`; R-AME-028 went back to draft while a
    follow-up carrying it waited).
  - Edit path: outside the pool only what a PERSON chose may go out — links
    the broker hand-curated and villas the broker named. A `keep_current`
    link that is outside the (possibly instruction-updated) request is
    replaced from the pool.
  - Edit path, the broker asks for options and only the client's area blocks
    (owner, 15.09.2026): Amelia asked five times for "options of 3 bedrooms
    under 70 million" on 23534609, whose form says Denpasar Barat (no villa
    of ours there); five empty pools, a question about Canggu instead of
    links. Now `BROKER_ASKS_FOR_OPTIONS` (suggest.ts) sets
    `candidatesForLead.widenAreaWhenEmpty`: an empty pool whose `RelaxHint`
    is the area (and whose areas did not come from the broker) is drawn from
    `hint.areas` (named neighbours, else the area holding most fits), and the
    composer gets `poolNote` to say plainly where the villas are. The bot's
    own drafts still ask the client first. Log line: "candidatesForLead:
    nothing in the client's area — the broker asked for options".
  - Edit path, text over dropped villas (same lead, 15.09): the composer wrote
    "a 3BR villa in Canggu at Rp 65 million, a 3BR in Umalas at Rp 58 million"
    and picked ids the code then dropped (empty pool, already sent); on
    `none_this_message` nothing read the text again, and the phrasing
    pre-filter of `stripUnbackedListingOffer` did not match "worth a look".
    Now suggest.ts keeps `modelIds` (before any narrowing): a picked villa not
    attached → the text is reconciled under the final links, or with nothing
    attached `stripUnbackedListingOffer(text, force=true)` rewrites it; the
    same with nothing attached under a text that describes a villa by size or
    price (`DESCRIBES_A_VILLA`). Log line: "villas the composer wrote about
    were not attached".
  Call sites covered through the shared picker: lib `generateSuggestion`
  (unanswered-live pass, ad-lead opening, handover, viewing-report
  `shortlistAfterViewing`, timeline-sync, retouch), the webhook copy (live
  webhook, regen, upload, bulk import), `generateFollowup`,
  `generatePushFollowup`, suggest.ts split path (`pickPropertyAttachments`)
  and composer (`candidatesForLead`). There is no separate "new listings"
  sender. Before touching any of it: replay real leads through the bundle
  harness (see Working conventions) and look at request + attachments + text
  together.
- **Among villas that fit, ONE ranking decides the order (Amelia, 14.09.2026:
  "the bot only sends earliest options added while there is a better option
  added").** The strict pool was sorted cheapest-first, and among 2BR fits the
  cheapest were the oldest stock (R-YUD-074 22.5M with 7 photos, R-DESTI-003
  24.2M minimum 12 months, R-MER-040 28.6M). Every matcher line also showed
  "N views", and the prompt added "this broker has used these before" from
  `broker_property_picks`, a counter bumped by every approve of the bot's OWN
  picks: a third closed loop after views. Over 01-14.09 on Rental leads the
  bot's drafts attached villas with a median listing age of 11 days (push) / 17
  (live), Amelia's own phone links 7; R-YUD-074 sat in bot drafts for 34 leads.
  The first fix (f359a54, 14.09 morning) summed fit and quality into one score
  with +1 for a listing 14 days old or less, so "new" became the next bias, and
  it read the retired boolean `red_flag`, so no red flag ever counted.
  **Owner, the same evening: the request is the base of everything; old and new
  villas mix freely ("у нас аренда, они сдаются, потом опять свободные"); what
  we know about the villa decides only between equal fits.** Now
  `rankShortlistFits` (property-catalog.ts) orders every fit inside
  `strictShortlistPool` BEFORE anything is cut, each step only between villas
  equal on the steps before it:
  1. an area the client named over a neighbour they only allowed;
  2. fit (`score`): price vs the stated ceiling ≥90% +3, ≥80% +2, ≥65% +1 (a
     50M client sees 45-50 first; a form bucket "30-50" is read the same way;
     a narrow range the client gave, floor ≥80% of the ceiling, is +3 all
     through); no published price −3; free-from with no
     move-in −1; stay unknown and yearly-only −1, minimum 12 months −0.5, 6
     months −0.25;
  3. not offered to this lead in a draft the broker SKIPPED in the last 21 days
     (`skippedDraftPropertyIds`; lower, not out);
  4. `quality`: construction nearby −1.5; each red flag line −1 (max 3; a line
     restating the construction tick is not counted); each green flag line +0.5
     (max 3 lines), both from `property_private.red_flags` / `green_flags` via
     `listingQualityById`; Listed +1; video +1; under 8 photos −1, temporary OTA
     photo set −0.5, 10+ photos +0.5; dates confirmed within 21 days +0.5;
  5. `rotationTurn(leadId, id)`, a stable per-lead shuffle: villas equal on
     everything alternate between leads instead of one going to all of them
     (callers pass `leadId` / `rotationKey`).
  No listing age anywhere, never views, never pick counts (the read side was
  deleted; the counter is history only). The matcher sees the top 12 with
  `why:`; the edit composer the top 20 with client-safe reasons only (price,
  area, dates, stay, video), never Listed/photos/flags. A weight changes there,
  followed by a replay; no other sort anywhere. Replay 14.09 evening (18 Rental
  leads with drafts, prod vs branch `strictShortlistPool` on the same resolved
  requests, read-only): top 3 changed on 12 of 16 leads with fits; median
  listing age in the top 3 12 → 16 days (no bias either way); first place 8 →
  11 different villas across 16 leads. 23558753 (2BR Canggu, 30-50M): old top
  R-YUD-053 at 36.7M, new R-YUD-047/089/090 at 45-46M.
- **A shortlist is 2-3 listings when 2-3 FIT — never padded (owner, 2026-09-04).**
  Bedrooms, area and budget are filters, not preferences: nothing of another
  size, district or price rides along because the right one was missing. One
  fitting villa goes out alone; none means an EMPTY shortlist (since 14.09 the
  reply asks ONE flexibility question, see above; neighbours are named only as
  that question). Before this the empty area silently fell back to the whole
  island, bedrooms widened ±1, the model was told to "pick the closest areas",
  and the top-up drew from all priced stock — a 1BR-in-Nusa-Dua request went
  out with a 2BR in Pererenan. The owner's words: «человек говорит направо, ты
  ему даёшь налево — так не надо». The broker's own "look elsewhere" still
  releases the area (brokerIntent.release_area / BROKER_RELEASES_AREA).
- **Text and links are ONE message (owner, 2026-09-04: "текст и ссылки это одно
  и то же").** The writer used to run concurrently with the matcher and could
  not know what got attached; prompt wording alone never fixed it. Now every
  generation path picks the villas first, puts the exact list in front of the
  writer, and then `allAttachmentsNamed` — a deterministic check on DISTINCTIVE
  title evidence, not "pool" + area — forces `reconcileTextWithAttachments`
  when the text misses any attached villa. `approve.ts` is the last gate and
  reconciles BOTH ways: an edited text pulls the links to the villas it names
  (`villasNamedInText`, precision-first, capped), changed links pull a rewrite
  of the text, and a stale mismatch is rewritten before it leaves. Nothing
  downstream reads `body.message` raw; it reads `finalMessage`.
- **A truncated AI answer is not a failed one.** `chatCompletionJSON` repairs a
  JSON object cut off by `max_tokens` — the matcher explained its reasoning first,
  ran out of room mid-array, and three chosen villas became an empty shortlist.
- **A listing with no price is held back from the first shortlist** — the client
  can't judge it. Priced stock ranks first, never by views (`rankShortlistFits`). If the lead's own area holds
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
- **The lead's stated budget filters the shortlist** (`extractBudgetIdr`; since
  2026-09-14 with NO headroom — the stated maximum is the maximum; a range's
  floor keeps its ×0.85). When nothing
  fits, NOTHING is attached (since 2026-09-04) — the reply says the budget holds
  nothing here and asks what else could work; it never pretends the budget was met.
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
- **A parked "long term" villa gets a dated availability check as a READY
  DRAFT, and leaves the stage when it frees up (2026-09-05).** Parking used to
  leave only an amoCRM task 14 days before the free date; the broker saw a task
  and an empty Copilot. Now `routeUnqualified` stores the free date on the card
  (`leads_sync.listing_free_from`, only if it lies in the future and within 18
  months — the extractor once returned 2024 for "free from September"),
  `long-term-check.ts` writes the check two weeks before it, stamped
  "availability check due" so the inbox shows it on the suppressed stage, and
  `releaseFromLongTerm` moves the card the moment the owner says it is free:
  to Details when bedrooms, price with commission and the owner are all known,
  back to TAKEN TO WORK when not. Nothing else touches a card that is still
  occupied.
- **Every draft the bot might send passes through autopilot when it is born,
  and a PROACTIVE send waits for daytime.** The owner-nudge pass wrote its
  drafts straight into `pending_suggestions`, so `maybeAutopilot` never judged
  them; verdict-less, the inbox's 30-minute safety net surfaced them in the
  broker's PUSH tab every evening (twelve at 21:00 on 2026-09-04), inviting him
  to send by hand, at night, what the bot would send itself at 10:00. Now each
  nudge is handed to `maybeAutopilot` on insert; a push-kind or first-contact
  send outside 10:00–20:00 Bali is stamped "waiting for outreach hours" (which
  the inbox reads as the bot's) and the drain sends it in the morning; a reply
  to someone who just wrote is reactive and goes out any time. The drain judges
  unjudged drafts first — a "waiting" draft is still pending, and oldest-first
  kept re-evaluating the same fifteen. Anything new that writes a pending draft
  must call `maybeAutopilot`, or it will show up as the broker's job.
- **A budget FLOOR above the CEILING is a parse error, never a range — drop it.**
  "Rp 200-400 million/year (up to ~33 jt/month)" carries both a yearly range
  and a monthly figure. `extractBudgetIdr` read 33M a month; `extractBudgetFloorIdr`
  decided yearly-vs-monthly per MESSAGE, "per month" won, and the yearly range
  became a 200M MONTHLY floor — above every villa on the island. Nine villas
  passed area and bedrooms; the floor removed all nine; the composer, handed an
  empty candidate list and an instruction to "attach the links", invented three
  ids that resolved to nothing, so Amelia got a text describing villas with no
  links six edits in a row (23474281, 2026-09-04). Now: the floor parser reads
  the period written NEXT TO the range; both `candidatesForLead` and
  `matchProperties` ignore a floor that exceeds the ceiling; and a composer whose
  `new_selection` ids resolve to nothing hands the edit to the split path
  instead of shipping the text. `candidatesForLead` logs "pool is EMPTY after
  filters" with every filter's numbers — read that before touching the prompt.
- **`areaMatches` compared a listing's area as one whole string.** Two catalog
  listings carry the sub-area AND its parent combined in one field
  ("Tumbak Bayuh, Pererenan"), which matched neither name in it — a lead
  asking for Pererenan was never shown a villa that is, in fact, in Pererenan.
  Split on the comma, match either part.
- **A stated budget is enforced in code, not asked of the model.** Handed an
  affordable-first catalog it still picked villas at double the figure; told the
  broker objected to the current links it dropped even the cheapest. The ceiling
  is applied to the final shortlist — and since 2026-09-14 it may cut it to one
  or to none (`requestMisfits`, `enforceRequestOnDraft`); "at least two" never
  outranks the request.
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
- **"Needs no reply" and "this conversation is over" are not the same closer.**
  `/no-reply-needed` exists for a lull — "thanks", "bye", 👍 — and keeps the lead
  alive by booking an adaptive next touch. It applied that to every dismissal,
  including one on a client who had just written "Thank you but we found our
  place!". The stage classifier had already marked that draft `Closed - lost` /
  terminal, twice, and the verdict was sitting on the very suggestion being
  dismissed; the endpoint never read it, so Amelia's trash tap booked a chase
  for two days later on a dead lead and looked like the button was broken
  (23291381, 2026-08-26). Terminal now means dismissed and left alone — clock
  nulled, open tasks closed, nothing new booked — and NOT closed automatically,
  which stays the broker's tap like every other terminal stage. Anything else
  that schedules a chase gets the same question first: has the conversation
  already ended? The toast has to match, too — announcing "will follow up later"
  when nothing was booked sends the broker hunting for a task that never
  existed.
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

- **Autopilot: one reply per message, one proactive touch per cadence — in code.**
  Audit 2026-09-08: 673 unattended sends in 7 days, and dozens of pairs where
  two DIFFERENT answers to the same inbound left in the same second. Cause:
  the webhook and the timeline poll each birthed a LIVE draft 15–25 s apart, a
  Salesbot send takes 10–15 s, so the second draft was judged and sent while
  the first was in flight. `maybeAutopilot` now serialises judges per lead
  (`judgeInFlight`) and, before any send, retires a LIVE draft when anything
  of ours (sent_messages or an outbound lead_messages row) is newer than the
  lead's last inbound, and declines a proactive draft when anything left in
  the last 20 h. The owner's frame: autopilot inherits the regulation the
  brokers trained by hand; it never gets to invent a cadence of its own.
- **A send amoCRM refused is not a send (15.09.2026).** At 13:17 the drain
  approved nine owner nudges in eight seconds while an admin dry plan read
  amoCRM too; amoCRM answered 429. `deliverText` fired no Salesbot for the four
  field writes it lost and one trigger failed, so nothing wrong reached anyone,
  but five messages were lost silently: approve answers HTTP 200 with
  `{ok:false}` and `maybeAutopilot` read only the HTTP status ("sent without
  approval"), the draft stayed claimed so the drain never picked it again, and
  approve still created the "Sent (push)" task and a commitment. Now: approve
  schedules tasks, commitments and the listing stage only when `chatSent`;
  autopilot treats `ok:false` as nothing sent, puts the draft back to pending
  with a "waiting" verdict; its "already answered" and 20 h guards count only
  2xx `sent_messages`, and a failed send holds a retry back 30 minutes. Do not
  run dry plans that read amoCRM per card in a burst of sends.

## The paid ad lead is answered in seconds, and its silence is read in 15 minutes

The opening on a Meta ad lead is an auto-welcome that sits OUTSIDE the count,
then the broker's first message. The owner decided the shape (2026-08-19) and
the naming (2026-08-21) — see "the numbering is not cosmetic" below.
`lib/ad-lead-autoreply.ts`:

- **The auto-welcome — outside the count, automatic, and it sends NO link
  (2026-09-04).** "Hi {name}, this is {broker} from Unicorn Property. Got your
  request: {form, verbatim}. Did I get that right?" — sent the moment the lead
  is seeded, no broker tap. It used to send the clicked villa's link too, and 33
  leads of data said the link earns nothing: when it matched the form 7 of 9
  stayed silent (nothing to answer), when it did not they wrote back to correct
  us. Its job is speed and proof the form was read; the cheapest reply ("yes")
  is the goal, and a "no, actually…" arrives before anything was sent. The
  clicked villa now rides LAST on the broker's first shortlist, fit or not —
  "the one you were looking at, for comparison" — appended in code in
  generate-suggestion for both the 15-minute opening and an early reply, so the
  two paths cannot drift. The old "anchor returned ALONE" exception is retired
  with it: the first shortlist is built from the FORM. This is the
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


**No automatic welcome for places we cannot serve (2026-09-10).** Amelia,
after the welcome read "4BR, Other, …, Sanur. Did I get that right?" to a
client in Sanur: "can we not send messages to areas we don't cover?"
`sendAdLeadWelcome` now asks `lib/area-coverage.ts` first. The places come
from the card's area answer, or from the notes when that answer is "Other"; a
place is served when an offerable rental sits in it, in its district or in a
NEIGHBOUR_AREAS district (Jimbaran and Nusa Dua through Uluwatu), read from the
live catalog, so a new villa in Sanur re-enables Sanur welcomes with no code
change. Only when EVERY named place is unserved is the welcome withheld: the
lead still gets the ordinary draft plus a "⊘ Review" flag saying why, and
nothing is closed (rental autopilot is off, so nothing else sends). Nothing
recognisable named, or the catalog unreadable, and the welcome goes as before.
`isNonAnswer` also keeps "Other", "No", "-", "." out of the recap line. The 30
days before: Pemogan and Ubud were welcomed and no conversation followed;
Megan (Sanur) answered "West side is ok" — which is why the lead is flagged,
not closed.
**An unrecognised place is welcomed, so the place list is the rule (15.09).**
Christine wrote "kesiman, kertalangu, batu bulan, sedap malam" (East Denpasar,
Batubulan) and got "Got your request: …, kesiman, kertalangu, batu bulan, sedap
malam. Did I get that right?" — none of the four was in `OTHER_PLACES`, so
nothing was recognised and the welcome went. The list now carries the
neighbourhoods and villages clients write (East Denpasar, Batubulan / Sukawati,
the Ubud villages, the east and north), and `DISTRICT_OF_PLACE` ties the ones
next to a catalog district to it (Renon, Kesiman, Sedap Malam… → Sanur;
Penestanan, Sayan, Singakerta… → Ubud), so a first villa in Sanur still
re-enables them with no code change. Kuta, Legian, Tuban, Benoa stay off the
list on purpose (next to served stock). When a client names a place and gets
a welcome we cannot back, add the place; replay `placesAsked` over the logged
"lead card fields read from amoCRM" answers before deploying.

**Catalog-form leads get the ad-lead mechanics; duplicate cards go to the bin
(owner, 2026-09-12).** Lance filled the catalog form at 03:26 ("Catalog Lead -
qualification", answers in the card fields, no listing code) and the website
form on R-YUD-048 four minutes later. The catalog card matched neither seeding
branch and was skipped every minute; the second card was another conversation
with the same number. Now a card named "Catalog Lead…" is seeded from its card
answers (`formAnswersFromCard`), welcomed by `sendAdLeadWelcome` with
`listingId: null`, and drafted at +15 minutes with a brief that has no clicked
villa (`clickedVilla` = a /property/ link in the seeded enquiry).
`lib/duplicate-card.ts` closes a card to Lost before seeding only when ALL
hold: created by automation (created_by 0), open in Rental, nothing sent or
drafted on it, and one of its phones equals, digit for digit, a phone on an
OLDER open Rental card. Notes on both cards start with "Note:" so the
housekeeping filter never seeds them as the client's words. Anything unreadable
keeps the card — a duplicate left open costs one look, a real lead in the bin
costs the lead.

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
- **A listing from the assistant is created as a DRAFT and goes live only if the
  site's database allows it (2026-09-10).** The site refuses to publish without
  Internal data (owner name, phone, map pin, Drive folder, notes), none of which
  intake collects — the old one-step insert with `is_draft: false` is refused
  outright. `pushToSupabase` inserts a draft (after any overrides), asks
  `listing_publish_blockers`, publishes only on an empty answer, and treats an
  unreadable answer as blocked. Every surface says "saved as a draft, still
  missing …" with the site's admin link (`adminPropertyUrl`) instead of
  "published": the website bubble, `/m`, and the review-queue API response. Do
  not keep a copy of the field list here — ask the database. The review page in
  `artifacts/landing` is not rebuilt by deploy.sh (its dist dates from
  2026-08-08), so it only refreshes the queue.
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

### Rental viewing stages: the canons (2026-09-09)

The owner: "это ключевые метрики… очень важно, чтобы бот корректно ставил
лиды на эти этапы; нужно читать переписки по контексту". The board showed
ONE Viewing done on 09.09 after four held viewings, because the first viewing
report sent "Not this one" back to Options sent. Canons, enforced in
`stage-on-reply.ts`, `viewing-report.ts` and the audit:
- **viewing Suggested** — a viewing was offered or asked for and no concrete
  slot exists yet ("can we visit?", "I'll check availability", "tomorrow?"
  without an answer). Silence after the offer keeps it here; a client who
  went to view with ANOTHER agent (Alena I.) or rejected the villa from
  photos (Samuel) is not here — that is Options sent / Objection Handled.
- **Viewing scheduled** — a concrete date and time settled or accepted, and
  `viewing_at` holds it. No slot readable in the thread (ahead, or ≤2 days
  past) → the card does not enter. A reschedule replaces the slot; a stated
  cancellation / no-show (second opinion) leaves the stage and clears it.
- **Viewing done** — the client stood in the villa (or a video walkthrough
  for an off-island client). Set from the thread after the slot
  (viewing-outcome pass, classifier canons) or by the broker. **It stays
  Viewing done whatever the client's verdict, and a new shortlist does not
  move it back** (owner, 14.09.2026: "пусть там же остаётся — просто
  подбирается новая вилла, но этап тот же"; this reverses the 09.09 rule that
  links on send returned it to Options sent — that rule and the classifier
  flipped Searra and Alena Viewing done → Options sent → Viewing done within a
  minute). From Viewing done or later nothing automatic moves the card to a
  pre-viewing stage; a second viewing is a new cycle (Viewing scheduled). The
  viewing report never moves the card.
- **Negotiation done** — from the thread (terms being discussed) or the broker.
- Every held viewing has a report row; the weekly numbers count reports.
Audit by hand: `POST /api/admin/reclassify-manual?pipeline=rental` (dry)
prints each canon that held. Read the thread before overriding it.

### Every draft after the shortlist pushes for a viewing (2026-09-10)

The owner's lever: "Поднять заявку → показ: предлагать слот всем, а не
четверым из двадцати одного. Это ноль рублей." Two weeks of data (26.08–09.09):
59 leads got links, 41 replied, 6 were asked about a viewing with anything
concrete, 30 never heard the word "viewing" from us; the bot proposed a slot
in 10 of 438 messages. The rulebook already said "offer a specific window" —
a sentence in a 9,000 token prompt is not a rule. And the second half of the
owner's instruction, same day: "не перегнуть… чтобы триггер был, но
выглядело как Амелино сообщение" — the trigger is ours, the words are the
broker's. Amelia's own move is not "tomorrow at 11 or Friday at 15" (the
first version made two drafts copy that literal example): she asks "are you
currently in Bali to do some viewings?", "which day suits?", offers to check
the owner's availability for a day, and
gives a concrete time only once the owner confirmed it. Her 09.09 lesson says
exactly that ("replace 'tomorrow' with an open question about preference").
Now — ONE shared point in `generate-suggestion.ts`, asked by EVERY generator
of a client-facing Rental draft through a `ViewingPushContext` (lead id,
pipeline, stage, merged thread, broker, kind):
- `viewingPushApplies(ctx)` — the one gate. Rental, and
  `viewingPushDue(messages, stage)`: links already in the thread, the card
  before Viewing scheduled, the client's last reply (if any) not a hard no
  (`HARD_NO`: found a place, not interested, stop). Silence after links
  counts; "too expensive" counts. And not the villa itself
  (`isVillaSideContact`, below).
- `viewingPushPromptBlock(ctx)` — the prompt half: `viewingPushBlock(broker,
  examples)` or "". `brokerViewingExamples` reads the broker's OWN viewing
  invitations (lead_messages `sender_type='broker'`, their Rental leads, 90
  days, cached 15 min, villa-side threads skipped) and puts them in the block
  as the style; the block lists the moves (ask if in Bali / which day / check
  the owner's availability / "I'll check with the owner", never a booking)
  and carries no example sentence of its own. The broker's lessons come after
  it in the prompt and win. **No video tours or virtual viewings (owner,
  10.09: "не стоит пока про видео тур")** — off-island client: ask when they
  arrive, line up the viewings for those days; the broker's own "virtual
  viewing" lines are filtered out of the examples.
- `applyViewingPush(text, attachments, ctx)` — the text half, on the finished
  draft after the attachment reconciliation: `proposesViewingSlot` (a viewing
  word AND a time, a time-bound question or a direct ask; "whenever you like"
  is not a move) or ONE Sonnet insertion via `enforceViewingProposal` — one
  sentence in the broker's voice, their lessons and examples in the prompt,
  the rest verbatim (rejected if it shrinks the draft). A second miss goes out
  as written and is logged (`viewing push:`). The first shortlist message is
  not pushed — the push starts with the next message.

Who calls it (14.09): both `generateSuggestion` copies (lib and
`routes/amocrm-webhook.ts` — through `buildPromptAdditions` and their tails,
so every caller of either copy: webhook LIVE/regen, timeline sync, the
unanswered-live pass, ad-lead opening, handover, viewing-report shortlist,
upload/skip/bulk-import, retouch), `generateFollowup` (warmup, Rental
follow-ups, admin force-push) and `generatePushFollowup` in
`followup-scheduler.ts`, and the viewing report's plain client draft. Not
pushed on purpose: templates that no model writes (the ad-lead welcome, the
"how did the viewing go?" placeholder), the broker's own edit path
(`/suggest` — the instruction is law), and Rental Listings (owners). **A new
generator of Rental client drafts builds a `ViewingPushContext` and calls
both halves — never a copy of the gate.** Until 14.09 the gate lived only in
the two `generateSuggestion` copies, and the follow-up scheduler — 35 of the
45 post-shortlist drafts from 10.09 to 14.09 — asked for a viewing in 10 of 35
(29%, unchanged from before), against 9 of 10 from `generateSuggestion`.

**The villa is not a client (14.09).** Amelia writes to a villa from her
phone to book a client's viewing and sends it its own link; amoCRM opens a
Rental card on the reply, and the thread reads exactly like "options sent,
no viewing". The bot asked Mireia (R-YUD-065's contact, 23543021) "are you
currently in Bali … so we can line up some viewings for you?" and drafted an
Indonesian "how did the viewing go?" to Bu Nia (R-YUD-054, 23528767). No
Rental-side counterpart signal existed (no Rental Listings card for either
number), so the signal is the site's Internal data: the card's phone
(`leadPhone`, amoCRM) equals a listing's `property_private.owner_phone`
(`villaContactPhoneKeys` in property-flags.ts, last 9 digits, 10-minute
cache, digits only in memory). Cached per lead 6 h; an unreadable phone or
list means "not the villa" and the push stays. A villa staffer whose number
is not in Internal data is not recognised — fill the owner phone.

**"view" is a viewing word (14.09).** Amelia's most frequent line is "Are you
currently in Bali to view some properties?"; `VIEW_WORDS` had no "view", so
her examples never reached the prompt and a draft that already asked could
get a second insertion. The verb only (`to view`, `view some/the/it…`), not
"ocean view".
Anything that shapes what a broker sends gets the same two halves: the
trigger in code, the wording from the broker's own messages and lessons.

**The viewing canons run on the send path too.** Automatic moves apply them in
`decideStage` (`thread-stage-sync.ts`, see "Stages follow the thread" below);
`viewingCanons()` in `stage-on-reply.ts` covers the broker's explicit pick in
`approve.ts`. Until 10.09 approve wrote the pre-send classification as-is:
"Viewing scheduled" landed with no `viewing_at`, so the report was never asked
for and "Viewing done" could not follow. The broker's explicit pick is never
refused, but the slot is still read and stored (`viewing_slots` too); a
backward move by a person clears it.

**A pass that nothing schedules does not run.** `processViewingOutcomes` was
reachable only through `POST /api/admin/reclassify-manual?apply=1` — Lorenzo's
09.09 viewing had no report the next morning. It is on the 5-minute tick now.
Anything new that "runs three hours after X" gets the same check before the
verification claim: `grep -rn <fn> src` must show a scheduler call site.

### "Not that, send others" gets a new shortlist (2026-09-14, phase 1)

Owner, 14.09 (final): people rarely say "I don't like it". "Let's see more",
"not quite my style", "I've seen these", "keep sending", "hopefully something
comes up", "anything else?", "similar ones?" and any new criterion (budget,
area, pool, garden, pets, dates, parking) are objections — the answer is
ALWAYS a new shortlist inside the request. No new links only when the
client's latest message sits on ONE villa we already sent with a next step
(its price / location / availability / a viewing of it, "I like this one").
The stage alone decides nothing. When unsure, the shortlist goes.

**The skip that fired all week was never the client.** The quick poll
(`amo-timeline-sync.ts`, both LIVE call sites) hands generators
`content + "[LATEST MESSAGES — …]" + a raw timeline tail` ("Amelia:
https://…/property/R-YUD-048" lines, no timestamps). `parseDialogContent`
runs each message to the next timestamp, so the whole tail — our own link
messages — was glued onto the last message of content; when that was the
client's, `shouldSkipNewListings` saw our link IDs in the client's words and
logged "lead is discussing listings already sent" (Lance 12.09 ×2, Luke
14.09 ×2, Jesica 11.09, Chloé 11.09, Sophie 14.09 — all seven reproduced with
a read-only rebuild of the snippet; content alone skips none). The same glue
fed our "Rp 45 million, 6-month stay" into Chloé's request on 14.09 20:11.
`parseDialogContent` now cuts the tail (its messages are in lead_messages).
**Anything that appends raw text to `content` must not be parsed as dialog.**

**The gate** — `decideShortlistGate` in `generate-suggestion.ts`, asked by
`pickPropertyAttachmentsDetailed` (so every generator: both
`generateSuggestion` copies, both follow-up writers). On the client's latest
turn (their messages after our last one; our quoted text cut by
`clientOwnWords`), in order: `ASKS_FOR_MORE` → send; one villa
(`ONE_VILLA_REFERENCE`, a sent ID in the message, or "is it / see it" in a
short message) + `NEXT_STEP_ON_A_VILLA` → skip; `NEW_CRITERIA` or an area /
landmark → send; a late stage or a weak reference (a sent ID, "this one", a
quote) → Haiku yes/no, 8 s, anything but a clear "focus" → send; otherwise
send. Every decision logs `property matcher skipped — <rule>` or `shortlist
gate: this message carries new options` with `rule` and evidence. Past the
gate a Rental draft carries options: `matchPropertiesDetailed({ mustAttach })`
— the model chooses among fits, an empty choice or a failed call attaches the
top ranked. Replay 14.09 (the logged moments): send for Lance, Luke, Jesica,
Chloé, Sophie ×2, Lorenzo ("similar villas", Negotiation done); skip for
23485903 "Is it available right?", 23461427 "location this villa?" (quoted
R-AME-030), 23201221 "I love the last one", 23475455 "I like this one, is
this one available to visit tmr" (quoted R-YUD-071).

**No "for yourself or someone else?"** It came from Amelia's `followup`
lesson 3e3dc234 (12–14.09, "qualify whether the prospect is looking for
themselves or representing a client"), and reached 13.09 follow-ups to Lance
and Chloé in front of the villa. `broker-corrections.ts` refuses such a
lesson outside `owner_intake` and filters it on reading;
`enforceRequestOnDraft({ rental: true })` strips the question (keeping a
leading "Hi Name,") on every Rental generator.

**A client reply gets its LIVE draft.** Lance answered the ad welcome at
11:24 (12.09); the webhook read "not a reply" (`leadRepliedAfterUs` needed a
HUMAN message of ours, the welcome is `bot - amocrm`) but stored the message
time, the quick poll then skipped it as known, and the 15-minute opening
drafted at 11:39 after Amelia had already sent villas by phone. Now: a reply
to our bot message counts (`leadRepliedToBot`); the quick poll answers a
client message from the last 15 minutes that the row marks known but that has
no draft, no reply of ours and no LIVE in flight (`knownIncomingNeverAnswered`,
`liveReplyInFlight`); the opening pass skips a lead where the client or the
broker wrote after the welcome (lead_messages, not only sent_messages).

### Phase 2: the request is the client's words, nothing is sent twice, links are never lost silently (2026-09-14)

- **Request reading** (`resolveClientRequest`). `clientOwnWords(text,
  ourMessages)` cuts OUR quoted message by matching what we actually sent, so
  it works on content's one-line rendering too (Jesica's ">> … 2BR options …
  If there's a 2br with an office space" now reads 2–3 bedrooms; before, the
  whole reply was dropped). `nextOccurrenceIso`: a model date more than 45 days
  in the past rolls forward by years ("February" said in September is next
  February — Chloé's had become today, and a villa free from 4 October was
  "too late"). `APPROXIMATE_BUDGET` ("around", "ideally", "roughly", "~",
  "-ish") sets `budgetAroundIdr` and reads the ceiling ×1.15 and the floor
  ×0.85; `HARD_BUDGET_CEILING` ("max", "up to", "under") never gets headroom
  (Lance "Ideally around 30mil" → R-YUD-098 at 33M). `fuzzyAreaNamesInText`
  (bali-areas.ts): edit distance ≤1 (≤2 from 7 letters) plus
  `VOICE_AREA_ALIASES` ("cannot" → Canggu), only on short items of a list of
  two or more places, with a stopword list ("loving" is not Lovina); a client
  message listing places with a misspelling adds them all except one preceded
  by not / avoid / except. `landmarkAreasInText`: Nuanu → Seseh, Cemagi,
  Tabanan, Kedungu (only names in the vocabulary survive); also Tanah Lot,
  Finns and Atlas beach clubs, Potato Head, Old Man's.
- **Nothing inside the request.** `relaxationHint` carries an `example` (the
  priced villa closest to the budget; any area when no neighbour has one) and
  `relaxQuestion` names it in plain words — size, area, price, free date,
  never a code or a title, so the stray-villa check does not strip it. The
  edit path gets the same question (`composeReplyWithListings({
  emptyPoolGuidance })`) instead of "let me check … I'll come back with a
  proper shortlist".
- **Never re-attached.** The edit path's pool now has an exclusion at all
  (`candidatesForLead({ excludeIds })` from `alreadySentPropertyIds`);
  `enforceRequestOnDraft` drops a sent villa on every generator.
  `alreadySentPropertyIds` counts a draft row's links only as far as its send
  record says they went out (`| links n/m`; no send record yet = all; a send
  without the marker = none) — Sophie's 12.09 draft left with no links, its
  row still listed three villas, and they were "already sent" forever.
  approve now stores the links that actually go out on the row.
- **Edited text that names none of its villas** and does not point at the
  links (`REFERS_TO_ATTACHED_LINKS` now also "here they are", "these three",
  "take a look"): approve refuses with 409 `links_not_named` and names the
  villas; the /m page shows `json.message`. Chosen over keeping the links (a
  text saying "nothing fits right now" would carry three villas) and over
  dropping them (Sophie 14.09 got "Here they are:" with nothing under it).
- **Replay** (worktree code, threads cut at the logged moments, read-only):
  Lance → R-YUD-098 (around Rp 30M, move-in January); Luke → Umalas / Canggu
  / Berawa / Padonan / Seseh, R-YUD-055, R-YUD-088 (Babakan), R-YUD-059;
  Jesica → 2–3BR Seseh / Cemagi / Kedungu / Munggu, R-YUD-075 (R-YUD-074 at
  22.5M is under the form's 30–50M floor ×0.85); Chloé → 1–2BR Umalas,
  February next year, R-YUD-098; Sophie 12.09 and 14.09 → Seseh / Cemagi /
  Tabanan / Kedungu, R-YUD-075 + R-MER-040; Lorenzo → R-YUD-053; the four
  one-villa threads still get no links; no edit-path pool holds a sent villa.

### Stages follow the thread, whoever wrote the message (2026-09-14)

Owner, 14.09: "всё должно быть синхронно вацап и копилот". The audit of
07–13.09 found 29 Rental cards on a wrong stage, all from one disease: the
stage decision lived in several copies that disagreed.
- A reply typed on the phone was seen first by `syncOutgoingEvents` (repair
  mode, no stage), which stamped `last_our_message_at`; the timeline sweep
  (`lastOurMessageAt >= newest → continue`) and the webhook
  (`brokerRepliedFresh` false) then saw nothing new, and nothing classified
  it: Lorenzo's second viewing, Remi's viewing, links sent from the phone.
- The echo of our own send reached the webhook as "the broker replied" and
  re-classified a thread whose links were not stored yet: cards moved BACK.
- approve applied a pre-send classification read from frozen `content`, and
  the card's stored stage id outranked the new name: 20 `stage_events` rows
  amoCRM never received.
- The first message never set "need assessed"; a card held one viewing only.

Now ONE entry point, `onThreadChanged(leadId, {source})` in
`lib/thread-stage-sync.ts`, called for every new message on every path:
`syncOutgoingEvents` (before its skips), the timeline sweep, incoming
detection and quick poll, the webhook (every Rental event; other funnels only
for a reply typed by hand), approve after a Rental send, the automatic
welcome, `send-chat-message`; the outcome pass and `reclassify-manual` call
`syncStageFromThread` directly. It debounces 75 s per lead (max 5 min),
re-reads the lead's timeline into `lead_messages` (never `content`), takes the
stage from amoCRM (never `leads_sync`) and decides once, with its own
watermark `leads_sync.stage_checked_at`:
1. no-WhatsApp notice → `closeUndeliverable`, by `undeliverableVerdict` (the
   LIVE debounce asks the same verdict): the notice is the newest client-side
   message, the client never wrote a real one, nothing of ours went out more
   than 3 min after it (a line re-test);
2. floors in code: anything we sent → at least "need assessed"; a `/property/`
   link we sent → at least "Options sent"; never lower;
3. viewing slots (`extractViewingSlot`: the slot, when it was agreed, the villa
   named in THAT exchange or null) go to `viewing_slots`. A slot agreed after
   the previous one passed is a new cycle: Viewing done → Viewing scheduled
   with the new `viewing_at`, no regression check. On Negotiation or a closed
   card the slot is still recorded, for its report;
4. the classifier for the rest, told the facts. Forward moves are free;
   "Viewing done" before the booked slot and "Viewing scheduled" without a
   slot are refused; a backward move needs `backwardEvidence` (one yes/no,
   fail-closed); when only our own sends are new (bot sender, or a
   `sent_messages` row within ±3 min) nothing moves back. Viewing done →
   Options sent needs no check when a shortlist of other villas went out
   after the viewing (canon of 09.09).
Closed won/lost, CHECK IN, Contract signed, the REACH ladder and administrative
stages are never left automatically. For Rental, approve no longer applies
`suggested_stage` (a person's pick still applies at once); for Unicorn it does,
with the id of the name chosen. `stage_events` and `leads_sync` are written
only after amoCRM accepted the status. One log line per run,
`stage-sync decision` (lead, source, from, decided, reason — also "not moved
because …"), and a `stage_sync_decisions` row. `classifyAndApplyStage` is a
wrapper around it now.

**The check runs itself (owner, 14.09: "мы это чиним уже в 10 раз").**
`lib/stage-sync-check.ts`, daily from 09:00 Bali and 40 min after a restart if
that day's run has not happened; on demand
`GET /api/admin/rental-stage-sync-check?hours=24` (`&alert=1` pushes) or
`scripts/rental-stage-sync-check.sh [hours]`. It fails on a card below its
floor (amoCRM's stage), a `stage_events` row with no amoCRM
`lead_status_changed` ±4 min to the same status, and a reply typed on the
phone with no `stage_sync_decisions` row within 10 min; any failure pushes the
owner through the AI-outage alert path, lead ids in the text.

- `/api/admin/reclassify-manual` (POST, `?days&pipeline&apply=1&forward=1&slots=1`,
  or `?lead=`) runs the same decision. Dry by default; a bulk run applies
  forward moves only and prints the rest for a person to read first.
- A correlated subquery inside `db.select({...})` rendered `lead_id = lead_id`
  and greeted Liu as "Fengshui": read per-lead values in their own query.

### The viewing report (2026-09-08)

A viewing happens in person, so the card learned nothing from it: four held in
one week, none with a verdict, objections or a next step on the card, the next
draft written blind. `lib/viewing-report.ts`: three hours after `viewing_at`
(the `viewing-outcome` pass) a `viewing_reports` row goes "due", an amoCRM task
"Fill the viewing report: …" is created (it IS the today/overdue badge), the
broker gets a push, and a placeholder "how did the viewing go?" push draft
(verdict `viewing follow-up due`) guarantees the card exists in PUSH — the
inbox lists drafts, not cards. The card carries the form
(`renderViewingReport` in mobile.ts; `openDetail` must copy `viewing_report`,
it copies fields by name): outcome (one tap: go / think / no, or didn't happen
/ cancelled / rescheduled), the client's feedback in the broker's words
(dictation via the existing `startVoiceDictation`), next steps as taps plus a
date. `POST /api/public/viewing-report` files it: stage from the outcome
(go → Negotiation done, think → Viewing done, no → Options sent, didn't happen
→ Viewing scheduled with the slot cleared/replaced), note on the lead, note on
the listing card found by property code, report task closed, next-step task
created, placeholder retired and a Sonnet draft to the client written from the
report (`REPORT_FILED_VERDICT`). **The report moves nothing (owner, 09.09.2026).** It is information for
analysis — the blind spot of what happened at the viewing. Filing it writes the
notes, closes its own task, creates the next-step task and rewrites the draft
to the client; the slot is cleared or replaced when the viewing did not
happen. Stages follow the thread and the broker, never the form. (The first
version moved cards by outcome and knocked three held viewings off the board.)

**The loop after the form (owner, 09.09: "чтобы не обрывалось").** The
white spot was the viewing; after the form the chain continues by itself:
- every later draft on that lead reads the filed report
  (`viewingReportPromptBlock` in `buildPromptAdditions`) — the client who
  rejected a villa for mould is never answered as if nothing happened;
- a next step of "New shortlist" / "Second visit" runs the ordinary generator
  with the report as the brief (`shortlistAfterViewing`), so the draft
  carries real villas that fix what they disliked; the plain composer is the
  fallback and may never promise links;
- an owner-side step ("Counter-offer to owner", "Deposit to hold it",
  "Contract") becomes a task on the LISTING card, for whoever holds that
  owner (Yudi), with the client's feedback — Amelia's step used to stop on
  her own card;
- the draft lands in PUSH stamped `viewing report filed` for the broker's
  approval; autopilot never sends it (Rental viewing stages are past the
  threshold). The human link is the approve — Liu's shortlist waited a day.
Verified 09.09 on a throwaway card with a seeded thread (lead_messages needs
`amo_message_id` and `direction`): 2 villas attached, text names both.
Backdate a report by hand:
`POST /api/admin/viewing-report-due?lead=&at=`. Viewings are counted from
reports. Verified end to end on a throwaway card 08.09: task created → report
filed → stage Negotiation done, report task completed, next-step task due
next morning, note on the lead, placeholder retired, Sonnet draft written.
The two task texts are deliberately NOT in `OUR_TASK_TEXT`: a client's reply
must not close "Fill the viewing report" — only the filed report does.

**Every held viewing gets a report (14.09).** Week of 07.09: 2 of 5. Why the
other three had none, and what holds now:
- one slot per card: `leads_sync.viewing_at` was overwritten by a second
  viewing, and the pass read only cards on "Viewing scheduled". Now every
  agreed slot is a `viewing_slots` row (stage sync, a broker's pick, a
  "rescheduled" report) and `processViewingOutcomes` reports each one 3 h after
  it, whatever the card's stage;
- a viewing agreed and held in a CLOSED card's thread (Remi, 23489993 closed
  07.09 while he was still writing; open card 23528439): `reportCardFor` puts
  the report on the client's open card in the same funnel (same contact, or
  same phone); with no open card it stays on the closed one and the task and
  push say "reopen it?". Never reopened automatically;
- `closeAmoTasksForLead` closed EVERY open task on any send or manual reply:
  Lorenzo's report task "Closed automatically" 10.09, Searra's "Counter-offer
  to owner" and Liu's "Second visit" likewise. The report task, "Next step
  after the viewing" and the listing-card step are `isProtectedTask` in
  amo-client: only filing the report closes the first, the broker the others.
  `viewing-report-due?lead=&at=&retask=1` re-creates a wrongly closed one;
- the villa is read from the messages that agreed the slot; "the last code sent
  before the slot" named the wrong villa in 2 of 3 reports. Unclear → empty,
  and the form asks for the code. Lorenzo's 09.09 report (created 10.09, before
  this) still said R-YUD-074, the Seseh villa he never saw; he viewed Uma
  Avaya, R-YUD-071 — corrected by hand 15.09;
- two viewings, two reports, one form (15.09): the card shows the newest due
  report, so filing Lorenzo's 12.09 report put the 09.09 one in the same place
  and Amelia read it as "the report I sent is still appearing". The payload
  carries `open_count`; the form says how many are open and the "filed" note
  says another one opens after the refresh;
- a next step "by today" filed after 10:00 was due in the past: `stepDue` puts
  it at 10:00 or 18:00 that day if still ahead, else three hours from now. mobile.ts trap, again: strings inside the page literal are written by
hand — a Python heredoc collapsed `\\'` to `\'` and the bare quote took the
whole page down for a minute; use `&rsquo;` in HTML strings.

### co-broke Agents is a silent archive (2026-09-07)

Owner: the stage exists so an intermediary's contact is not binned — a plan B
"при необходимости человек сам свяжется". Nothing is sent from it, no draft is
written for it (unanswered-live pass skips it, autopilot retires anything that
still lands there), the broker is not prompted. The only exit is the stage
engine deciding the counterpart is the owner. long term differs: replies to
the owner go out (a "free now" is answered and the card released); proactive
drafts there are retired. The dated re-confirm question is written when the
card leaves for TAKEN TO WORK two weeks before its date (next section).

### long term: the whole card and the owner's own date, or not parked (2026-09-15)

The owner's regulation after reading the 33 cards on the stage: 23 without a
price, half untouched for 8–12 days, Villa Mei (23369825) parked the minute WE
asked about availability, SWOI Loft (23298483) through five moves in 40 minutes
on 07.09. The engine parked on one extracted word, `stopKind: "occupied"`,
"date unknown" included, and a parked card never came back into the bot's cycle.

- **Entry needs all five** (`longTermBar`, listing-card-fields): lettable long
  term, the owner side, bedrooms, a price with its commission position, and a
  free date beyond the 90-day selling window that the villa side named ITSELF.
  The extraction copies their words (`free_from_quote`, carried across re-reads);
  `ownerSaidFreeDate` finds them in their own messages with quoted text removed.
  Short of any of the five, an occupied villa stays in TAKEN TO WORK and
  `meetsQualified` lists "free date", which the reply and the nudge ask ("Roughly
  from when will … be free again?" / "Kira-kira … kosong lagi mulai kapan").
  A far date with no stop word is the same villa. `minimum stay` never parks.
- **The record goes on BEFORE the move** (`ensureLongTermRecord`): "Listing:
  available from" (968835) as a date — `1 December 2026 — APPROX of the owner's
  "after November"` when they gave no day (`availableFromLine`; the card sync
  writes the same form everywhere) — and a task `Long term: …` due 10:00 Bali
  two weeks before the date, protected in `isProtectedTask` (a send used to
  close every task). Either failing, no move. After the move, the English note
  in the regulation's template with the owner's quote. A parked card whose date
  moves gets its field and task rewritten in place; a card parked before this
  gets what it lacks and a "Kept in LONG TERM" note.
- **Exit two weeks before the date, not at 90 days.** The engine used to release
  a parked card when its date came inside 90 days, so `long-term-check` almost
  never found one. Now the card holds until two weeks before; the engine moves it
  to TAKEN TO WORK, completes the task, and `writeAvailabilityCheckDraft` asks
  free-from-that-date and same-price, handed to autopilot like a nudge. The card
  then waits for the owner (`awaitingOwnerAfterLongTerm`) instead of riding
  months-old facts to QUALIFIED. The owner naming a near date, or "free now",
  still releases it at once.
- **One move per owner message**: an engine move is held when the engine already
  moved the card after their newest message, within 24 h. The date-driven exit
  is exempt.
- **Control** `GET /api/admin/long-term-control`: live amoCRM, four lists (no
  price 968831, no date in 968835, no open task due ahead, untouched 30+ days).
  Expected empty; the daily audit push carries the counts otherwise.
- Re-judge the stage: `POST /api/admin/listing-audit?stage=long%20term&refresh=1`
  (dry), `&apply=1`. `refresh` re-reads threads so old facts get the quote.
- Kept as it was: the 90-day line between "free soon, sell now" and long term
  (the regulation does not name one). Listing a long term villa on the site at
  once (property_availability from the free date to 2099-12-31) is the listing
  co-worker's step, skill `listing-prelisted-enrichment`, not code.
- Applied 15.09 (~14:50 Bali). A person had already closed 11 cards and returned
  10 by hand at 13:11, and the old engine re-parked three of those at 13:17 on a
  send. Of the remaining 15, 12 left: Villa Mei to co-broke (third party
  confirmed), Villa Wabu and ten others to TAKEN TO WORK (no owner price,
  commission, owner side or date of their own). Kept with date, task and note:
  Ersanea 23472139 (2 January 2027, their 5% not agreed), Villa Giulia 23473387
  (15 December 2026), Villa Selah 23518847 (1 January 2027, APPROX). Control
  afterwards: 3 cards, four empty lists. The other actor's "WAKE-UP for …" tasks
  on the same days were left alone; the old engine's "Villa frees up around …"
  tasks on the parked cards were completed as superseded.

### Listing stage engine (2026-09-07, evening)

`lib/listing-stage-engine.ts` is the ONLY code that moves a listing card
between Initial Contact, TAKEN TO WORK, long term, co-broke Agents,
Closed-lost (by facts) and QUALIFIED (arrival). `desiredStage(facts,
signals)` is pure; `reconcileListingStage(leadId)` applies it, idempotently,
from three triggers: a reply generated (with the facts just extracted), a
message sent (signals only, no model call), and the daily audit
(`maybeRunDailyListingAudit`, after 09:00 Bali; broker gets a push with his
cards whose facts disagree). Closes and co-broke parking pass a focused
second opinion first (`confirmsNotOurFormat`, `confirmsThirdParty`), a parked
card leaves only on positive evidence. The classifier returns null for this
funnel; `promoteIfQualified` / `routeUnqualified` / `releaseFrom*` are gone.
Audit by hand: `POST /api/admin/listing-audit` (dry), `?apply=1`, `?lead=<id>`.
Two time-driven closers stay outside: three unanswered nudges, no WhatsApp.

### One broker, two WhatsApp numbers (2026-09-13)

The owner gave Yudi a second WhatsApp (WAhelp "Yudi 2", amoCRM source
62585) to get a second daily nine of first contacts in Rental Listings. The
co-worker still creates every card on Yudi — the NUMBER is not the
responsible user, it is field 967477, and it is decided at the send:

- `BROKER_LINES` in `amo-messenger-field.ts` lists a broker's lines, primary
  first (`yudi: [59537, 62585]`). `sourceIdForBroker` is the primary.
- The budget is per LINE (`lineBudgets` in `new-contact-budget.ts`), billed by
  `sent_messages.source_id` on a lead's first send; unstamped rows (before
  13.09) or a line that is not the broker's go to the primary. A new line is
  warmed up: 62585 gets 3 a day on 13–15.09, 6 on 16–18.09, 9 from 19.09
  (`LINE_WARMUP_START`). `mayOpenNewConversation` is ok while ANY line has
  budget. Read it live: `GET /api/admin/line-budget?broker=Yudi`.
- `resolveSendChannel` → `resolveMultiLineSource` for a broker with 2+ lines:
  a conversation on one of the broker's lines (amoCRM talks, then our stamped
  send) stays there; a first contact takes the first line with budget left;
  the chosen id is written into 967477 and a failed write refuses the send.
  A conversation on nobody's line of the broker falls back to the old rules.
- **PAUSED the same day.** The first three sends routed to 62585 (13:20,
  leads 23549089 / 23549083 / 23549081) never reached WhatsApp: field 967477
  and the text field were written, Salesbot answered 200, but no type-90
  outgoing event and no talk appeared (a send on 59537 shows both within a
  second). `BROKER_LINES.yudi` is back to `[59537]`; re-enable only after one
  send on 62585 is seen in a lead's timeline. A 200 from the Salesbot trigger
  is not delivery.
- **Re-enabled ~15:00 the same day.** Cause of the loss: Salesbot 22127
  branches on field 967477 per source id (step 0 conditions → one
  `send_external_message` block per channel) and had no branch for 62585. The
  owner added a "Yudi 2" Message block but wired it to "None of the
  conditions", not to a 62585 condition; the old fallback (step 27, routing
  Instagram/Facebook by `{{messenger}}`) is now orphaned and its send blocks
  lost their channels on that save. So `resolveSendChannel` refuses any source
  that is not in SOURCE_MAP — otherwise a stale Instagram id in the field would
  go out from Yudi 2's WhatsApp. The three lost sends were re-keyed to
  `lead_id = 'undelivered-62585:<id>'` (budget ignores `undelivered-%`), their
  drafts put back to pending. Adding a line = SOURCE_MAP + BROKER_LINES + a
  Salesbot branch, and a first send checked for a type-90 event in the lead's
  `/ajax/v3/leads/{id}/events_timeline`.
- **Delivers, but held for new contacts (15:40 the same day).** After the
  re-enable six first contacts left on 62585 and all six show a type-90 event
  and a 62585 talk — Salesbot routing works. But four got WAhelp's
  "На данном номере не установлен whatsapp" within a second, all ordinary
  Indonesian mobiles, where Yudi's first line saw 0–3 such notices on 9–13
  first contacts a day for a week. `live-reply-debounce` → `closeUndeliverable`
  closed three of them as lost (23555637, 23549071, 23537919; 23549075 still
  open). `NO_NEW_CONTACTS` in new-contact-budget.ts gives 62585 a cap of 0; its
  two live conversations (23549077, 23549073) stay on it. Before lifting: find
  out whether a fresh WAhelp line reports numbers it cannot resolve as "not
  installed" (resend one of the four from 59537 and see if it arrives), and do
  not let a line-2 notice close a card until then.
- **Re-test from line 1 (owner, 14.09).** `POST /api/admin/line-retest?lead=&line=59537[&apply=1]`
  repeats a card's first message from another line, only for a card that
  carries the not-installed notice; stamped kind `line-retest`, no stage/task
  changes. Run on 23549075, 23555637, 23549071, 23537919. Arrives from 59537 →
  line 2 misreports and needs fixing in WAhelp; notice again → the scout picks
  numbers without WhatsApp.
  **Result 14.09 10:13:** both are true. Mai Villa (23549075) and Villa Putih
  Berawa (23555637) got the notice again from 59537 — no WhatsApp. Villa Oasis
  (23537919) was DELIVERED from 59537 (`delivery_status` 1) — Yudi 2's notice
  was false. Tahuri Villa (23549071): no notice, still `delivery_status` 0 after
  5 min — undecided. Read type-90 `data.delivery_status`: 0 sent, 1 delivered,
  2 read (line 1's first contacts of 13.09: 19 read, 8 delivered). 62585 stays
  held for new contacts until WAhelp explains the false notices.
- **PROJECT PAUSED by the owner (14.09):** "пока как было, один номер" — new
  technical issues, not a priority now. `BROKER_LINES.yudi = [59537]`; every
  Yudi send (first contacts and replies) goes from 59537, and a card whose
  field still says 62585 is switched back to 59537 by the reassignment guard.
  Kept in place: SOURCE_MAP 62585, per-line budget code, the SOURCE_MAP guard
  in resolveSendChannel (Salesbot's "None of the conditions" exit still sends
  via Yudi 2), `line-retest`. To resume: WAhelp explains/fixes the false notices,
  then `[59537, 62585]` and drop 62585 from `NO_NEW_CONTACTS`.
- Two traps that made the second line reply from the first: the timeline sync
  wrote the line NAME into 967477 and `mapNameToSourceId` prefix-matched
  "Yudi 2" as "Yudi"; and the reassignment guard compared names, so "Yudi 2"
  on a Yudi card looked like a handover. Known lines are now written as ids,
  names match longest first, and the guard compares lines.

### The villa side hands us another number (2026-09-12)

The owner, looking at old listing conversations that never qualified: "так
переделывай номер в карточке и пиши владельцу, в чём проблема? бот может?"
Fourteen open cards ended the same way: reception, a manager or a wife
answered "prices are with the owner, here is his number", the bot replied
"I'll reach out to him directly", and nobody did, because nothing here could
open a conversation with a number that was not on a card. Among old contacts
that talked to us it was the largest single dead end.

`lib/listing-referral.ts`, called from `generateListingAcquisitionReply` after
a reply whose text can hold a hand-off (regex gate: a shared contact card, or
a phone number next to contact/owner/partner/husband/hubungi…), then one Haiku
call for {name, phone, role, referrer, evidence}.
- **The number is not swapped on the old card.** The WhatsApp chat belongs to
  the number it was opened with: Salesbot on that card keeps writing to the
  staff member, and a contact with two numbers can fan one send out to both.
  The referred person gets their own card: Rental Listings, Initial Contact,
  tags Yudi / SRC:AI / Referral, a PROPERTY note and an ACTION BRIEF carrying
  `REFERRED BY` — the notes the seeding pass already reads. The ordinary path
  does the rest. The source card gets a note and `bot_excluded`.
- **Guards, all in code:** the phone must appear in the villa side's own
  messages; it must differ from the card's number; the role must be owner,
  family, partner or the villa's own manager (reception, sales and booking
  teams, agencies get no card: CHANGED the same day, see below); a number
  already on a Rental Listings card is
  linked by notes on both cards instead; a card whose stage amoCRM does not
  show as Initial Contact / TAKEN TO WORK / long term is left alone; and a
  broker message after the hand-off blocks a new card (Villa Soluna: Yudi had
  written to the manager himself on 20.08 and the listing is online). One
  hand-off per source card (`broker_settings` `listing_referral:<id>`).
- **The opener** follows rule 1R in the listing prompt: name who passed the
  number on and the villa, and ask the price with our 10%, the minimum stay
  and the viewing day in the first message. `realName` never lets a line label
  ("villa") or a desk ("Reservation Team") stand in for a person — the first
  card's brief read "say that villa from [OWN] Villa Platano passed on this
  number" — `cleanVillaName` strips the scout's bracket tags, and
  `greetingName` keeps "Pak Damien" whole. **Read every new card's notes before
  the seeding pass does**; the first one was seeded within minutes and had to
  be corrected in `leads_sync` as well as in amoCRM.
- **The send is a first contact:** inside the nine-a-day budget, first in the
  drain order (`lead_notes ILIKE '%REFERRED BY%'`).
- Backlog tool: `POST /api/admin/listing-referrals` (dry), `?apply=1`,
  `?lead=<id>`.

Applied 12.09: three cards opened (Villa Platano → Ignasi, owner, +34; The
Lakou Villas → Pak Damien, partner; Villa Daze Bali → Galang, the owner's
husband, the corrected number ending 037), openers written and waiting for the
13.09 budget; five linked (Nordoy → Marc, already on #23361369 in Details;
Villa Gloria → Dewi, #23509143; Casa Petak → Petr, #23519703; Villa Bens
Bidadari and Villa Arts Cherry → Dr Benny, #23519425); six not opened (sales
teams, staff, "the PIC"). The owner's answer to that was "почему??", and he
was right: the complaint was that nobody wrote to whoever we were sent to, and
the villa's own sales team, reception or manager is the villa side (the 08.09
standard counts them as entitled to let it). Every role except a self-declared
agency now gets a card; a third party is found by the conversation and parked
in co-broke by the engine's second opinion, as for any other card. Opened the same
day: The Santai, Aquamarine Villas, Villa Vedas Bali, Villa Toro and Villa
White Nest; Marisa's number was already on #23519405 and was linked. With the
three earlier ones, eight referral openers take the first eight places of the
13.09 budget of nine. The scout also separates card names with a long dash and
puts brand tags in brackets, and a contact card's name can read "Jeany (Sales
Manager) Amelia" or "IKE": `nameParts`, `cleanVillaName` and `realName` handle
all three, and the first five briefs were corrected by hand before seeding.

### The owner nudge ladder read a stale column (2026-09-12)

The owner: "за сутки всего одна новая квала — в чём проблема делать больше
квалов?" The top of the funnel was fine: 158 contacts in 14 days, 110 owners
replied, 18 reached QUALIFIED — about one a day at nine new contacts a day.
The fixable leak was in the middle. `processListingOwnerFollowup` skipped
every card whose `leads_sync.last_message_from` was "lead", and that column
keeps "lead" after the bot answers — the send path stamps
`last_our_message_at` only. An owner who answered part of the qualifying
question, got the bot's reply and went quiet was never asked again: 35 open
cards (28 in TAKEN TO WORK) had nudges blocked, eleven of them silent on our
side since 05–06.09. The pass now reads who spoke last from `lead_messages`
(the column is only a fallback for an unlogged thread) and measures silence
from our latest word in either record — a reply typed on the phone is in the
thread only. Checked before deploy: 29 cards due round 1, none at the
three-nudge close, and an owner's reply resets the ladder (`amo-timeline-sync`,
`amo-sync`, the webhook).

**A minimum stay in nights is an answer.** `min_stay_months` was defined in
months only, so "Minimum stay is 7 days" (Villa Luna Kedungu) and "our minimum
stay is 3 nights" (Salt Villa) were stored as null: the card could never pass
the bar, and the first nudge after the 12.09 fix asked that owner again — "I
have mentioned it multiple times previously". A minimum under a month now
extracts as 1.

**Two qualification standards exist, and they disagree.** The listing manager
(Cowork, skill `listing-qualification-standard`) follows the owner and
Amelia's decision of 08.09: a price floor per bedroom (1BR 25M, 2BR 35M, 3BR
45M, +10M per bedroom, showcase price with our 10%), QUALIFIED = bedrooms +
price with the commission position, minimum stay and exact availability
collected in Details. The engine here uses a flat 33M floor (owner, 05.09)
and requires minimum stay and earliest viewing for QUALIFIED (owner, 07.09).
On 12.09: the agent closed Villa Matahari (3BR, ~31M) that the engine had
reopened as QUALIFIED; two current quals (Mimoza 2BR 33M, 23263701 3BR 39M)
fail the per-bedroom floor; four TAKEN TO WORK cards meet the 08.09 bar and
are held only by minimum stay or viewing. Which bar wins is the owner's
decision — never align either side silently.

### The autopilot check of 11.09: what "тупит" looked like

The owner: "проверь как автопилот работает вчера, сегодня и двигает карты по
этапам до квалификации, не тупит ли". Volume was fine (10.09: 65 bot
messages, 92 owner messages in, 10 first contacts; 11.09 by 13:00: 52 / 57 /
12, three of them to numbers without WhatsApp — the budget of 9 held, and two
drafts held at 10:00 went out at 10:10 once those notices landed, by design).
Most moves were right; five faults, all in `listing-stage-engine.ts`:

- **A first contact stayed in Initial Contact until the next morning.** The
  send trigger counted our messages in `lead_messages`, where a send lands
  only when the sync picks it up (15 minutes later on 11.09). It now also
  counts a `sent_messages` row from the LAST HOUR — only a recent one: Asta
  Villa (23213343) has four sends since 17.08 and not one message in its
  thread (no reachable number), and an old undelivered send is not contact.
- **Every move was written twice.** The reply trigger and the autopilot's send
  of that reply judged the same old stage in parallel: two amoCRM writes, two
  stage events, two paid second opinions. `reconcileListingStage` is
  serialised per card; the second call reads the stage the first one wrote.
- **A card closed on a quote the owner then withdrew stayed closed.** Villa
  Mimoza (23519133): closed at 14:38 on 32M in the same minute the bot
  counter-offered 33M; the owner accepted 33M at 15:12 with a viewing date,
  and nothing looked — a closed card was never judged again. A card the
  ENGINE closed (last stage event by `engine:*`) is now re-judged when the
  owner writes after the close, and reopened if the facts say so. A person's
  close is never reopened. Mimoza went back to QUALIFIED on 11.09.
- **The price floor closed a live negotiation.** A live trigger no longer
  closes on the floor; the daily audit does, once the owner's last word is
  18h old and the quote still stands.
- **Long term released on "Alright 🙏".** Leaving long term needs a free date
  inside the window, or availability the owner stated (`availableFrom`)
  since the card was parked. Villa Solis (23528529) flapped on a thinner
  extraction that happened to leave the tenant out.

Tried and withdrawn the same day: a rule that a stop signal must appear in the
owner's own words. It rested on a misread — Balay Villa's "We already have a
full booking" looked invented because the query cut each message at 220
characters, and the owner had written it after a `>>` quote in the same
message. The rule then dropped a real stop on 23378987 that the extractor had
rendered in English from Indonesian. **Read the whole message before calling
an extraction invented: in `lead_messages` a WhatsApp reply is stored as
`>> quote⏎reply`, and `left(text, N)` hides exactly the reply.**

### The owner is never asked twice, in Yudi's words (2026-09-14)

The owner, relaying Yudi after he spoke with several owners: autopilot messages
read "как будто робот с тобой общается", with "повторные, однотипные вопросы…
там, где уже ответили".

**Measured, 14 days.** 1,160 auto-sent owner messages; the 574 with a question
and an earlier owner message were judged against the thread before them
(Haiku), and every flagged repeat was re-checked strictly (Sonnet: does our
message ASK it, did the VILLA SIDE answer it). 56 messages on 36 cards re-asked
what the villa side had answered: 35 of 301 nudges (12%), 19 of 838 AI replies
(2%), 2 of 21 older AI pushes. By point: who they are 18, still for rent 15,
commission 14, price 12, minimum stay 12, availability 9, bedrooms 6, viewing 6,
photos 3. Worst: Villa Yoshi (12.09), Ersanea (09.09, 13.09), Gelareh (09.09),
Villa Amor (08.09) got the whole checklist after giving price with our 10%, the
free date, the minimum stay and a viewing time. The Haiku pass alone flagged
220; it counts statements ("since you manage it") as questions — never report
a single-model count.

Causes, one per writer:
- **The nudge template asked everything when it had nothing to ask.**
  `asks.length === 0` fell back to "are you still looking to rent it out? … the
  number of bedrooms, the monthly and yearly rate…, the date…, the minimum
  stay…, the earliest day…" — on cards with nothing missing, on a floor or
  commission-terms note, and on a failed extraction.
- **A `null` fact is "missing".** The extractor leaves null what it cannot read
  ("3 nights", "tidak ada mininum", USD/EUR, "I just manage these properties",
  a bare "Yes" to our commission question), and `meetsQualified` lists it.
  14 of the 18 "who are you" repeats were nudges to people who had said who
  they are.
- **The reply prompt's "already answered" list came from the same facts**, and
  nothing checked the finished draft.

**Style, measured.** Yudi's phone messages to owners (30 days, 390 lines,
Amelia's filtered): 8 words median, 40% two or three short lines, kak 19%,
pak/bu 19%, a plain 🙏 12%, openers "Baik", "Thank you", "Selamat siang",
"Hello". Auto-sent owner messages: 48 words median, 2% multi-line, "including
our 10% agency commission" 32%, "that's everything we need" 29%, "clients" 41%
(Yudi 11%), "Hi" 43%. The model copied the prompt's example sentences; no line
Yudi typed reached the owner-facing prompt (his lessons did, `owner_intake`).
Language was already right: 3 of 95 Indonesian threads were answered in English.

**What changed.**
- `lib/owner-thread-known.ts` — ONE check before anything asks an owner. A
  point is KNOWN when the facts have it OR the villa side's own words answer it:
  the `>>` quote and our own pasted text removed, their questions and promises
  ("will send the commission details") not counted, a short yes/no straight
  after our one-point question counted. Fail-safe towards not asking.
  `stripRepeatedAsks` cuts a repeated question from a finished draft; price and
  commission asked together are one question, repeated only when both are
  known; a counter-offer, asking the other period, a concrete visit time, and a
  re-ask after a failed send are not repeats. `removeRepeatedAsks` adds one
  Haiku rewrite for a sentence mixing known and open points; `guardOwnerDraft`
  is the no-model gate.
- **Reply generator** (`listing-acquisition-prompt.ts` — both generateSuggestion
  copies, handover, retouch and requalify call it): the ALREADY GIVEN block
  from the shared check, STILL MISSING minus what the thread answers, the
  finished draft checked (a draft of nothing but repeats is written once more,
  else no draft — callers skip empty text). Literal sentences removed from the
  prompt (the one-sentence checklist, "that's everything we need", the quoted
  three-option and coordinator questions); the moves and the business rules
  (price with our 10% in the same sentence, three options, viewing day) stay.
  A facts-only not-our-format decline now needs `confirmsNotOurFormat`
  (fail-closed): the replay showed "Maximal 3 bulan saja" at 37 juta a month
  read as short stays only. `replayAsOf` writes the draft as of a moment and
  writes nothing anywhere.
- **The voice**: `lib/owner-voice.ts` on top of `lib/yudi-voice.ts` (the one
  reader of Yudi's phone lines, shared with inspection booking): his lines in
  the owner's language first, what he sent in place of drafts he rewrote (his
  text only, never the draft), and the measured shape. His lessons follow and
  win. No example sentence of ours.
- **Nudge ladder** (`listing-owner-followup.ts`): `nudgeAsks` — never replied:
  still for rent + who they are; replied: only open qualification points; no
  facts readable: nothing; a commission rate of their own: nothing (the
  broker's call); nothing open: no nudge, the ladder does not advance, and the
  thread state is memoised so the 5-minute pass does not re-extract. Still no
  AI: fixed EN/ID lines in the owner's language, Yudi's own phrasings ("May I
  know…", "May I double check if the price is already included with our 10%
  agency commission?", "Untuk harganya apakah sudah termasuk 10% komisi agensi
  ya kak?"), a greeting line and "Thank you"/"Terimakasih". No "we have clients
  searching in the area right now", no closing formula.
- **Long-term availability check**: the same asks and register; photos and pin
  only when not already sent.
- **Autopilot** (`autopilot.ts`): `guardOwnerDraft` on every Rental Listings
  draft before it is sent, whoever wrote it; a cut is logged ("autopilot: owner
  draft re-asked what the thread already answers"), a draft of nothing but
  repeats is retired. It runs before the handover stage only, so the weekly
  availability check on live listings ("is it still available?") is untouched.

**Before changing any of it**: replay on real past cases, read-only —
`src/scripts/replay-owner-drafts.ts` bundled in a worktree (never
`/opt/whatcan`), cases `{kind: reply|nudge, leadId, asOf, old}`. The detector
alone (no facts) catches 42 of the 56 confirmed messages; the facts cover most
of the rest.

**Replay before deploy (14.09, 18 cases: the 10 worst confirmed repeats, 3
confirmed AI-reply repeats, 5 recent replies for style), judged by the same
strict Sonnet check as the analysis.** Old drafts with a repeated question: 12
of 18; new: 1 — Yanti's price negotiation ("would you be able to meet 30
million?"), a counter-offer the old draft made too, not a question she had
answered. Six of the ten worst nudges now send NOTHING (Villa Yoshi, Ersanea,
Gelareh, Umbala, Ayucandra, Buduk Dua: everything open was answered, or their
own commission rate is the broker's call); the others ask only what is open —
"Hello / For Villa Amor Pererenan, may I know the number of bedrooms? / Thank
you", "Selamat sore kak / Untuk Villa Tapeni, boleh di bantu info harga sewa
bulanan dan tahunan yang sudah termasuk 10% komisi agensi, minimal sewanya dan
kapan kami bisa bawa client untuk lihat villanya ya kak? / Terimakasih". Words
median 65 → 31 on the repeat cases, 48 → 34 on the style cases; "that's
everything we need" 11 → 0, "clients searching in the area" 10 → 0.

**Live after deploy (9d1cbdf, 14.09 10:52 server time).** In the first 20
minutes two owner messages went out on their own, both on 23369845 in
Indonesian, both judged by the same strict check: no repeated question
("Terima kasih pak fotonya, sudah kami terima ya. / Untuk komisi nanti
dikonfirmasi lagi oleh tim kami. Ditunggu kabarnya untuk unit yang available
setelah awal Oktober ya pak 🙏"). They are also two replies a minute apart to
two photo messages, an older shape this change does not touch. To keep
checking: auto-sent Rental Listings rows in `pending_suggestions` after the
deploy, thread from `lead_messages` before each, and grep the log for
"autopilot: owner draft re-asked", "a question the thread already answers was
cut" and "nothing left to ask".

**A deferred price is an answer (14.09, the third live message).** Petr
(23519703, Casa Petak) wrote on 09.09 "rates depend of duration and saison"
and on 13.09 "Once you have real client - dates - and decided Villa we can
talk about rates", after "You send me the message alredy twice". The first
deploy's reply at 11:23 still asked "monthly and yearly pricing for the three
options including our 10% commission": the strict judge called it no repeat
(no price was ever given), the owner would not. `PRICE_DEFERRED` now marks
price and commission known on such a line; the broker asks again by hand.
Replayed read-only before the second deploy: the reply became "Whenever it's
free next month, let me know so we can arrange the inspection", the Villa
Yoshi and Villa Tapeni controls unchanged.

### A stage a card can neither enter nor leave (2026-09-10)

The owner: "что с нашим автопилотом, где мои листинги?" Nothing had reached
QUALIFIED (Pre-listed) on 09.09 or 10.09, while the top of the funnel kept
working normally (13 new owner cards contacted that morning, 36 replies in).
Two engine faults, both invisible from the board:

- **The occupied deadlock.** `desiredStage` parks a villa in long term only
  when it is occupied AND does not free within 90 days; a villa that frees
  sooner falls through to the bar — where `meetsQualified` then blocked it on
  the very same "occupied" stop signal. So a card that frees soon could not be
  parked (it frees soon) and could not qualify (it is occupied): five cards
  with a complete data set sat in TAKEN TO WORK, 23204741 among them (2BR,
  45M incl., min stay 12, free 1 October). Only `not_our_format`, or an
  `occupied` that is NOT `freeSoon`, blocks the bar now. **Any condition that
  both routes a card away and blocks its promotion has to be read in one
  direction only — check both when adding one.**
- **A send judged on empty facts.** `reconcileListingStage(facts: null)` — the
  send path, "signals only, no model call" — was handed `emptyFacts()`, which
  says "nothing about this villa is known", not "do not re-read". Every
  message we sent therefore re-judged a complete card as "not yet: bedrooms,
  price, minimum stay…" and pulled it back to TAKEN TO WORK: 23518851 and
  23519135 flapped Initial Contact → long term → TAKEN TO WORK → long term →
  TAKEN TO WORK inside ten minutes, and no card could have held QUALIFIED
  past its next message anyway. The last facts read now stand on a send; with
  nothing ever read, a send judges nothing. **`null` means "unread", never
  "empty" — a judgement on absent data is not a judgement.**

Fixed and applied 10.09 (`POST /api/admin/listing-audit?apply=1`): 4 cards to
QUALIFIED, 2 parked in long term, 4 Initial Contact → TAKEN TO WORK; the board
went 11 → 15 pre-listed. What remains is a data gap, not a bug: 44 cards where
the owner is talking but the card still lacks price, minimum stay or earliest
viewing — half of those threads predate the 07.09 bar and were never asked.
The owner-nudge pass asks exactly the missing fields (`meetsQualified().missing`
in listing-acquisition-prompt) on its own cadence.

### Listing funnel: one owner per stage, stages move on data (2026-09-07)

The owner's audit of stage history: five cards reached Details on a friendly
reply ("will be happy to discuss"), with no price on the card; three of them
passed QUALIFIED in under five minutes. Then QUALIFIED cards flapped back to
TAKEN TO WORK minutes after promotion (Casa Ola x4, Menuai x3, Bumbak x3):
the classifier was barred from SETTING rule-owned stages (04.09) but could
still LEAVE them, and a draft classified before the bar still carried "Details"
in `suggested_stage` and approve applied it at send time. Canon now:

| Move | Only owner |
|---|---|
| Initial Contact → TAKEN TO WORK | first message out (outreach / classifier) |
| TAKEN TO WORK → QUALIFIED | `promoteIfQualified` (`meetsQualified`: owner, bedrooms, price with commission position, min stay, earliest viewing, ≥33M client-facing) |
| TAKEN TO WORK → co-broke / long term / Closed-lost | `routeUnqualified` (floor first, then counterpart, then occupied, then not-our-format with second opinion) |
| long term / co-broke → TAKEN TO WORK | `releaseFromLongTerm`, `releaseFromCoBroke` |
| QUALIFIED → Inspection sceduled (id 87763170) | `listing-progress.ts` `extractAgreedVisit`: a visit to the villa agreed for a concrete day (2026-09-14; the ask for it is `inspection-booking.ts`, drafts for Yudi) |
| TAKEN TO WORK / QUALIFIED → Inspection sceduled → live; Inspection sceduled → live | the site's Pre-listed → Listed switch (a person's act), applied by `listing-status-pass` (2026-09-14) |
| ~~QUALIFIED → Details ased (87763166)~~ | the stage was DELETED by the owner on 14.09.2026 15:02; nothing sets it; old events alias to QUALIFIED |
| anything else into live, every exit from live, every move back | a person |

The classifier on this funnel may only pick Initial Contact / TAKEN TO WORK and
returns null when the card is already beyond them (`classifyStage`); approve
refuses a classified rule-owned stage even from an old draft
(`isRuleOwnedAcquisitionStage`); a person's explicit choice always wins. amoCRM
`/api/v4/events?filter[type]=lead_status_changed` is the audit trail — our
`stage_events` misses the bot's own closes.

### Inspection scheduled follows the thread (2026-09-14; Details asked removed the same day)

Owner, 14.09: two metrics, Pre-listed and live; Yudi takes qualified cards to
live; inspections happen offline and what the thread shows is enough. He
renamed the stages the same day: **87763166 "Details" → "Details ased"**
(DELETED at 15:02, see below), **87763170 "Inspection. done" → "Inspection
sceduled"** (his spelling; read names from `GET /api/v4/leads/pipelines/11180334`,
never assume them). The section "Inspection. done: the agent has been to the
villa" is SUPERSEDED: that stage now means a visit is agreed, not held.

**One rule, `lib/listing-progress.ts`** (`advanceListingProgress`), called from
`syncStageFromThread` for a listing card whose stored stage reads qualified /
inspection — so every path `onThreadChanged` covers: approve and autopilot sends,
the timeline sweep (phone), amo-sync's outgoing feed, incoming detection, quick
poll, the webhook. Their gate is `threadWatched(pipeline)` (Rental + Rental
Listings); `threadDrivesStage` keeps its Rental meaning. Also once a day after
the listing audit (`auditListingProgress` in `maybeRunDailyListingAudit`, QUALIFIED
and Inspection sceduled cards). Stages are ids (`LISTING_STAGE.INSPECTION_SCHEDULED`
in listing-status-week.ts; `DELETED_DETAILS_STAGE_ID` only labels and ranks old
events), the card's status is read from amoCRM, never leads_sync.
- **Window.** "Since qualification" = the first arrival in QUALIFIED at or after
  07.09 12:00 Bali (the engine era; before it QUALIFIED was set loosely and
  flapped), else the latest arrival, minus 5 minutes (the qualifying reply and
  the move land in the same minute). From amoCRM events.
- ~~Details asked (`findDetailsAsk`)~~ — removed with the stage (14.09, evening).
- **Inspection scheduled** (`extractAgreedVisit`): only when the thread mentions a
  visit or a time; one Haiku call for the most recent visit to the villa by our
  side (Yudi, Amelia, with or without a client) that BOTH sides agreed for a
  concrete day; open offers ("any time", "from 13 Sept"), ranges ("around the
  21st"), unanswered requests and cancelled visits are null. The quote must be
  found in the thread; a visit held before the window is ignored. Scheduled is
  enough — a held visit counts too. QUALIFIED goes straight to Inspection sceduled.
- **The date is computed in code, not by the model (14.09, evening).** 23555645:
  the owner wrote "You can visit the property on wednesday pm" on Monday 14.09, the
  model returned Thursday 17.09, the second opinion said no, and the card stayed in
  QUALIFIED. The transcript lines are numbered; the model returns only `day_line`
  + `day_words` (verbatim), `settle_line`, and the time; `resolveDayWords` turns
  the words into a date against the Bali date of their line — explicit dates
  ("15 September", "tgl 13", "13/9", "the 21st"), then today / hari ini, besok /
  tomorrow, lusa, then weekdays EN/ID (next one on or after that day; "next" /
  "depan" skips the same day; "minggu depan" = next week, not Sunday → no date).
  Words not found in their line or not resolving → no visit.
- **A changed time on a card already in Inspection sceduled** (a reading settled
  after the slot on record and ≥ 30 minutes away, or a clock time where there was
  none, confirmed by `confirmAgreedVisit`): a new `listing_inspection_slots` row,
  the old one `status = 'rescheduled'` + `superseded_at`, a note on the card, the
  calendar pass queued. No stage move.
- **Forward only.** A card a person moved back (amoCRM event from a later stage
  into the current one) is not moved again on evidence older than that move.
  TAKEN TO WORK, parked, closed and live cards are never touched (TTW with an
  agreed visit is only reported: `?taken=1`).
- **Writes** amoCRM status first; then `stage_events` (responsible_user = the
  card's broker from leads_sync, like Rental's thread sync — the daily report
  counts `responsible_user = <broker>`, so the first rows, written as
  `engine:listing-progress:*`, showed Yudi 0 inspections and were re-attributed
  the same day), `leads_sync`, a note with the evidence, and for a visit a
  `listing_inspection_slots` row (created at boot).
- Tools: `POST /api/admin/listing-progress` (dry; `?apply=1`, `?lead=`,
  `?taken=1`); `POST /api/admin/listing-progress/move?lead=&to=inspection&evidence=&visitAt=&apply=1`
  for a hand-checked move the thread rule cannot see (a duplicate card;
  `to=details` answers 410). Log line: `listing-progress decision`.
- **What reads the stages now:** the reply generator reads the amoCRM status id
  — on Inspection sceduled it says a visit is SCHEDULED (with the slot), talk
  about time/access, never re-ask what the owner gave, never imply we have been
  there (until 14.09 it said "OUR AGENT HAS ALREADY INSPECTED THIS VILLA"); on
  QUALIFIED it carries the inspection booking block (next section). The daily
  report's `inspections` = arrivals at 87763170, label "Inspections scheduled";
  `STAGE_ALIASES` maps "details" / "details asked" / "details ased" to
  "qualified" (a move into or out of the deleted stage scores as none).
  `/api/public/inspections` finds the stage by id, returns `meaning` per arrival
  (agreement / inspection done / inspection scheduled) and the agreed slot.
  Owner nudges run only on Initial Contact / TAKEN TO WORK (since 14.09 evening).
  Autopilot is unaffected: its threshold is QUALIFIED (exclusive), so QUALIFIED
  and everything after were already the broker's.

**Dry replay before deploy (14.09).** The first version read 13 agreed visits
and 6 were wrong: open offers ("U can come to check before 13tg", "visit on 15
September is possible", "Bsk bisa di cek"), the owner's own photoshoot, "around
the 21st", an unaccepted "October 13 at 2", a client viewing held before
qualification. Hence the guards: visit at or after the window, a settling line
no older than a day before it, and `confirmAgreedVisit` (one yes/no, fail-closed).
A sentence about price that names a visit goes to the model, not the rule.

**Backfill 14.09.2026, applied 14:56–14:57 Bali** (amoCRM events confirm each):
QUALIFIED → Details ased: 23299227 Namaste, 23388973 Sunny Village, 23497759
Yoshi, 23263701 Adels, 23481615 Menuai, 23260811 Tatkala, 23550763 Aquamarine
III, 23434747 Di Villa, 23528517 Castillo, 23283693 Forest Bloom, 23426777 Luna
Kedungu. QUALIFIED → Details ased → Inspection sceduled: 23299197 Uma Avaya
(09.09 13:00), 23528515 Ma'Wa (11.09 12:00), 23426747 Tilu (13.09 after 14:00),
23541159 Umbala (14.09 11:00). By hand through `/move` (the rule said Details
only): 23549891 Villa Daze (15.09 before 11:00 — the second opinion rejected
"besok saya ke lokasi sebelum jam 11" + "betul nggih") and 23305115 Umbala (the
visit was agreed on its duplicate 23541159). Live, right after the deploy:
23555649 The Cahaya Villa → Details ased (source phone+amo-outgoing-event).
Stayed QUALIFIED: 23378953, 23204741, 23509251, 23223641, 23518853, 23519133,
23389387, 23426759 (Salt: "the 16th works" answered by the bot on 11.09, before
qualification; no ask since), and the Details cards 23361369, 23462331, 23339527,
23497771 (no agreed visit). TAKEN TO WORK with a visit, not moved: 23347975
Aquamarine (25.09), 23550771 ("visit kosong tgl 15 Oktober", reads as an offer).

**The owner deleted "Details ased" at 15:02 the same day.** amoCRM events: the
Admin account (11230386) flicked Elara 23497771 to Inspection sceduled and back
(14:58), moved the four cards that were in Details before the backfill
(23361369, 23462331, 23339527, 23497771) to QUALIFIED by hand, then deleted
status 87763166. The funnel is now QUALIFIED (Pre-listed) → Inspection sceduled
→ live. amoCRM dropped the 14 cards the backfill had put in Details into
**Initial Contact without a status event** — the stage engine owns Initial
Contact and, on the 15:10 sends, moved four back to QUALIFIED by facts
(23388973, 23497759, 23260811, 23283693). Rule 1 is dormant while the stage is
absent (`hasDetails` from the live funnel; a PATCH to a deleted status is a 400
"NotSupportedChoice", which is how it showed); a visit moves QUALIFIED straight
to Inspection sceduled. Repair: 23263701, 23426777, 23434747, 23528517,
23550763, 23555649 by `listing-audit?lead=&apply=1` (engine → QUALIFIED);
23299227 Namaste and 23481615 Menuai — the engine would have put them in TAKEN TO
WORK, below the QUALIFIED they held since 05–06.09 — by
`POST /api/admin/listing-progress/restore?lead=` (`restoreFromDeletedStage`: a
card whose last event put it in a status that no longer exists goes back to
that event's `from`). **A deleted stage moves cards with no event and hands
them to whatever owns the first stage: check `/leads/pipelines` before and
after any backfill into an owner-configured stage.**

**The rename trap, again.** A stage rename keeps the id and silently breaks
every string match: 09.09 ("agreement" → "Inspection. done") and 14.09. On a
rename grep for the old AND new name and the id in: `STAGE_ORDER` /
`STAGE_ALIASES` / `isInspected` / `isListingWon` (daily-report), `OPEN_STAGES`
(listing-owner-followup, substring), `RULE_OWNED_ACQUISITION_STAGES` and
`LISTING_ACQUISITION_MEANINGS` (stage-classifier), `STAGE` (listing-stage-engine,
exact names), `LISTING_STAGE_NAME` (listing-status-week, fallback labels),
autopilot `up_to_stage_name` (resolved by name through the live list), the
stage-options cache (10 minutes), the prompt and the extension. New code: ids.

### Booking the inspection on QUALIFIED: drafts in Yudi's own words (2026-09-14)

**The funnel (owner, 14.09, after a call with Yudi):** Initial Contact → TAKEN
TO WORK → QUALIFIED (Pre-listed) → Inspection sceduled → live → Weekly Check Sent
→ Update Availability Received. "Details ased" was deleted at 15:02.
QUALIFIED = the bot qualified the villa and it is Pre-listed on the site. The
next step is an OFFLINE inspection: Yudi goes to the villa, walks it, takes his
own photos, video and notes. Yudi, same day: the bottleneck is "scheduling the
visit with owners … push on inspection questions/request and once it confirmed
by owners put it into my calendar". The flow: the bot drafts the ask →
Yudi approves / edits → the owner agrees a time → `listing-progress` moves the
card to Inspection sceduled and records the slot → the calendar pass writes the
note (next section) → Yudi inspects and switches the listing to Listed →
`listing-status-pass` moves the card to live. **Drafts only**: QUALIFIED is past
the autopilot threshold (exclusive); nothing here sends.

**Yudi's style, read from his phone** (`lead_messages` sender_type `broker`,
11.08–14.09, his Rental Listings cards). He asks permission as a question and
usually names the day himself (today / besok / "tgl 13" / Monday), sometimes a
constraint ("saya bisa sebelum jam 11 pagi"); greeting by time of day + name +
honorific (kak / pak / bu), often "maaf baru balas"; the reason, when given, is
his own video / photos for clients ("I'd like to record a video for our remote
clients and understand the villa situation better in person 🙏"); Indonesian
with Indonesian owners, English with foreigners; 1–3 short lines; only a plain 🙏.
What got a yes: short Indonesian asks with a concrete day (Ma'Wa, Tilu, Villa
Daze, Casa Emilia, 23462321 — all within hours). What got silence: the long
English ones ending "let me know what time would be convenient" (Suku House,
Salt, Luna Kedungu, Yoshi). Owners' conditions: 24 h notice, tenant or guests in
the villa, "with guest?".

**`lib/yudi-voice.ts` — the one source of his words** (pushed first so the
owner-facing style work reuses it): `yudiPhoneLines` (his cards, 60 days, the
quoted owner text removed — `stripQuote` before `ownWords`, because an owner's
own quote-reply is not an exact earlier message), `yudiInspectionAskExamples`
(`isInspectionAsk`: a visit / inspection / own photos-video word AND a real ask
cue; client viewings are Amelia's move), `yudiStyleExamples`,
`ownerThreadLanguage`, `yudiExamplesBlock`. **Amelia writes to the same cards
from her phone through the same WAhelp account (same sender_id)**: her lines are
filtered by text — her name, a skin-toned emoji (🙏🏻 👍🏻; Yudi types 🙏), and
every line on that card for 36 h after a line naming her unless a later line
names Yudi. The team chat card 23499347, "bots" / "auto send" apologies skipped.

**The trigger is code, `lib/inspection-booking.ts` `bookingPlan`:**
- card in QUALIFIED (amoCRM id); a linked site listing (`listing_crm_link`, else a
  code in the card name) that is published, or a draft `listing_publish_blockers`
  finds nothing against, and still Pre-listed; no `listing_inspection_slots` row;
- the villa side's stance on a visit (`ownerVisitStance`: one Haiku call, only when
  a visit was talked about in 21 days, cached until a new message, fail-closed):
  agreed → settle, declined → hold, deferred (until a date) → hold until then,
  open → ask with a concrete time;
- the ladder: our asks for a visit since the villa side last wrote (bot or Yudi's
  phone). One ask, then at most two follow-ups, each ≥ 2 days after the last ask;
  three unanswered → hold, Yudi's call;
- **PUSH** only when we spoke last: 12 h quiet, not bot-excluded, no future amoCRM
  task on the card (`next_followup_at`; amo-sync Pass 0 deletes PUSH drafts there),
  no booking draft in 2 days and ≤ 3 in 14 days (`listing_inspection_asks`, the
  loop guard — whatever happened to the drafts), no pending draft that already
  asks. Drafts are written 08:00–18:00 Bali, every 30 minutes, ≤ 6 per pass; Yudi
  gets a push "Inspection asks ready".
- **LIVE**: when the villa side wrote last, the reply generator
  (`listing-acquisition-prompt.ts`, which the handover draft on arrival at
  QUALIFIED also uses) carries `inspectionBookingPromptBlock` — nothing about the
  villa is asked again (no "STILL MISSING" on QUALIFIED), the next step is Yudi's
  visit; ask / settle a time / hold as the plan says — and `applyInspectionAsk`
  inserts one sentence in his voice when an ask is due and the reply lacks it.

**Times** (`proposeInspectionTimes`): his usual hours and weekdays from the slots
on record (10:00–14:00; Mon–Fri plus days he did visit, Sunday included), from
tomorrow over five days, ≥ 90 minutes from any other scheduled inspection, ≤ 3 a
day (Yudi: "usually 1-3"), a day he is already inspecting within 3 km (or in the
same area) first. Two options, offered as a question; the draft is Yudi's to
approve, so no time is promised.

**The words**: `writeInspectionAskDraft` (Sonnet, JSON) — his examples, his
`owner_intake` lessons, the thread (30 lines), the owner's language, the round
(follow-ups open like a new message and are shorter). Checks, one retry:
`isInspectionAsk`, no re-ask (price, commission, bedrooms, dates, min stay,
photos / video / pin to be sent, documents), no link / code, no dash, the owner's
language, ≤ 480 chars. **Lesson conflict:** Yudi's lesson "After confirming deal
details, always request any missing assets (photos, documents)" contradicts the
owner's 14.09 rule on QUALIFIED; the prompt states the booking message wins. The
lesson is still live — the owner decides whether to retire it.

**Where it lands**: `pending_suggestions` kind `push`, `followup_level` NULL
(amo-sync deletes level 0 pushes), `autopilot_skipped_reason` =
`inspection booking ask · round N/3` (`INSPECTION_ASK_VERDICT`, listing-progress.ts).
Queuing retires the card's other pending drafts (owner nudges, answered LIVE
drafts, old handover drafts that asked for photos). A move to Inspection
sceduled retires a pending booking draft. Owner nudges (`listing-owner-followup`)
no longer run on QUALIFIED.

**Tables.** `listing_inspection_slots`: id, lead_id, visit_at, time_known,
agreed_at, quote, source, created_at, status (`scheduled` | `rescheduled`),
superseded_at. `listing_inspection_asks`: id, lead_id, round, suggestion_id,
text, times (jsonb), lang, created_at.

**Calendar hook.** One calendar implementation, `lib/inspection-calendar.ts` (next
section): listing-progress calls `queueInspectionCalendarSync` whenever a slot is
recorded or rescheduled; the pass reads the latest `status = 'scheduled'` slot per
card. Read side: `GET /api/public/inspections/upcoming?days=14` —
`upcomingInspectionEvents` from the same plan the calendar writes: villa, code,
listing title / URL, area, owner / manager name (site Internal data), visitAt +
Bali label, timeKnown, agreedAt, quote, map URL, exact address, amoCRM card(s).
No phone numbers.

**Tools.** `POST /api/admin/inspection-booking` (dry: every QUALIFIED card —
mode, PUSH due or why not, stance, our asks, proposed times; `?lead=a,b`;
`?generate=1` writes drafts without queuing; `?apply=1` queues like the pass).
Log lines: `inspection booking: <lead> <mode> — <reason>`, `inspection booking
pass complete`.

**Replayed before deploy (14.09, dry, from the typechecked branch on the VPS).**
Visit reading: 23555645 → Inspection sceduled, Wed 16.09 13:00, settled 14.09
15:10 ("Perfect, Wednesday afternoon works great"); the six cards already in
Inspection sceduled (23299197, 23528515, 23426747, 23541159, 23305115, 23549891):
no change. With the date right, the second opinion still said no — "the villa side
names a day, we accept it" read as an open offer — hence that sentence in
`confirmAgreedVisit`. Booking plan over the 25 QUALIFIED cards: PUSH due 4
(23361369, 23299227, 23378953, 23339527); ask inside the LIVE reply 3 (23497771,
23481615, 23388973); waiting on Yudi's amoCRM task 2 (23528517, 23260811); villa
side deferred 7 (23509251, 23518853 until 30.09, 23389387 from 2.10, 23434747 until
12.10, 23426777, 23497759, 23283693 ~21.09); reads as agreed but not recorded, so
settle / Yudi's call 3 (23519133 "Oct 13 at 2", 23426759 Salt "the 16th", 23550763
"15 Sept"); draft listing blocked 1 (23462331, no Drive folder); no site listing
linked 5 (23204741, 23223641, 23263701, 23555649, 23555645). The first drafts
offered every card the same two hours (→ offered times are tentatively taken), one
opened "Baik ka, terima kasih…" days late, one "selamat pagi", one said "before we
start marketing it" (→ three prompt lines). **Harness trap:** `/opt/whatcan/.env`
has duplicate keys and the last one wins; a test loader that keeps the first value
got stale Supabase / Anthropic keys, and every site read and model call failed
into "no listing linked" and empty drafts. Load last-wins.

### Agreed inspections are notes in the Brokers Google Calendar (2026-09-14)

Owner, 14.09: once a villa visit is agreed, the bot writes a short note into the Unicorn
Property Google Calendar ("вилла такая-то, время такое-то, инспекция") so Yudi opens the
calendar and sees today's visits. Written by code, not a person.

- **Transport: a Make.com scenario** — custom webhook → Google Calendar modules on
  info@unicorn-property.com's connection → Webhook response (`lib/google-calendar.ts`). Direct
  Google access is closed: the OAuth consent failed (`invalid_grant`) and the organisation
  forbids service account keys (`iam.disableServiceAccountKeyCreation`), both 14.09 (an Apps
  Script web app was the plan for an hour, then dropped). Protocol: POST JSON `{secret, action:
  "create"|"update"|"delete", calendarId, eventId?, summary, description, location, start, end}`
  (ISO `+08:00`) → direct JSON `{ok:true, id}` | `{ok:false, error}`. A Make webhook can take a
  few seconds; it answers plain `Accepted` when the scenario is inactive — any non-JSON body is a
  failure, retried next pass. No health check. The scenario sets the popups (60 and 15 minutes)
  and adds no guests. **It cannot list or search events** — idempotency is ours alone.
- **What is synced** (`lib/inspection-calendar.ts`): the latest `listing_inspection_slots` row
  per card whose visit is in the future or at most a day past, while the card sits in
  Inspection sceduled or further (live, Weekly Check Sent, Update Availability Received, won).
  One event per villa: key `prop:<R-code>` (site `listing_crm_link`, else exactly one site code
  in the card's name/notes) or `lead:<id>`; duplicate cards of one villa share the event.
- **Event**: `Inspection — <villa> (<R-code>)`, 60 minutes, `+08:00`; villa = the card name's
  first segment (the name Yudi uses — the site title is a sales headline, it goes into the
  description), else the site title. Location = the site's `google_maps_url`, else
  `exact_address`, else area. Description (English): listing title and site link,
  owner/manager name, area, address, map, amoCRM card link(s), the agreeing quote, `ref <key>`.
  A slot with `time_known = false` keeps its default hour with "— time not fixed" in the title
  (the webhook has no all-day events).
- **Pass**: every 5 minutes (`startInspectionCalendarSync`) and 8 s after
  `applyForwardPath` records a slot (`queueInspectionCalendarSync`). Missing → create; content
  changed (sha1 of the body) → update; card went back / lost / parked / left the funnel, or the
  slot is gone → delete; visit more than a day past → row `retired`, event kept as history.
  A failed amoCRM or site read aborts the pass — nothing is deleted on a bad read. An event
  deleted by hand is written again only when the visit changes.
- **Idempotency** = table `inspection_calendar_events` (sync_key → event_id, hash, status,
  summary, start_at, last_error; created at boot). The row is marked `creating` BEFORE a create
  call. A create whose outcome is unknown (timeout, or the 302's reply lost — the script may have
  written the event) becomes `uncertain` and is **not** created again automatically: look in the
  calendar (search `ref prop:…`), delete a stray copy if any, then
  `POST /api/admin/inspection-calendar?apply=1&retry=1`. A script `{ok:false}` is `error` and is
  retried on the next pass.
- **Fail soft**: the client returns `{ ok:false, reason }`, never throws, never logs the secret
  or the URL; the stage pass is never blocked. Unconfigured, the pass logs "Google Calendar
  webhook not configured" (at most every 6 h) and does nothing.
- **Env** (values only in `/opt/whatcan/.env`, never printed): `GOOGLE_CALENDAR_WEBHOOK_URL`
  (the `/exec` URL), `GOOGLE_CALENDAR_WEBHOOK_SECRET`, `GOOGLE_CALENDAR_ID` = the shared
  "Brokers" calendar (`c_cb134aa7…@group.calendar.google.com`, timezone Asia/Jakarta). New
  values need `deploy.sh` (it restarts with `--update-env`); `.env` has duplicate keys elsewhere
  — last value wins, edit only these lines.
- **When it breaks**: `scenario inactive (Make answered Accepted)` = the scenario is off — turn
  it on in Make (requests sent while it was off may still be queued there and run later: check
  the calendar for doubles); `scenario error: …secret…` = the secret differs on the two sides;
  a Google Calendar module error = info@'s connection in Make expired or lost edit rights on the
  Brokers calendar (reconnect it in Make → Connections); a 404 on the URL = the webhook was
  recreated (new `GOOGLE_CALENDAR_WEBHOOK_URL`). Fix, `deploy.sh` if `.env` changed, then
  `POST /api/admin/inspection-calendar/test`.
- Tools: `POST /api/admin/inspection-calendar` (dry plan; `?apply=1` runs the pass; `&retry=1`
  re-creates `uncertain` rows), `GET /api/admin/inspection-calendar/events` (our table: key,
  event id, summary, start, status), `POST /api/admin/inspection-calendar/test` ([TEST] event:
  create → update → delete).
  Log line: `inspection calendar: <action>`.

### Inspection. done: the agent has been to the villa (2026-09-09) — superseded 14.09, see above

The owner renamed "agreement" to "Inspection. done" in amoCRM (same stage,
id 87763170, between Details and live). It records a physical act: Yudi went
to the villa, took our own photos, video and notes, possibly signed the
agreement on the spot. It is the listing funnel's counterpart of Rental's
"Viewing done" — a visit that happened, not a plan.

**Regulation (owner, 09.09.2026):**
- *Who belongs here:* a card whose villa Yudi has physically inspected — met
  the owner's side at the villa, walked it, produced OUR photos/video/notes
  (handover-act style), usually with the listing agreement signed on the spot.
  Set by Yudi after the visit, never before, never from the chat.
- *Entry conditions:* the card came from Details with the bar met (owner,
  bedrooms, price incl. our 10%, availability, minimum stay, viewable-from,
  pin). An inspection is scheduled from Details; a card that skipped Details
  is a mistake, not a shortcut.
- *What the card must carry once here:* inspection date; where our media is
  (Drive folder / video, which the video-tour pipeline picks up); agreement
  status (signed on the spot, or the date it is due); notes on condition and
  inventory; who represented the owner. Yudi fills these — the bot can only
  read them back.
- *What the bot does:* no proactive nudges to the owner; an owner's message
  gets a LIVE draft for Yudi (never autopilot) written for this moment —
  agreement if not yet signed, publication timing, the one open item from
  the visit — and never re-asks photos, pin, price, availability or size.
- *Exits:* → live when Yudi switches the listing to Listed on the site (the
  pass below moves it) or by hand; → long term / Closed-lost only by Yudi.
  Nothing else automatic leaves this stage.
- *Metric:* arrival here is "Villas inspected" in the daily report; it is
  counted from the stage event, so a card moved here and back still counts.
- *Open follow-up:* an "inspection report" after the visit (did it happen,
  agreement signed?, media uploaded?, notes for the listing) on the same
  mechanism as the viewing report — not built yet.

Only a person can vouch for the visit, so:
- the one automatic way in is `listing-status-pass` acting on Yudi's own
  Pre-listed → Listed switch on the site (next section) — his explicit act, not
  the bot's reading of a chat;
- nothing else sets it or leaves it automatically — not the classifier
  (`RULE_OWNED_ACQUISITION_STAGES` includes `inspection`, and it is absent from
  `LISTING_ACQUISITION_MEANINGS` like live/RENTED), not the stage engine
  (`engineOwnsStage` is false there → audit reports only), not approve (a
  classified stage is refused; the broker's own pick always applies);
- the owner nudge pass skips it (`OPEN_STAGES` in listing-owner-followup):
  no "how many bedrooms" after a visit, no three-nudge auto-close of a card
  that cost a trip;
- the reply generator reads the card's stage and, on Inspection. done, tells
  the model we have everything from the visit — no asking for photos, pin,
  price or availability again; the conversation is agreement → live;
- the daily report orders it after Details (`STAGE_ORDER`, "agreement" kept
  beside it for old events), counts arrival there as "Villas inspected" and
  treats it as ours (`isListingWon`).
No card had a confirmed inspection on 09.09.2026 — every visit in the threads
was scheduled ahead (Aquamarine 25.09, Forest Bloom from 13.09, Uma Avaya
09.09) or offered and not taken (Umbala, D kasih); the one visit that
happened was Amelia's client viewing at Namaste Villa on 05.09.

### The site's Listed switch moves the card to live (2026-09-14)

Owner: "the switch in Internal data on the site — count the result by it and
move the cards to live in the CRM". `properties.pre_listed` on the site
(Pre-listed / Listed) is the inspection result. Until 14.09 it had no history,
Listed and live disagreed (R-YUD-058 Listed, its card lost), and on 11.09 Yudi
reported R-YUD-097 "marked Listed" when the database never got it.

**Site side** (bali-villa-rentals, migration 20260914033216): trigger-journal
`listing_status_log` (every insert and real `pre_listed` change: old/new, who,
`source` site_user / service_role / sql), `listing_crm_link` (listing → card),
`listing_status_actions` (what this pass decided), view
`listing_status_weekly`. Browsers can only read them. The admin save now says
"NOT saved" unless the database returned the values it sent.

**`lib/listing-status-pass.ts`**, every 5 minutes (first run a minute after
boot), idempotent through `listing_status_actions` (one row per journal row;
a failed decision records nothing and is retried):
- only journal rows `UPDATE true → false` move anything. An INSERT never does
  (the column defaults to false, so creating or renaming a listing would
  otherwise go live), nor a switch already reverted when the pass runs;
- linked card in TAKEN TO WORK / QUALIFIED / Details → Inspection. done, 4 s,
  → live; in Inspection. done → live. Then a note: who switched, when (Bali),
  flags present or MISSING, own video, Drive folder. amoCRM refusing a move
  throws → retried next pass (a card left in Inspection. done moves on);
- card in live / Weekly Check Sent / Update Availability Received →
  `already_live`, nothing;
- long term / co-broke / lost / won, Initial Contact, a card outside Rental
  Listings, no card, two candidate cards → not moved, `notifyBroker("yudi")`
  push, listed in the report;
- Listed → Pre-listed → never moves a card back; push only (skipped within
  10 minutes of the listing's INSERT: the admin form creating/renaming it).
- An unlinked listing is resolved by `resolveFrom`: its code in exactly one
  open card's name or common notes (confirmed by the owner phone when that
  phone is on any card), else its owner phone on exactly one open card that
  names no other site code and whose phone no other listing shares. Two
  candidates = ambiguous, never a guess. Card 23211429 ("[SYSTEM] FB прогон")
  names every code and is ignored. The found link is stored.
- The stage engine does not fight it: `engineOwnsStage` is false for
  Inspection. done and live, and nothing here moves a card out of live.
- Manual run: `POST /api/admin/listing-status-pass?dry=1` (dry = decide and
  report only). Log lines: `listing switch: <id> <decision> — <detail>`.

**Backfill 14.09.2026:** 36 unambiguous links (code + phone, or phone alone
where unique). NOT linked, for the owner: R-YUD-050 (code on QUALIFIED
23223641 and live 23355221), R-YUD-083 / R-YUD-050 and R-YUD-047 / R-YUD-096
(one card claimed by two listings), R-YUD-092 (23263701 and 23519133),
R-YUD-036 (its code is only a note on R-YUD-086's card), R-YUD-056 and
R-YUD-087 (code on one card, owner phone on another), phone shared by two
listings (R-YUD-046/060, R-YUD-051/R-CGU-002, R-YUD-062/064, R-YUD-077/081),
only closed cards (R-YUD-002, R-YUD-058, R-YUD-073, R-YUD-084, R-UM-024).
The listings already Listed before 14.09 were NOT moved: only switches
journaled after the deploy move cards.

**Weekly metric (owner, 14.09):** target **10 Pre-listed → Listed a week**
(Mon–Sun, Bali) for Yudi from 14–20.09, `WEEKLY_LISTED_TARGET` in
`lib/listing-status-week.ts` — the only place the number lives. "Listed" =
distinct listings switched true → false that week (`listing_status_weekly`);
"cards reached live" = distinct Rental Listings cards arriving in live in
amoCRM events, by anyone. `GET /api/public/listing-status/week?week=YYYY-MM-DD`,
`/weeks?n=4`; Yudi's report card carries `listingWeek` (shown in /m), the 8am
push adds "Listed this week x / 10". `changed_by_email` cannot tell Yudi from
the owner while both use info@unicorn-property.com.

Verified 14.09.2026 end to end: throwaway draft R-TEST-SWITCH-01 linked to
throwaway card 23561499 (QUALIFIED); the site's own `saveInternalData` run as
the listing-bot session → "Saved — Listed · 1 red flag · 1 green flag";
journal row `UPDATE true→false site_user listing-bot@…`; the scheduled pass
4 minutes later: amoCRM events QUALIFIED → Inspection. done 11:52:07,
→ live 11:52:11 (Bali), note written. Card closed lost, property, link and
journal rows deleted. The same save as a signed-out session → "NOT saved".

### Weekly availability check: automatic, live and beyond only (2026-09-14)

Owner: "Когда листинг попал в лайв, то 1 раз в неделю мы по регламенту уточняем
про availability… сейчас это делает Юди через аппрувы, но это долго, иногда он
забывает, нужно автоматически. Одно короткое сообщение 1 раз в неделю
достаточно. ТОЛЬКО для листингов, которые прошли до этапа live в CRM, не
раньше." Until then `weekly-availability-check.ts` wrote a push DRAFT for Yudi
on Weekly Check Sent only: 6 from 27.08 never approved; the 2 sent on 07.09
were both answered within an hour. **Regulation now — automatic, no approval:**
- **Who:** a Rental Listings card NOW in live / Weekly Check Sent / Update
  Availability Received — nothing else since 15.09 (the "went through live by
  amoCRM events" branch excluded a list of stages that did not contain
  QUALIFIED, so Villa Azul 23204741 and Villa Amor 23223641, moved back to
  Pre-listed, would have been asked once linked); linked
  (`listing_crm_link`) to exactly one published rent listing; the owner has
  written to us at least once. Never earlier stages, never a first contact —
  so the 9-a-day new-contact budget is neither spent nor waited for.
- **Line:** the owner must already have a WhatsApp talk on one of the
  responsible broker's own numbers — `resolveSendChannel` then stays on it. A
  thread only on another broker's line is skipped (it would reassign the card
  and open a second chat).
- **When:** nothing of ours (Copilot or phone) in 7 days, owner quiet 3 days, no
  LIVE reply younger than 3 days pending in the inbox (an older forgotten draft
  does not block), not two unanswered checks in a row (then it
  stops and says so in a note on the card), Bali 10:00–17:00, one send per
  5-minute pass and ≥12 minutes between checks.
- **What:** one fixed sentence, no model, English or Indonesian by the owner's
  own words (`threadLanguage`), villa name from the card title, never the R-code:
  "Hi <name>, quick weekly check on <villa>: is it still available? If it's
  taken, when does it free up?" / "Halo <name>, cek mingguan untuk <villa>:
  apakah masih tersedia? Kalau sudah terisi, kosong lagi mulai tanggal berapa?"
- **How:** `resolveSendChannel` + `deliverText` (the one send path, the
  conversation's own line), `sent_messages.kind = 'weekly-availability'`. The
  card moves to Weekly Check Sent only when the type-90 event is in the lead's
  timeline (`delivery_status` stamped into `webhook_response`); not seen in 45 s
  → re-checked every pass, a note on the card after 2 h.
- **Answer:** owner replies to the newest check, quiet 10 min → card to Update
  Availability Received, note with the owner's words, one Haiku reading
  (free_now / free_from / occupied_until / not_for_rent / unclear) behind code
  guards (`guardAnswer`: a date needs an exact day in the owner's own words; a
  month, "soon", a range with gaps is unclear). Clear → `property_availability`
  in the admin format (status available, start = first free day, end 2099-12-31)
  over the listing's one row, whatever it said (an occupied row too: 3 published
  listings had one on 15.09, and the owner's answer today is newer), read back
  before it counts; several rows are not guessed over (none on 15.09).
  Everything else, and "no longer for rent", → a note on the card with the
  owner's words, and the reply draft stays in the inbox; nothing is unpublished
  automatically. Marker per check: `broker_settings`
  `weekly_check:answer:<sent id>`, `handled` = the site has the answer.
- **Nobody is pushed (owner, 15.09: "пуши не должны уходить Юди вообще, это же
  автопилот").** On 14–15.09 every answer still reached Yudi: the LIVE path
  drafted a reply and pushed (twice for one message — one push per detector),
  processAnswers retired the draft, and five minutes later the unanswered-live
  pass wrote it again with another push (Villa Lani 17:15 → 17:16; Bumbak Dream
  Villa 09:28 → 09:33, asking a live villa's owner for the minimum stay). Now
  every LIVE writer asks `weeklyCheckReplyState` (`lib/weekly-check-reply.ts`):
  `awaiting` (nothing of ours after the newest check, under 10 days, not read
  yet) and `handled` → no draft, no push; `needs_person` → the draft, no push;
  `none` (anything of ours after the check, or the owner writing after the
  reading) → the ordinary path. Asked in `queueSuggestion` and in
  `processUnansweredLive` BEFORE its cap of 10. The pass's own "not sent", "not
  in the timeline after 2 h" and "two unanswered in a row" are card notes.
  amo-sync's outgoing-event feed skips a `weekly-availability` send within ±3
  min: it had taken the check for a manual reply on Villa Lani (a follow-up
  clock and a "Replied to the client by hand" task), a race the check lost
  depending on which write landed first.
- **Switch:** `broker_settings.weekly_availability_mode` on | dry | off (missing =
  dry = the scheduler does nothing). Plan without sending:
  `POST /api/admin/weekly-availability?dry=1[&answers=1]`; a pass now: `?run=1`.
- Cadence check: `select lead_id, count(*) from sent_messages where kind =
  'weekly-availability' and webhook_status = 200 and created_at > now() -
  interval '7 days' group by 1 having count(*) > 1;` must return nothing.
- **Verified 14.09.2026:** dry plan 22 cards → 2 send, 20 skip (5 live cards
  without a site link, 5 never talked to the owner, Villa Markisa written to
  5 days ago, 8 closed/co-broke/lost). Mode on 15:59 Bali; Villa Lani
  (23389399) EN 16:01:58 and Bumbak Dream Villa (23462321) ID 16:16:30, both on
  59537, type-90 events in the timeline, amoCRM live → Weekly Check Sent. The 3
  still-pending approval drafts of 27.08 (899eb618, 4dc6fdbe, b731bce4) set
  skipped. The owner-answer path had no reply yet at deploy.
- **Verified 15.09.2026 (25998db):** before deploy, `weeklyCheckReplyState`
  read on the live database: Bumbak `handled`, Villa Lani / Umbala / Dani Villa
  `none`. After deploy the Bumbak "minimum stay?" draft was retired and did not
  come back over the next unanswered-live passes; dry plan 16 cards, all in the
  three weekly stages (the 2 QUALIFIED and 7 closed/co-broke gone). Villa Ra
  (23389577) linked to R-YUD-065 by hand (owner Mireia, 2BR Seseh 55M, folder
  "Ra - Seseh"; approved by Nikita) and checked automatically at 13:27:19,
  type-90 in the timeline, live → Weekly Check Sent. Not covered and not the
  pass's to fix: 5 live cards with no site link (Casa Emilia, 23355221,
  23355223, Double R Villa, the Umbala coordinator card 23541159) and 5 with a
  published listing but no conversation in amoCRM (R-YUD-018/048/049, Dani
  Villa, The Loft — the last two sit in Weekly Check Sent with nothing ever
  sent).

### Construction nearby: the one structured red flag (2026-09-10)

Brokers tick **Construction nearby** in the site's Internal data
(`property_private.construction_nearby`, admin/agent-only by RLS) — Amelia in
Unicorn Rental: "flag options with construction nearby". "Red flag" is the
team's slang for any important detail, so it is deliberately NOT a field
(owner, same evening): every other red flag goes in Internal notes.
`red_flag` / `red_flag_reason` exist in the table but are unused, kept only
because an admin tab on an older build still sends them on save.
`lib/property-flags.ts` reads only flagged rows and only that column with the
service key (3-minute cache); `/api/public/suggestions` puts `villa_flags`
(keyed by attachment URL) BESIDE each draft's `attachments` — never inside
them, because attachments are posted back verbatim on approve. `/m` draws
"Red flag: construction nearby" under the villa link; nothing reaches the
client. `openDetail` and the inbox refresh both copy card fields by name — a
new field has to be added to both, or it vanishes when the card is opened or
refreshed. The same Internal data carries the Pre-listed / Listed switch
(`properties.pre_listed`): Listed means Yudi has inspected the villa and
written its notes and green/red flags — and since 14.09 it moves the card to
live (section above).

### Parked listing cards are answered and re-judged (2026-09-07)

"long term" and "co-broke Agents" are parking stages: no proactive chasing.
They were also inbox-suppressed AND past the autopilot threshold, so an owner
who wrote to a parked card was answered by nobody: 12 on long term, 17 on
co-broke, some for three weeks. Canon now:
- an inbound on a parked card gets a reply — autopilot sends `live` drafts
  there (`autopilotStageNames` = delegated + parked; pushes still refused; a
  standing non-"waiting" verdict such as the dated availability check is never
  overwritten), and the inbox shows the draft when the bot could not send it;
- every reply re-judges the card: `releaseFromLongTerm` (not occupied, or free
  within `FREE_SOON_DAYS`=90) and `releaseFromCoBroke` (counterpart is the
  owner — never on "unclear", two extractions would ping-pong the card);
- `routeUnqualified` no longer parks "occupied but free within 90 days";
- the extractor is told today's date — "free from October" used to come back
  as 2024 and the plausibility guard then hid the villa forever.
Repair/audit: `POST /api/admin/backfill-listing-fields?stage=<name>&route=1`
(dry without `route`), which runs both releases before qualification.

### Listing qualification asks for viewability (2026-09-07)

`meetsQualified` needs `min_stay_months` and `viewable_from` besides bedrooms,
price with commission position and the owner. Clients asked to see 7 of our
villas in one week, 1 had a slot. The qualifying sentence, the adaptive nudge
and the prompt's settled/missing lists all carry both; the card gets
`Listing: minimum stay` / `Listing: viewable from` (auto-created). Listing
floor is 33M client-facing (net + 10%), owner's words 05.09.

## Rental conversation rules (`lib/rental-prompt.ts`)

- Offer a shortlist once **~2 criteria** are roughly known. Don't interrogate.
- **When the lead likes a specific villa, stop sending options** — confirm
  availability and propose an **in-person viewing with a concrete time slot**.
  Viewings on Bali are live; no video walkthroughs or virtual viewings (owner,
  2026-09-10): a client not on the island yet is asked when they arrive. This is also enforced in code (`shouldSkipNewListings` in
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
  **The calendar is read exactly the way the SITE reads it** (`freeFromOf`,
  mirror of `getFreeFrom` in bali-villa-rentals `src/lib/rental-availability.ts`):
  `occupied`/`rented` is a busy period, `available` means free from
  `start_date` with a 2099 `end_date` sentinel. Until 11.09.2026 every row was
  read as "busy until end_date", so each "Available from <date>" the brokers
  set on the site became "free in 2100" and the villa never reached a
  shortlist — 17 villas, including every new listing entered with a date
  (R-YUD-088…098: zero drafts in 21 days while dateless new listings were
  attached normally). A change to either reader changes both.

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
- **Replay the matcher and the generators on real leads before deploying them**
  (read-only). Push the branch to GitHub (not master), check it out in a
  server worktree with prod's node_modules linked (as
  `scripts/typecheck-worktree.sh` does), write a TS entry that parses
  `/opt/whatcan/.env` into `process.env` and then `await import()`s
  `./lib/generate-suggestion` etc., bundle with `esbuild --bundle
  --platform=node --format=cjs --alias:@workspace/db=<worktree>/lib/db/src/index.ts
  --external:pg-native --external:sharp`, write the bundle INSIDE
  `/opt/whatcan/artifacts/api-server/`, run `NODE_ENV=production node`, delete
  it. Call `pickPropertyAttachmentsDetailed`, `generateSuggestion`,
  `generatePushFollowup` — none of them writes a queue row, sends or writes
  amoCRM (only `ai_usage` rows). Print the resolved request, each attached
  villa's bedrooms/area/price/availability with `requestMisfits`, and the text.
- **Do not run synthetic tests against live leads.** Injecting fake messages
  into lead 22962823 put invented client requirements into a real WhatsApp
  conversation. Test the prompts/classifiers standalone instead.
- **Answer the owner in English** (he asked for it explicitly on 2026-08-18; this
  line used to say Russian). He still wants plain-language explanations of what
  broke and why, not jargon.
