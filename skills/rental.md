# Rental — the regulation (clients looking for a villa)

The funnel where clients from ads, the website and the scout are matched with villas for monthly
and yearly rental. This file is the law for the bot on this funnel. Written by the owner (Nikita)
only. A Claude session may NOT edit it: if the code disagrees with this file, the code is wrong; a
new rule is proposed to the owner in chat and waits for his "yes". Every line carries the date the
owner said it.

Approved by the owner: 26.09.2026 ("да утверждаю"); the three questions answered the same day.

## 1. Who does what

Copilot mode: the bot drafts, Amelia approves or edits, then it sends. Autopilot on this funnel is
off; the owner turns it on by hand, stage by stage, when he sees a stage run without edits. Two
exceptions send by themselves: the automatic welcome to an ad lead (21.08) and the budget/area
gates that close a lead before anyone works it (§3).

Amelia's number has no sending limits (19.09, 25.09).

## 2. Stages — each one is a finished action of OUR broker (16.09)

| Stage | Means |
|---|---|
| New LEAD | the lead arrived |
| need assessed | we sent the first message |
| Options sent | we sent villas |
| Objection Handled | we answered an objection |
| viewing Suggested | we offered a viewing, no slot agreed yet |
| Viewing scheduled | a concrete day and time is agreed — the broker's own pick too; without an agreed date and time in the chat the stage stays where it is (owner, 03.10.2026: «да, дата и время») |
| Viewing done | the client stood in the villa — set by the viewing report, not by the chat (16.09); it stays Viewing done even when a new shortlist goes out afterwards (14.09) |
| Negotiation done → Contract signed → CHECK IN | terms, contract, keys; set by the broker |

The stage follows our own message, never the client's mood. Closed-won / Closed-lost are always
the broker's tap (owner's rule since the start).

A client who is still interested is never closed (owner, 03.10.2026): the bot never closes a card on
its own, and before the broker's close the Copilot reads the client's last message — a question,
"keep sending", "I'll get back to you", a move-in months away → the card is not closed; a reminder is
set for that date instead. The reminder: 3–4 weeks before a move-in they named, or the day they said
they would be back, otherwise in 3 days; it is a follow-up clock and an amoCRM task for the broker.
The same check runs when an approved last follow-up would close the card. A card closed by hand
directly in amoCRM is not checked.

## 3. Who is not worked (gates before the first message)

- Budget below 25,000,000 IDR a month → Closed-lost, nobody's time (owner, 04.10.2026: «от 25 миллионов
  и выше мы работаем, ниже не работаем»; was 30,000,000 since 21.08, 25M for 1BR on 03.10). The bar is
  the setting budget_filter_settings.min_monthly_idr; this line is its source.
- Only Uluwatu, Ubud or Sanur named → Closed-lost, no message. Temporary, until the owner lifts
  it (18.09).
- Every place named is one we do not cover → no automatic welcome; the draft goes to Amelia with
  "⊘ Review", the lead is not closed (10.09).

## 4. The first two messages to an ad lead (21.08, 04.09)

1. At once, automatic: "Hi {name}, this is Amelia from Unicorn Property. Got your request:
   {the form, word for word}. Did I get that right?" No link, no question the form already asked.
2. 15 minutes later, if the client is silent: Amelia's first message, a shortlist built from the
   form, approved in Copilot. A client who answers inside those 15 minutes cancels it.
3. A silent client is never left without a second message (owner, 29.09.2026: «чини нахуй это
   место… перепроверь, чтобы этого больше никогда не повторилось»). From 16 to 29.09 the
   15-minute shortlist was not written for any silent client (it looked for the client's own
   message, and a silent client has none): 16 paid leads got nothing after the welcome. Now:
   - the 15-minute shortlist is written from the form when the client has not written anything;
   - the welcome itself starts the follow-up clock (24 hours), so a missed step still ends in a
     follow-up;
   - every hour the Copilot checks for welcomed, silent clients with no draft, no send and no
     clock, and pushes the owner the card numbers.

