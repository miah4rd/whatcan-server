# The regulations — one pool

Everything the owner has decided about how the bots work, in one place. A Claude session reads
these and never edits them; changes are the owner's word in chat, recorded here with the date.
`scripts/law-gate.sh` refuses a deploy that touches a regulation or the code that enforces it
without "Approved by owner DD.MM.YYYY" in the commit; `scripts/regulation-audit.sh` tells the owner
every morning what changed.

| Regulation | Where | Status |
|---|---|---|
| Rental Listings — villa acquisition: stages, QUALIFIED, questions, commission, sorting, nudges, sending limits, weekly check | `skills/rental-listings.md` | approved 26.09.2026 |
| Rental — clients: stages, gates (budget 30M, excluded areas), first two messages, shortlist, viewing, follow-ups | `skills/rental.md` | approved 26.09.2026 |
| long term stage — five conditions, the owner's own date, exit two weeks before | `skills/rental-listings.md` §5 (full text in CLAUDE.md "long term: the whole card…", owner 15.09) | approved 15.09.2026 |
| Listing publication on the site — Internal data gate, photos only from Airbnb/Booking, Pre-listed → Listed, price floor | Cowork skills `listing-upload-regulation`, `listing-internal-data-gate`, `listing-prelisted-enrichment`, `listing-qualification-standard` | owner's, kept in Cowork; must not contradict `rental-listings.md` §2 |
| Inspection report (Copilot form after Yudi's visit) | CLAUDE.md "Inspection report"; skill `inspection-report-in-copilot` | approved 19.09.2026 |
| Viewing report (Copilot form after a client viewing) | `skills/rental.md` §6; CLAUDE.md "The viewing report" | approved 08–09.09.2026 |
| KPI page `/kpi` and the daily numbers | CLAUDE.md "Daily numbers page" | approved 19.09.2026 |
| Quality-control morning report | off since 24.09 on the owner's request | paused |
| UNICORN sales funnel | not written yet — the owner: not now | — |

Settings the owner controls directly (not code): autopilot on/off and threshold per funnel
(Copilot 🤖 panel), weekly availability mode, the budget threshold. The morning audit reports
their current values and any change.
