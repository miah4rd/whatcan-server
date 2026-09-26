---
name: "listing-upload-regulation"
description: "Полный регламент публикации арендного листинга на unicorn-properties.com — своя база Supabase zveamkyyzfztzppwavws через execute_sql (Lovable больше не используется), папка и документ, фото, ID, координаты, импорт изображений, поля базы, обязательные площади участка и здания, проверка перед публикацией, редактирование существующего листинга и известные ловушки. Использовать при ЛЮБОЙ задаче про загрузку нового листинга на сайт, правку существующего, замену фотографий, скрытие листинга, изменение доступности или выдачу ссылки клиенту."
---

# Listing Upload Regulation — unicorn-properties.com

Full instruction for putting a new rental listing on the website, editing an
existing one, and replacing photos.

Two sides: **Part A–C** is what the person preparing the folder must do.
**Part D–H** is the upload and verification itself.

---

# PART 0 — WHERE THE DATA LIVES (changed 2 September 2026)

The site, the database and the photos are now in **our own Supabase project**.
**Lovable is gone.** It no longer reads or writes anything.

| Before | Now |
|---|---|
| Supabase `yrtteclvrtqobjnpxqck`, Lovable project `2206c216-…` | Supabase **`zveamkyyzfztzppwavws`**, no Lovable |
| `query_database` from the Lovable connector | **`execute_sql`** from the Supabase connector |

**Do NOT use the Lovable connector `query_database` for listings** — it points at
the old, dead database. Anything written there does not reach the site.

### Connecting

Once, in claude.ai → Settings → Connectors → **Add custom connector**:

- Name: `Supabase`
- URL: `https://mcp.supabase.com/mcp?project_ref=zveamkyyzfztzppwavws&features=database`
- Authorise with the owner's Supabase account (GitHub login, irbitskiy@gmail.com).

Then enable the `Supabase` connector in the session. The tool is `execute_sql`.
This is full access to the live database: SELECT freely, INSERT/UPDATE deliberately.

If `execute_sql` is not present in the session, **stop and say so** — do not fall
back to the Lovable connector, the write will silently go nowhere.

Everything else is unchanged: tables, fields, IDs `R-<AGENT>-<NNN>`, `is_draft`,
`property_private`, `property_availability`, `import_property_images(...)`.
Bucket is still `property-images`; public URLs now sit on
`zveamkyyzfztzppwavws.supabase.co`.

Admin panel `https://unicorn-properties.com/admin` — Google sign-in with an
@unicorn-property.com account. That is for humans; work through SQL.

---

# ⛔ SIZES ARE A PUBLISH GATE (owner instruction, 4 September 2026)

**A listing does not go live without land size and build size.**

The old wording said "unknown is `0`". That loophole is what produced the backlog:
on 4 September 2026 the live base held **83 published listings with no land size
and 135 with no build size** — on rentals that was half the catalogue (30 of 67
without land, 34 of 67 without build). Clients filter and compare by size; a card
without it looks unfinished and loses to a competitor's.

Rule now:

- `land_size = 0` or `build_size = 0` is allowed **only while `is_draft = true`**.
- Before flipping `is_draft = false`, both must be real numbers in m².
- The number still is **never invented**. Missing means: ask the owner. The
  question is part of the qualification script — see `listing-qualification-standard`.
- Genuinely unobtainable (co-broke partner will not disclose, owner does not know)
  → publish is a **deliberate exception**: put the reason in
  `property_private.notes` and tell the owner of the business it went out short.
  Silently publishing a zero is the thing being stopped.

Standing check for the gap:

```sql
SELECT id, title, listing_type, land_size, build_size FROM properties
WHERE coalesce(is_draft,false) = false
  AND (coalesce(land_size,0) = 0 OR coalesce(build_size,0) = 0);
```

## ⛔ INTERNAL DATA AND THE DRIVE FOLDER ARE A GATE TOO (owner instruction, 6 September 2026)

Same weight as sizes. A listing does not go live until the **Internal data** block
(`property_private`) is filled — `owner_name`, `owner_phone`, `exact_address`,
`google_maps_url`, `drive_folder_url`, `notes` — and until **our own Google Drive
folder** exists holding a copy of everything published on the site. An empty
string counts as not filled. Full rule, folder naming and parent IDs:
**`listing-internal-data-gate`**.

The `listing-prelisted-enrichment` relaxations (publish without sizes, publish on
internet photos) cover sizes and photos only. They do **not** touch internal data.

