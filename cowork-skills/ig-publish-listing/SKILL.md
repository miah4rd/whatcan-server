---
name: "ig-publish-listing"
description: "Publish a Unicorn Property listing video to Instagram as a Reel and a Story. Use whenever the user sends a video link (Dropbox/Drive/public URL) plus a listing URL or property ID, or says \"post this listing\", \"publish this reel\", \"post to Instagram\"."
---

# Publish a listing to Instagram (Reel + Story)

Publishes a property video to @unicorn.property.bali as a Reel, then the same video as a Story. Runs entirely through the Instagram Graph API from inside the user's browser — no file pickers, no manual uploads.

## Inputs needed
- **Video URL** — a publicly fetchable direct link (Dropbox share link works; convert `?dl=0` → `?dl=1` and use the `dl.dropboxusercontent.com` host). Google Drive links usually fail.
- **Listing URL or property ID** on unicorn-properties.com (e.g. AME-028).

If either is missing, ask for it before doing anything else.

## Critical constraint — why the video URL matters
Instagram's publishing API **refuses to fetch Instagram's own CDN links** (`media_url` from the API returns 403 to Meta's fetcher). Never try to republish a reel by feeding back its own `media_url` — it always fails with a 400 on `media_publish`. Always use an external public URL.

## Account constants
| Item | Value |
|---|---|
| IG user ID | `17841467048778747` |
| IG account | @unicorn.property.bali |
| Facebook Page | `347114105147721` (Unicorn Property) |
| Meta app | Unicorn Stories Autopost, App ID `1063206226435516` |

Access token: an Instagram Login token with `instagram_business_basic` + `instagram_business_content_publish`. It lasts 60 days. If calls return an OAuth error, ask the user to regenerate: Meta app → Use cases → API setup with Instagram login → section 2 → **Generate token** on the unicorn.property.bali row.

## Step 1 — gather listing details
Fetch the listing page with the Chrome tools (`navigate` then `get_page_text`) — the site is client-rendered, so a plain fetch returns an empty shell. Pull: title, price in IDR and USD, bedrooms, bathrooms, build and land size, leasehold years, area, property ID, and the description.

## Step 2 — write the caption
House format:

```
{N} Br Villa in {Area} - Price: IDR {X.XXX}M (${USD})

{Two or three sentences from the listing description — concrete details, materials, views, readiness. No hype adjectives.}

Key points:
Property ID: {ID}
Property Status: {Ready Now / Off-plan}
Price: IDR {X.XXX}M

Leasehold: {N} years
Bedrooms: {N}
Bathrooms: {N}
Build: {N} m2 / Land: {N} m2
Zone: {zone}

{Area}, Bali
Link in bio - {ID}

#balirealestate #balivilla #{area} #baliproperty #villaforsale #investinbali #unicornproperty
```

Note: "IDR 3.210M" in their convention means 3.21 billion rupiah. Show the caption to the user for approval before publishing.

## Step 3 — publish the Reel
Run this in a browser tab via the Chrome `javascript_tool` (any page works; the calls go to graph.instagram.com):

```js
const TOKEN='...', VIDEO='...', CAPTION=`...`;
const r=await fetch('https://graph.instagram.com/v23.0/17841467048778747/media',{
  method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({media_type:'REELS',video_url:VIDEO,caption:CAPTION,share_to_feed:'true',access_token:TOKEN})});
window.__c=(await r.json()).id;
```

Poll until ready, then publish:

```js
// GET https://graph.instagram.com/v23.0/{container}?fields=status_code  → wait for FINISHED
// POST https://graph.instagram.com/v23.0/17841467048778747/media_publish  body: creation_id, access_token
```

Then read back `?fields=permalink` and give the user the link.

## Step 4 — publish the Story
Same two-step flow with `media_type=STORIES` and no caption. **Stories cap at 60 seconds** — if the video is longer, say so and skip the story rather than failing.

## Step 5 — report
Give both permalinks. Story permalinks look like `instagram.com/stories/unicorn.property.bali/{id}` and live 24 hours.

## Known limits — state these plainly, don't attempt workarounds
- **Link stickers cannot be added by API.** "Get more details here" tappable links are app-only, for every tool, not just this one. Only route: post that story by hand from the phone.
- **Reel-sticker reshares** (the tappable preview linking to the original reel) are also app-only.
- **Video prep**: if a source file needs converting to 1080×1920, use ffmpeg via bash, but remember the API needs a *public URL* — a converted local file can't be published without hosting it somewhere public first.

## Optional — the retargeting ad
The user often wants the new reel added as an ad in ad set `120244336747280263` ("Retargeting Bali + World", profile-visit objective). This requires a Facebook ads token with `ads_management` **and** the app to hold Advanced Access for Ads Management. Without that capability, creating the creative succeeds but creating the ad fails: `VIEW_INSTAGRAM_PROFILE` returns "(#3) Application does not have the capability". Don't burn time trying alternate field paths or API versions — they all fail the same way. Either the app gets Advanced Access, or the user duplicates the ad in Ads Manager by hand.