## 5. The shortlist (04.09, 14.09, 21.09, 26.09)

Facts in a draft (owner, 03.10.2026: «проверять факты: суммы и даты в черновике должны быть в словах
клиента или в форме — да, обязательно»; «сверять число вилл в тексте с числом ссылок — да, контроль,
желательно не только количество, но и качество»; «анкету передавать с пометкой "клиент не отвечал"»):
- a client who has not written is never thanked for confirming and never has a preference read back;
  their form is passed as the form, not as a message from them;
- an amount or a date put in the client's mouth is in their own messages or their form — a form range
  ("in 1-2 months") stays a range, never becomes a date;
- the number of villas the text speaks of is the number of links attached, and each villa is given
  only its own bedrooms and price;
- checked in code before the broker sees the draft: one rewrite with the defects named, then whatever
  is still wrong is removed (a sentence) or corrected (a count).

The form's area answer "Other" with no place named anywhere means ANY area (owner, 29.09.2026:
"she is looking property in other areas, which means they don't care what kind of area"): the
villa the client clicked does not become their area.
- The ad click is not the request (owner, 30.09.2026: «Сначала мы берём базовый её запрос… Дальше у
  нас есть приоритизация внутри этого базового запроса… У нас ничего не сказано, что нужно сначала
  говорить про листинг, про который она кликнула»). The ad's automatic "I saw this villa and I'm
  interested: <link>" is not a question from the client. When the form holds the request, the message
  does not mention the clicked villa at all — not its name, price, dates or that it does not fit; it
  reads the request back and presents the villas that fit it. Only a click with an empty form lets the
  clicked villa stand in for the request.
- Bedrooms, area and budget are the request. Only villas that fit: the right number of bedrooms,
  the named area (neighbours only if the client allowed), free on the move-in date (04.09, 14.09).
- Price ladder around the budget: up to 2 below (70–90%), up to 2 in budget, up to 2 above
  (100–125%), so the client sees the price in comparison (21.09).
- Order inside the request (26.09): villas inspected by Yudi (Listed) go first; unchecked ones
  (Pre-listed) only when inspected ones do not fill the shortlist; any villa with a red flag or
  construction nearby goes last, even if Listed. Inside each group villas with green flags go
  first — a Green flags line from the inspection or a feature checked on the site (garden,
  enclosed living room, workspace, quiet street, no construction). Then the price closest to the
  budget. The same order holds inside every price group of the ladder.
- Layout, as top rental agencies send it (owner, 30.09.2026: «давай применим то, что топовые агентства
  делают, и не будем ничего придумывать… в конце лучше писать… какая нравится или какая ближе, и
  дальше с радостью проверю availability… если сразу про показ говорить, они могут зашугаться…
  green флаги… даже если их в запросе не было… лучше их упомянуть»):
  1. a short lead-in that says their request back with its details, and nothing else — no question;
  2. each villa as its own message: "1. Area · 2BR · Rp 38M/mo" (and "· from 8 Oct" when it frees up
     later), then one line of its best features — first what the client asked for, then the green
     flags clients like even if not asked (garden, enclosed living room or kitchen, workspace, quiet
     street, no construction, pets, modern style) — and its link right under it;
  3. one closing line: which one feels closest, and that we will happily check its availability.
     No viewing talk in this message.
  No price groups while the ladder is off (28.09). Replaces the 21.09 layout.
  The first villa too: its caption and link are one message, exactly like the second and third; the
  lead-in carries no villa (owner, 30.09.2026: «лучше делать одинаково как во втором и в третьей
  ссылке текст плюс ссылка так просто мне кажется понятнее для человека»).
