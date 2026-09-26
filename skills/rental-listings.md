# Rental Listings — the regulation

The funnel where we sign up villas for monthly and yearly rental. This file is the law for the
bot on this funnel. It is written by the owner (Nikita) only. A Claude session may NOT edit it:
if the code disagrees with this file, the code is wrong; if a new rule seems needed, propose it
to the owner in chat and wait for his "yes". Every line carries the date the owner said it.

Approved by the owner: 26.09.2026.

## 1. Stages and who moves them

| Stage | Who moves the card | Owner's word |
|---|---|---|
| BACKLOG – cell has no demand | a person. Reserve: the bot never writes first, but answers if the owner writes | 17.09 |
| Initial Contact → TAKEN TO WORK | the bot, after the first message to the villa | 07.09 |
| TAKEN TO WORK → QUALIFIED (Pre-listed) | the bot, once both facts of §2 are known | 26.09 |
| TAKEN TO WORK → co-broke / long term / Closed-lost | the bot, by the facts of the conversation (§4–5) | 07.09, 15.09 |
| QUALIFIED → Inspection scheduled → live | Yudi through Copilot: books the inspection, after it switches the listing to Listed on the site; the card then goes to live | 14.09, 24.09 |
| live → Weekly Check Sent → Update Availability Received | the bot, the weekly availability check, no approvals | 14.09, 15.09 |

Autopilot: everything up to QUALIFIED and everything from live on. Yudi: only QUALIFIED → live. (24.09)

The inspection report (26.09): every field is required — the villa code, Listed on the site, Red
flags, Green flags and the notes. The report cannot be sent with any of them empty; the button
answers with a popup that names what is missing. No red or green flag at the villa → Yudi writes
so ("nothing special"); such a line is not a flag. The flags decide the order of every client
shortlist (skills/rental.md §5): clients turn villas down over the garden, the living room and
construction nearby.

## 2. What QUALIFIED means (26.09)

Two facts, both required:
1. We are talking to the **owner or the owner's own staff** (villa manager, reception, their sales
   team) — not another agency.
2. The **price**, monthly and/or yearly, **with the position on our 10%**: included or on top.

Not required to qualify: bedrooms, photos, description, minimum stay, a viewing or inspection day.
Bedrooms, photos and description come from the internet (21.09). Photos only from Airbnb and
Booking (17.09). The inspection is Yudi's step AFTER qualification (26.09).

Price floor: 33,000,000 IDR a month, client-facing (net + our 10%). Below it — not listed. (05.09, 26.09)

A villa that is occupied without a date is not qualified yet: ask roughly when it frees up, or for
how long it is taken, then publish with that date. (26.09)

An owner who will quote only once we bring a client with dates is not qualified. Say it plainly:
for a client to come, they need to know the price the owner asks — no price, no client. (26.09)

## 3. What the bot asks

First message: is the villa available for monthly or yearly rent; are you the owner, the owner's
team, or a management company. (14.09)

Then one or two questions per message, in this order (26.09):
1. the price with our 10%;
2. owner or management company;
3. anything else is not for qualification.

In Yudi's style, never more than two questions in a message (21.09). The same question is never
asked twice; a screenshot sent in reply to a question counts as the answer (14.09, 21.09).

## 4. Commission

Ours is 10%. Another rate (5%) is not accepted; such a card does not go to QUALIFIED (26.09). The
commission question is asked at most twice; after that it is recorded as "not confirmed" (20.09).

## 5. Sorting out

- **co-broke** — only another agency acting as intermediary with a commission of its own. Villa
  staff of any level is the owner's side (12.09).
- **Closed-lost** — the villa is for short stays only; it is sold; the owner said no; three nudges
  with no reply (04.09, 07.09).
- **long term** — the villa is occupied and the villa side itself named the date it frees up; all
  five conditions of the 15.09 regulation. It leaves the stage two weeks before that date (15.09).
- The villa side gives us another number — a new card for that number; the old card keeps its
  number (12.09).

## 6. Nudges when the owner goes quiet

After 24 h → 3 days later → 5 days later → 5 more days of silence = Closed-lost (03.09, 04.09).
Only on Initial Contact and TAKEN TO WORK. Only 10:00–20:00 Bali (12.09).

## 7. Sending limits

- First contacts a day: 9 per Yudi number (03.09, 13.09). A one-day exception only on the owner's
  word, for that day (16.09).
- A new number warms up: 3 → 5 → 7 → 9 a day, 45–67 minutes between first contacts (22.09).
- Any send from Yudi's numbers: at most 15 per 10 minutes, 60 per hour (25.09).
- Amelia: no limits (19.09, 25.09).

## 8. After live

Once every 7 days, one short message to the owner: is the villa still available. An answer with a
date the bot writes to the site itself. Yudi gets no pushes and no drafts; an unclear answer is a
note on the card (14.09, 15.09).

Any other message from the owner of a live villa (a question, news, not an answer to the check):
the draft reply goes to Yudi in Copilot for approve (26.09).

## 9. How rules change

- Structure (this file): only the owner, in chat, recorded here with the date.
- Wording, tone, length, timing: learned from Copilot — a broker's edit is a lesson, an approve
  without edit is an accepted example. Never from a session's own judgement.
- A problem seen in another funnel is never fixed by adding a rule to this one.