---

# PART A — The folder

One Google Drive folder per listing. One doc + the photos, nothing else.

### A1. Location decides the source

| Parent folder | `listing_source` | Meaning |
|---|---|---|
| **Own listings** | `own` | our own listing |
| **Co-Broke** | `co-broke` | partner listing; owner data not required to publish |

Put the folder in the wrong parent and the listing is labelled wrong on the site.
This is decided by folder location, not by anything in the doc.

### A2. Folder name

Villa name + area, as the villa is actually known:
`Maxwell Tabanan`, `Albi Cemagi`, `Bell - padonan`.

**The folder name and the villa in the doc must be the same villa.** If they
disagree the upload stops until it is resolved — it has already caused two false
starts (a folder named `YA | AJ Villa Canggu` containing a Kiki Village doc;
a folder named `Casa De Fiero 2BR Type A` used for a 3BR unit).

Inside the listing folder there may be a **nested photo subfolder** — check both
levels when collecting file IDs.

### A3. Sharing

Files must be readable by link ("Anyone with the link"). The import server has no
Google login — if a file is private it fetches an HTML page instead of the photo
and the import fails with a clear error.

---

# PART B — The doc

One Google Doc in the folder. **Write a rental doc for a rental listing.**
A sale doc with two rental lines buried in it has to be rewritten by hand, with
all the leasehold/investment/"for early buyers" copy stripped out.

### B1. Mandatory fields

| Field | Why it matters |
|---|---|
| Villa name | must match the folder; **never goes into `title`**, see Part E |
| Bedrooms / Bathrooms | |
| **Land size m²** | **publish gate** — no number, no live listing |
| **Build size m²** | **publish gate** — no number, no live listing |
| **Monthly price IDR** | without it the listing does not appear in the `/rent` catalogue |
| Yearly price IDR | if offered yearly |
| **Google Maps link** | frequently missing. Without it the villa never appears on the map |
| Included in the rent | housekeeping, pool, garden, WiFi, electricity… |
| Excluded | electricity, water, gas, laundry… |
| Availability | "Available now" or a date |
| Owner / manager name + phone | internal only, never shown publicly |

### B2. Template — copy this

```
VILLA NAME:
AREA:                    (Canggu / Pererenan / Seseh / Umalas / …)
GOOGLE MAPS LINK:

Bedrooms:
Bathrooms:
Land size:               m²      <- required to publish
Build size:              m²      <- required to publish

PRICE
Monthly:                 IDR
Yearly:                  IDR

AVAILABILITY:            Available now  /  from DD MMM YYYY

INCLUDED IN THE RENT
•
•

EXCLUDED
•

PROPERTY HIGHLIGHTS
•
•

LOCATION
•

OWNER / MANAGER (internal, not published)
Name:
Phone:
```

### B3. Prices

- Monthly and yearly are **independent numbers**, not one derived from the other.
  Monthly is normally a premium over yearly ÷ 12. Write both as given by the owner.
- If only a yearly price exists, say so — monthly is then set to yearly ÷ 12 and
  flagged on the listing record as derived.
- A listing with no price does **not** show in the catalogue. If the owner has not
  named a price and the listing must go live anyway, put a market estimate, record
  in `property_private.notes` that it is OUR estimate and not the owner rate, and
  tell the user.

### B4. Where the sizes come from

In order of preference:

1. The owner, in writing. This is the only source that is authoritative.
2. The villa's own site, Airbnb or Booking page — but only if the number sits in
   the same block as the villa's own name. The size on a catalogue category page
   belongs to some other property; the same attribution rule as prices applies.
3. Land size can be sanity-checked against the plot on Google Maps satellite view.
   Use it to catch an obviously wrong number, not to produce one.

A number from a competitor's aggregator card without the villa named next to it
is not a source. Leave it blank and ask.

---

# PART C — Photos

Full photo standard lives in the skill `listing-photo-standard` — cover choice,
horizontal-only rule, brightness thresholds, gallery order. Short version here.

### C1. Quantity
20–30 in the folder, **20 on the listing**. Below 10 — say the set is poor.

### C2. Do not compress

**No resizing, no compressing, no re-exporting.** The server does it
automatically: downloads the original, resizes to max 1920px, re-encodes JPEG
quality 82.

Limits:
- **15MB per file.** Above that the importer rejects it.
- **Google Drive links only.** Dropbox is not supported.

### C3. Filenames — the biggest time saver

