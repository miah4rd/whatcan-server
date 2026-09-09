#!/usr/bin/env python3
"""Replay a broker revision against the LIVE /api/public/suggest, without
touching the pending row (no pendingId) and without teaching the real broker
(brokerId nikita-test). Run on the server:

  python3 scripts/replay-suggest.py 23499235 "send 2BR options in Berawa under 50M" \
      [--draft "current draft text"] [--curated] [--attach R-YUD-072,R-UM-024] \
      [--prior "earlier instruction" ...]

Prints the links and the text that the broker would see. This is how the
08.09.2026 edit-path bugs were reproduced and verified — run the real
revisions from the log (grep 'one-pass compose' /var/log/whatcan.log) before
deploying a change to suggest.ts / property-catalog.ts / generate-suggestion.ts.
"""
import argparse, json, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("lead_id")
ap.add_argument("revision")
ap.add_argument("--draft", default="Thanks for your request — would you consider a 2-bedroom as well?")
ap.add_argument("--prior", action="append", default=[], help="earlier instruction(s) of the same editing session, oldest first")
ap.add_argument("--attach", default="", help="comma-separated listing ids currently on the draft")
ap.add_argument("--curated", action="store_true", help="the broker touched the link list by hand")
ap.add_argument("--name", default="Client")
ap.add_argument("--stage", default="Options sent")
ap.add_argument("--broker", default="nikita-test")
ap.add_argument("--api", default="http://127.0.0.1:5000/api/public/suggest")
a = ap.parse_args()

chain = [{"draft": a.draft, "feedback": p} for p in a.prior] + [{"draft": a.draft, "feedback": a.revision}]
attachments = [
    {"type": "link", "url": f"https://unicorn-properties.com/property/{i.strip().upper()}", "label": i.strip().upper()}
    for i in a.attach.split(",") if i.strip()
]
body = {
    "guide": "x", "lead": {"name": a.name, "company": "", "stage": a.stage}, "messages": [],
    "brokerId": a.broker, "brokerName": "Amelia", "leadId": a.lead_id, "revisionChain": chain,
    "attachments": attachments, "attachmentsCurated": a.curated, "outputLanguage": "English",
}
req = urllib.request.Request(a.api, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
t = time.time()
r = json.loads(urllib.request.urlopen(req, timeout=180).read().decode())
att = r.get("attachments")
print(f"({time.time() - t:.1f}s) links:", "untouched" if att is None else [x.get("url", "").split("/property/")[-1] for x in att])
print("text:")
print(r.get("text", ""))