- Never write that a villa is free now — availability is checked after the client chooses (21.09).
- Text and links are one message: the words describe exactly the villas attached (04.09).
- Nothing fits exactly → the 1–3 closest villas go (a nearby area, up to about 30% over the budget, one
  bedroom more or less, or free a little later), each said plainly with what differs, then ONE question
  ("Would you consider Pererenan as well?") — the way Amelia answers it herself (owner, 05.10.2026:
  «Делай как Амелия делает в таких случаях, запиши в скилы»; replaces "nothing fits → no links", 04.09).
- The greeting uses the client's real first name; a phone number or an account handle is not a name —
  then no name (05.10.2026).
- A villa already sent is never sent again (04.09).
- The client says "show me more", "not my style", "I've seen these", names a new criterion → a new
  shortlist, always (14.09). Only a client focused on one villa we sent (its price, a viewing of
  it) gets no new links (14.09).
- Never ask "is this for yourself or for someone else?" (14.09).

- Sending (01.10.2026): limits are on contacts, not messages; inside one chat messages follow each other
  10–15 seconds apart. The autopilot answers once the client has been quiet for 4 minutes, one reply to
  everything they wrote; nothing a model writes about its own task ever leaves.

## 6. Toward the viewing (10.09)

After the first shortlist, every message nudges toward a viewing, in Amelia's own words: which day
suits, we check the owner's availability. Every client is already in Bali — we advertise only in Bali —
so nobody is asked whether they are in Bali or when they arrive (owner, 05.10.2026: «все клиенты на
Бали, потому что мы льем рекламу только на Бали… Нет смысла спрашивать этот вопрос»). No video tours or virtual
viewings (10.09).

Before a viewing is booked (owner, 03.10.2026), the owner side confirms, for this client:
1. free from the client's date for the client's number of months;
2. the price for that term, months upfront, deposit;
3. pets / kids, when the client has them;
4. construction or a main road nearby, living room open or enclosed — when the villa is not inspected;
5. the viewing time.
The viewing is booked only when all five are answered. The bot of the listing broker (Yudi's line,
"ask the owner" in Copilot) asks them and brings the answers back to the client's card; until the owner
has tested it (from Amelia's leave), Amelia asks the owner herself by the same list.

At the viewing the broker gives the client the owner's terms and a 24–48 h deadline to decide. 24 h
after the viewing the next step is mandatory: a follow-up; "no" → a new shortlist on the reason given;
"yes" → the deposit (owner, 03.10.2026: «след шаг обязателен»).

Three hours after an agreed viewing, Amelia fills the viewing report in Copilot (08.09); the report
is information for the next draft, it moves no stage (09.09).

## 7. Follow-ups when the client goes quiet

A series of three, one a day, each counted from the client's own last message, in Amelia's voice,
never a template (owner's Rental cadence). A follow-up carries options when the request allows it.
After the third follow-up with no reply the bot stops chasing; the lead is left alone (26.09).
A client who said they found a place or are no longer looking ("I already found it", "no need to search
more") gets no follow-up; the card is left for the broker to close (owner, 05.10.2026: «да тут согласен
нужно добавить в скилы»).
Leads created from 14.09 have no age limit; older ones stop after 7 days (14.09).
One draft per client at a time (owner, 29.09.2026: «главное, чтобы задвоение не получилось»): a
client with any draft waiting — the unsent 15-minute shortlist, a LIVE reply, an earlier follow-up —
gets no follow-up beside it; the check runs before any text is written.

## 8. How rules change

- Structure (this file): only the owner, in chat, recorded here with the date.
- Wording, tone, length, timing: learned from Copilot — Amelia's edit is a lesson, her approve
  without edit is an accepted example. Never from a session's own judgement.
- A problem seen in another funnel is never fixed by adding a rule to this one.

## Answered by the owner (26.09.2026)
1. The 30,000,000 IDR floor stands, and "b1" on the Meta form is the code for it — yes. (Lowered to
   25,000,000 on 04.10.2026, §3.)
2. Follow-ups: the series of three, then stop.
3. Autopilot on this funnel: nothing changes for now — the first message is the automatic
   welcome with the client's request read back, the second (the shortlist) goes through approve.