Number and name them in viewing order: `1. Facade.jpg`, `2. Pool.jpg`,
`3. Kitchen.jpg`… With names like these the set orders itself. With
`IMG_8587.jpeg` every photo has to be opened and identified afterwards.

### C4. Source priority

**Airbnb first, always** — best photography by far. Then owner files in amoCRM,
then the Drive folder, then the villa's own site/Instagram.

### C5. Order on the listing

**facade and street → living and kitchen → bedrooms and workspace → bathrooms →
other (wardrobes, garden, laundry, parking).**
Cover is the pool with the villa, the facade, or the entrance group.
Never a bathroom, a bedroom, or a detail shot.

### C6. The photos must be the actual unit

Photos of a neighbouring unit in the same complex are used **only with explicit
approval**, and only after any visible branding, unit number, or WiFi/info card is
blurred out.

---

# PART D — Upload process

### D1. Read and reconcile
1. Read the doc in full (not the preview snippet — it truncates).
2. Reconcile folder name vs villa name in the doc. Disagreement → stop and ask.
3. Note every missing mandatory field. These get flagged at the end, never guessed.
4. **Land size and build size missing → say so now, at the start.** They are a
   publish gate, and asking the owner takes a day; discovering it at step D7
   wastes that day.

### D2. Check for duplicates
Search the site by area + bedrooms + size + price, and by villa name. Two units in
the same complex are fine — but confirm the photos really are different units.

### D3. Assign the ID
Format `R-<AGENT>-<NNN>`. The `R-` prefix means rental.
Agent prefixes in use: `YUD` `MER` `SAI` `AME` `DES` `DESTI` `PE` `CE` `CA` `UM`
`UB` `BU` `SA` `SER` `UL` `ROB` `NIK` `FE` `SE`.
Take the next free number in that agent's sequence. Verify it is free before using it.

### D4. Resolve the map pin
Open the Maps short link and take the coordinates from the resolved URL
(`!3d<lat>!4d<lng>`), or resolve by name through Google Places. Confirm the pin is
the villa itself, not a district or a road. No pin → `lat`/`lng` stay `0` and it is
flagged. **A listing at 0,0 does not appear on the map.**

### D5. Create the record
Insert into `properties`. Then:
- `property_private` — **owner name, owner phone**, exact address, Google Maps URL,
  Drive folder URL, notes on anything uncertain. Owner name and phone are pulled
  from the amoCRM lead if the doc does not have them; leaving them blank is a
  defect, the broker cannot work the listing without them.
- **All six Internal data fields are mandatory, not just owner name and phone.**
  `owner_name`, `owner_phone`, `exact_address`, `google_maps_url`,
  `drive_folder_url`, `notes` — an empty string is not filled. See
  `listing-internal-data-gate`.
- **`drive_folder_url` must be OUR folder, not the owner's.** Create a per-listing
  Google Drive folder named `<Villa name> <Area> — <ID>` under the parent that
  matches `listing_source` — **Own listings** `1KN--pUx3ssDGdg73uT5S3UvnvdRp6VBE`,
  **Co-Broke** `15Z1VJbgU5oKHW9_kpzEKjsjuXqxXMeh5` — share it "Anyone with the
  link", put in it a copy of everything published on the site (gallery photos in
  published order, the listing doc, video), then write the folder link here.
- `property_availability` — only if not available now. For "available from
  1 Oct 2026": `start_date 2026-10-01`, `end_date 2099-12-31`, `status 'available'`.

Create as `is_draft = true`. **Let the insert commit before importing photos** —
the import function calls in from outside and cannot see an uncommitted row.

### D6. Import the photos

```sql
SELECT import_property_images(
  '<PROPERTY_ID>',
  ARRAY[ 'https://lh3.googleusercontent.com/d/<FILE_ID>=w1600', ... ]::text[],
  'append'
);
```

- **Always `append`, never `replace`** on an existing listing.
- 5–10 URLs per call (hard cap 20).
- `=w1600` asks Google for a resized copy — smaller and faster than the original.
- A **tool timeout or `499` is NOT an error.** The server keeps working.
- Re-send the **identical call** until the photo count stops rising. Already-imported
  photos are skipped for free; nothing duplicates, nothing is lost.
- A reply `{"status":200,"imported":N,...}` means the photos landed in
  `properties.images` on `zveamkyyzfztzppwavws.supabase.co`.

Typical: 20 photos land in 3 passes (7 → 14 → 20).

### D7. Publish

**Gate first.** Run this and expect zero rows:

```sql
SELECT id, land_size, build_size, monthly_price_idr, lat, lng
FROM properties
WHERE id = '<ID>'
  AND (coalesce(land_size,0) = 0 OR coalesce(build_size,0) = 0);
```

A row back means the listing stays `is_draft = true` until the sizes arrive, or
until the owner of the business signs off on the exception in writing.

**Second gate — Internal data.** Also expect zero rows:

```sql
SELECT property_id FROM property_private
WHERE property_id = '<ID>'
  AND (coalesce(owner_name,'') = '' OR coalesce(owner_phone,'') = ''
    OR coalesce(exact_address,'') = '' OR coalesce(google_maps_url,'') = ''
    OR coalesce(drive_folder_url,'') = '' OR coalesce(notes,'') = '');
```

No `property_private` row at all is the same failure. A row back — or a
`drive_folder_url` that points at the owner's folder instead of ours, or at a
folder that does not yet hold the published photo set, the doc and the video —
means the listing stays `is_draft = true`. Details in `listing-internal-data-gate`.

Then set `is_draft = false`, open `https://unicorn-properties.com/property/<ID>`
and confirm it renders, the gallery works, the sizes show on the card, and the
cover is the facade or the pool.

---

# PART E — Field reference

| Field | Rule |
|---|---|
| `id` | `R-<AGENT>-<NNN>` |
| `title` | Descriptive, **never the villa's real name** — competitors search by name and poach the owner. Formula: `<N>BR Villa with <1-2 features> in <area>` |
| `area` | Canggu · Cemagi · Jimbaran · Kerobokan · Lovina · Nusa Dua · Padonan · Pererenan · Sanur · Seminyak · Seseh · Tabanan · Ubud · Uluwatu · Umalas |
| `type` | villa · apartment · land · townhouse |
| `status` | ready · off-plan · under-construction · sold |
| `ownership` | freehold · leasehold · freehold & leasehold — rentals use `leasehold` |
| `purpose` | living · investment · living & investment — rentals use `living` |
| `zone` | residential (default) · touristic · mixed · green |
| `listing_type` | `rent` |
| `land_size` / `build_size` | m², integer. **Required to publish** — `0` only while `is_draft = true`. Never invented; missing means ask the owner |
| `monthly_price_idr` | required for the catalogue |
| `yearly_price_idr` | optional |
| `lease_years` | **not used on rentals** — that is a sale field |
| `lat` / `lng` | **not nullable** — no pin means `0`, and the villa will not map |
| `price_usd` | `0` on rentals |
| `listing_source` | `own` or `co-broke`, from the folder's parent |
| `rental_included` / `rental_excluded` | comma-separated prose |
| `features` | short title-case labels. **No commas inside a label** — it splits the array |
| `tags` | `Rent` + 2 highlights, e.g. `Private Pool`, `Ocean View` |
| `is_draft` | `true` = hidden from site, map, sitemap and SEO |

**Zone:** `touristic` only when the villa has a Pondok Wisata licence or sits in a
tourism/red zone. Otherwise `residential`.

---

# PART F — Verification before publishing

1. Every figure matches the source doc — bedrooms, bathrooms, both sizes, both prices.
2. **`land_size` and `build_size` are both non-zero** — this blocks publication.
3. No duplicate on the site.
4. Map pin opens to the villa itself.
5. Photos are the right unit, and the bedroom count in the photos matches the listing.
6. `property_private` has owner name and phone filled in.
6a. **The whole Internal data block is filled** — `owner_name`, `owner_phone`,
   `exact_address`, `google_maps_url`, `drive_folder_url`, `notes`, none of them an
   empty string. This blocks publication — see `listing-internal-data-gate`.
6b. **Our own Drive folder exists** under the right parent, named
   `<Villa name> <Area> — <ID>`, shared "Anyone with the link", holding the
   published gallery in published order plus the listing doc and the video, and its
   link is in `property_private.drive_folder_url`. The owner's own folder does not
   count.
7. Gallery renders on the live page; cover is the pool, facade or entrance group.
8. Order is facade → living/kitchen → bedrooms → bathrooms → other.
9. Villa's real name appears nowhere in `title` or `description`.
10. Every field the doc did not state is flagged in the report — never guessed.

---

# PART G — Editing an existing listing

### Replace all photos
A published listing **cannot have zero photos** — the database blocks it, `replace`
fails with "cannot be published without photos". So:
1. `append` the new photos (listing temporarily holds old + new).
2. Then rewrite `images` to the new ones in a single write.

### Rewriting the images array — the trap

`SET images = ARRAY[images[1],images[32], ...]` is **not idempotent**. A timeout
often means the statement did run; repeating it applies the permutation twice,
indices fall out of range, Postgres substitutes `NULL`, and the whole gallery
renders as the cover repeated. Always write **explicit URLs**:

```sql
UPDATE properties SET images = ARRAY['https://…/file1.jpg','https://…/file2.jpg']::text[],
  updated_at = now() WHERE id = '<ID>';
```

Set one frame as the cover without touching the rest:

```sql
UPDATE properties SET images = ARRAY['<URL>'] || array_remove(images,'<URL>'),
  updated_at = now() WHERE id = '<ID>';
```

Check afterwards: `array_length(images,1)` must equal
`cardinality(array_remove(images,NULL))`.

After any gallery or cover change, **update the listing's Drive folder to match** —
same frames, same order. See `listing-internal-data-gate`.

### Filling in sizes later

```sql
UPDATE properties SET land_size = <m2>, build_size = <m2>, updated_at = now()
WHERE id = '<ID>';
```

Record where the number came from in `property_private.notes` — "owner WhatsApp
4 Sep 2026" or "villa's own site". A size with no stated source is treated as
unverified and gets re-asked.

### Hide a listing
`is_draft = true`. **Never delete** — the data and photos stay and it can be
restored instantly.

### Change availability
Add a `property_availability` row. "Rented, back on 1 Oct" → `start_date` 1 Oct,
`end_date` 2099-12-31, `status 'available'`. The listing stays published and shows
the date.

### Share a listing
Use the **Copy Link** button on the listing page. That is the correct link to send
to clients.

---

# PART H — Known traps

| Trap | What happens | Fix |
|---|---|---|
| Publishing with `land_size`/`build_size` = 0 | Card looks unfinished, loses the comparison; backlog grows silently | Gate at D7 — sizes or stay draft |
| Publishing with an empty Internal data block | Broker cannot reach the owner, the listing is unworkable | Second gate at D7 — all six fields or stay draft (`listing-internal-data-gate`) |
| `drive_folder_url` pointing at the owner's folder | Access dies with the owner's link, the published set is not ours | Create our own folder under the right parent and link that |
| Drive folder missing or out of sync with the gallery | No copy of what is actually live; cover and order drift apart | Rebuild the folder to match the published set after every gallery or cover change |
| Assuming `listing-prelisted-enrichment` waives internal data | It waives sizes and photos only | Internal data and the Drive folder are always required |
| Taking a size off a catalogue category page | Belongs to a different property | Number must sit beside the villa's own name |
| Writing through the Lovable connector | The change never reaches the site | Use `execute_sql` on `zveamkyyzfztzppwavws` |
| Folder named after a different villa than the doc | Wrong photos on the listing | Reconcile before uploading |
| Villa name in the title | Competitors find the owner | Descriptive title only |
| No price | Listing does not appear in `/rent` | Market estimate + note in `property_private` |
| No map pin | Villa sits at 0,0, never shows on the map | Add the Maps link |
| Photos of a neighbouring unit | Bedroom count doesn't match the photos | Approval + blur any branding |
| Sale doc used for a rental | Investment copy has to be stripped by hand | Write a rental doc |
| `replace` on a published listing | Rejected — cannot have zero photos | append, then rewrite |
| Rewriting `images` by index after a timeout | Half the gallery becomes `NULL` | Write explicit URLs |
| Import called before the insert commits | Function cannot see the row | Commit first |
| File over 15MB | Importer rejects it | Shrink that one file |
| Dropbox link | Fetches a web page, not a photo | Use Google Drive |
| Comma inside a feature label | The label splits into two | No commas in features |
| Timeout / `499` on import | **Not an error** | Repeat the same call until the count stops rising |
| Judging the cover from a catalogue screenshot | The card is a carousel — the visible frame is not `images[1]` | Read `images[1]`, or the `src` of the card's first image |

---

# PART I — Timing

~10–15 minutes per listing, of which 8–10 is waiting on the photo import.
With **descriptive filenames** and a **complete doc** it drops to ~4–5 minutes.
Listings sent as a batch are processed in parallel — 2 listings take roughly the
time of 1.2.

The 3–4 minutes of checking is what catches the real problems, and is not cut.

