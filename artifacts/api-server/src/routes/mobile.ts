import { Router } from "express";

const router = Router();

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>Copilot Inbox</title>
<link rel="manifest" href="data:application/manifest+json,${encodeURIComponent(JSON.stringify({
  name: "Copilot Inbox",
  short_name: "Copilot",
  start_url: "/m",
  display: "standalone",
  background_color: "#0f1320",
  theme_color: "#0f1320",
}))}" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; background: #0f1320; color: #e6e8ee;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh; padding-bottom: env(safe-area-inset-bottom);
  }
  header {
    position: sticky; top: 0; z-index: 5; background: #141827; border-bottom: 1px solid #2a3146;
    padding: 12px 16px calc(10px + env(safe-area-inset-top)) 16px; padding-top: max(12px, env(safe-area-inset-top));
  }
  /* Wrap, or the header runs off the phone. At 375px the controls group is
     366px wide on its own: with the brand beside it the row measured 457px,
     so the refresh, notification and autopilot buttons sat entirely past the
     right edge — unreachable on a phone, with the page scrolling sideways. */
  .top-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .top-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; min-width: 0; flex-wrap: wrap; justify-content: flex-end; }
  /* A select will not shrink below its longest option unless told to, and at
     its natural 173px the five controls needed 364px in a 343px row — which
     bounced the autopilot button onto a line of its own. Capped so the whole
     group stays on one row; the option text ellipsises, which is fine. */
  .top-actions select.broker-chip { min-width: 0; max-width: 34vw; }
  .brand { font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .brand .dot { width: 8px; height: 8px; border-radius: 50%; background: #2dd4bf; }
  .broker-chip {
    font-size: 12px; color: #8a93a8; background: #181d2e; border: 1px solid #2a3146;
    border-radius: 20px; padding: 5px 12px; display: flex; align-items: center; gap: 6px;
  }
  .broker-chip b { color: #e6e8ee; }
  .refresh-btn { background: none; border: none; color: #8a93a8; font-size: 18px; padding: 4px 8px; cursor: pointer; }
  .tabs { display: flex; gap: 6px; margin-top: 10px; }
  .tab {
    flex: 1; text-align: center; padding: 9px 4px; border-radius: 10px; font-size: 13px; font-weight: 600;
    background: #181d2e; color: #8a93a8; border: 1px solid #2a3146; position: relative; cursor: pointer;
  }
  .tab.active { background: #2dd4bf; color: #06121a; border-color: #2dd4bf; }
  .tab .count {
    display: inline-block; margin-left: 5px; background: rgba(255,255,255,.18); border-radius: 10px;
    padding: 1px 6px; font-size: 11px;
  }
  .tab.active .count { background: rgba(0,0,0,.15); }
  main { padding: 12px; max-width: 640px; margin: 0 auto; }
  .empty { text-align: center; color: #6b7488; padding: 60px 20px; font-size: 14px; }
  .card {
    background: #181d2e; border: 1px solid #2a3146; border-radius: 12px; padding: 14px;
    margin-bottom: 10px; cursor: pointer;
  }
  .card:active { background: #1d2338; }
  .card-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .card-lead-link { font-weight: 700; font-size: 14.5px; color: #7dd3fc; text-decoration: none; }
  .card-lead-link .dim { opacity: .55; font-weight: 400; }
  .card-time { font-size: 11px; color: #6b7488; white-space: nowrap; }
  .card-notes { font-size: 11px; color: #6b7488; margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badges { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
  .badge { font-size: 10.5px; padding: 2px 8px; border-radius: 6px; font-weight: 600; }
  .badge.stage { background: #2a3146; color: #b6bccd; }
  .badge.stagepill { background: rgba(139,92,246,.18); color: #a78bfa; }
  .badge.overdue { background: #4a1f24; color: #f87171; }
  .badge.today { background: #1f3a2e; color: #4ade80; }
  .badge.notask { background: #23293b; color: #6b7488; }
  .badge.temp-hot { background: rgba(239,68,68,.16); color: #fca5a5; }
  .badge.temp-warm { background: rgba(251,146,60,.16); color: #fdba74; }
  .badge.temp-cold { background: rgba(96,165,250,.14); color: #93c5fd; }
  .badge.discard { background: rgba(148,163,184,.16); color: #cbd5e1; }
  /* Report tab. Deliberately not a dashboard: one headline, a few big
     numbers, then plain lines. Anything denser gets swiped past. */
  .rep-hero { background: #181d2e; border: 1px solid #2a3146; border-radius: 12px; padding: 16px; margin-bottom: 10px; }
  .rep-hero .when { font-size: 11px; color: #6b7488; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; }
  .rep-headline { font-size: 16px; font-weight: 700; line-height: 1.35; margin-top: 6px; }
  .rep-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .rep-stat { flex: 1 1 88px; background: #141827; border: 1px solid #2a3146; border-radius: 10px; padding: 10px 12px; }
  .rep-stat .n { font-size: 22px; font-weight: 800; line-height: 1.1; }
  .rep-stat .l { font-size: 10.5px; color: #8a93a8; margin-top: 3px; line-height: 1.3; }
  .rep-alert { color: #f87171; }
  .rep-good { color: #4ade80; }
  .rep-head { font-size: 11px; font-weight: 700; color: #7a8699; text-transform: uppercase; letter-spacing: .05em; margin: 16px 0 6px; }
  .rep-line { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; font-size: 13px; padding: 8px 2px; border-bottom: 1px solid #232a3d; }
  .rep-line:last-child { border-bottom: none; }
  .rep-line .v { font-weight: 700; white-space: nowrap; }
  .rep-delta { font-size: 11px; color: #6b7488; font-weight: 600; margin-left: 6px; }
  .rep-periods { display: flex; gap: 6px; margin-bottom: 12px; }
  .rep-periods .p { flex: 1; text-align: center; padding: 7px 4px; border-radius: 8px; font-size: 12px; font-weight: 700; background: #181d2e; color: #8a93a8; border: 1px solid #2a3146; cursor: pointer; }
  .rep-periods .p.on { background: #2a3146; color: #e6e8ee; }
  .rep-name { font-size: 14px; font-weight: 800; margin-bottom: 2px; }
  /* Add-a-listing screen. A chat plus the card it is building, in that order:
     the broker talks, and the card underneath is what will actually be
     published — never a hidden state they have to trust. */
  .li-note { font-size: 12.5px; color: #8a93a8; line-height: 1.55; margin-bottom: 12px; }
  .li-chat { background: #141827; border: 1px solid #2a3146; border-radius: 12px; padding: 10px; max-height: 44vh; overflow-y: auto; margin-bottom: 10px; }
  .li-msg { margin-bottom: 10px; }
  .li-msg:last-child { margin-bottom: 0; }
  .li-msg .who { font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; margin-bottom: 3px; }
  .li-msg.me .who { color: #64b5f6; }
  .li-msg.ai .who { color: #2dd4bf; }
  .li-bub { padding: 9px 12px; border-radius: 8px; font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
  .li-msg.me .li-bub { background: rgba(33,150,243,.15); border: 1px solid rgba(33,150,243,.3); color: #d4eaff; }
  .li-msg.ai .li-bub { background: rgba(45,212,191,.1); border: 1px solid rgba(45,212,191,.28); color: #c8f5e0; }
  .li-thumbs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 7px; }
  .li-thumb { position: relative; }
  .li-thumb img { width: 56px; height: 56px; object-fit: cover; border-radius: 6px; border: 1px solid #2a3146; display: block; }
  .li-thumb .x {
    position: absolute; top: -6px; right: -6px; width: 19px; height: 19px; border-radius: 50%;
    background: #4a1f24; color: #fca5a5; border: 1px solid #6b2b32; font-size: 11px; line-height: 17px;
    text-align: center; cursor: pointer; font-weight: 700;
  }
  .li-compose { background: #181d2e; border: 1px solid #2a3146; border-radius: 12px; padding: 10px; margin-bottom: 12px; }
  .li-compose textarea {
    width: 100%; min-height: 74px; background: #0f1320; color: #e6e8ee; border: 1px solid #2a3146;
    border-radius: 8px; padding: 10px; font-size: 14px; font-family: inherit; resize: vertical;
  }
  .li-actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  .li-btn { background: #2dd4bf; color: #06121a; border: none; border-radius: 8px; padding: 9px 16px; font-weight: 700; font-size: 13px; cursor: pointer; }
  .li-btn[disabled] { opacity: .38; cursor: default; }
  .li-btn.ghost { background: #181d2e; color: #e6e8ee; border: 1px solid #2a3146; }
  .li-card { background: #181d2e; border: 1px solid #2a3146; border-radius: 12px; padding: 14px; margin-bottom: 12px; }
  .li-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .li-f { flex: 1 1 140px; min-width: 0; }
  .li-f.wide { flex-basis: 100%; }
  .li-f label { display: block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #8a93a8; margin-bottom: 4px; }
  .li-f input, .li-f select, .li-f textarea {
    width: 100%; background: #0f1320; color: #e6e8ee; border: 1px solid #2a3146;
    border-radius: 8px; padding: 8px 10px; font-size: 13.5px; font-family: inherit;
  }
  .li-f textarea { min-height: 78px; resize: vertical; }
  .li-f.miss input, .li-f.miss select, .li-f.miss textarea { border-color: #b45252; }
  .li-ok { background: rgba(74,222,128,.1); border: 1px solid rgba(74,222,128,.35); color: #86efac; border-radius: 12px; padding: 14px; margin-bottom: 12px; font-size: 13.5px; line-height: 1.6; }
  .li-ok a { color: #7dd3fc; word-break: break-all; }
  .li-err { background: rgba(248,113,113,.1); border: 1px solid rgba(248,113,113,.35); color: #fca5a5; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; font-size: 13px; line-height: 1.5; }
  /* Notification enrolment. A browser only ever hands out a push subscription
     to the device that granted permission, so the server cannot switch anyone
     on — the one thing the page CAN do is refuse to be quiet about it. */
  .push-banner { background: rgba(251,191,36,.1); border: 1px solid rgba(251,191,36,.35); color: #fbbf24; border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; font-size: 13px; line-height: 1.5; }
  .push-banner b { color: #fde68a; }
  .push-banner .act { display: inline-block; margin-top: 9px; background: #fbbf24; color: #241a04; border: none; border-radius: 8px; padding: 8px 14px; font-weight: 700; font-size: 13px; cursor: pointer; text-decoration: none; }
  .stage-hint { font-size: 11.5px; color: #7dd3fc; background: rgba(45,212,191,.08); border: 1px solid rgba(45,212,191,.2); border-radius: 8px; padding: 7px 10px; margin-bottom: 8px; }
  .stage-hint .dim { color: #6b7488; }
  .card-preview { font-size: 13px; color: #b6bccd; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .card-foot { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 10px; color: #7a8699; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
  .card-arrow { margin-left: auto; color: #2dd4bf; font-size: 13px; }
  /* Detail view */
  .detail-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
  .back-btn { background: #181d2e; border: 1px solid #2a3146; color: #e6e8ee; border-radius: 8px; padding: 7px 12px; font-size: 13px; cursor: pointer; }
  .openlead-btn { font-size: 11px; font-weight: 700; color: #7dd3fc; text-decoration: none; background: rgba(45,212,191,.1); border: 1px solid rgba(45,212,191,.25); border-radius: 8px; padding: 7px 10px; white-space: nowrap; }
  .lead-hdr { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
  .lead-hdr-name { font-size: 16px; font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .thread-lbl { font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: #5e7a96; margin-bottom: 6px; }
  .conv { background: #141827; border: 1px solid #2a3146; border-radius: 10px; padding: 10px; margin-bottom: 14px; max-height: 260px; overflow-y: auto; }
  .tmsg { margin-bottom: 10px; }
  .tmsg:last-child { margin-bottom: 0; }
  .tmsg-hdr { margin-bottom: 3px; display: flex; justify-content: space-between; }
  .tsender { font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
  .tmsg.us .tsender { color: #64b5f6; }
  .tmsg.lead .tsender { color: #34d399; }
  .tat { font-size: 10px; color: #5e7a99; }
  .tbubble { padding: 9px 12px; border-radius: 8px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .tmsg.us .tbubble { background: rgba(33,150,243,.15); border: 1px solid rgba(33,150,243,.3); border-left: 3px solid #2196f3; color: #d4eaff; }
  .tmsg.lead .tbubble { background: rgba(52,211,153,.12); border: 1px solid rgba(52,211,153,.3); border-left: 3px solid #34d399; color: #c8f5e0; }
  .no-conv { color: #6b7488; font-size: 13px; text-align: center; padding: 10px; }
  label.section { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #8a93a8; margin: 0 0 6px; }
  .body-block { margin: 0 0 14px; }
  .msg-text { font-size: 14.5px; line-height: 1.6; white-space: pre-wrap; }
  .err-text { color: #fca5a5; font-size: 12px; margin-top: 8px; }
  .skel { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
  .skel div { height: 11px; background: rgba(255,255,255,.06); border-radius: 5px; animation: pulseskel 1.2s ease-in-out infinite; }
  .skel div:nth-child(1) { width: 100%; } .skel div:nth-child(2) { width: 92%; } .skel div:nth-child(3) { width: 80%; } .skel div:nth-child(4) { width: 60%; }
  @keyframes pulseskel { 0%,100% { opacity: .5 } 50% { opacity: 1 } }
  textarea {
    width: 100%; min-height: 140px; background: #141827; color: #e6e8ee; border: 1px solid #2a3146;
    border-radius: 10px; padding: 12px; font-size: 14.5px; line-height: 1.55; font-family: inherit;
    resize: vertical;
  }
  textarea:focus { outline: none; border-color: #2dd4bf; }
  .ai-input-wrap { display: flex; flex-direction: column; gap: 8px; background: #141827; border: 1px solid #2a3146; border-radius: 10px; padding: 10px; margin-top: 10px; }
  .aiinput { width: 100%; min-height: 44px; background: transparent; color: #e6e8ee; border: none; outline: none; font-size: 13px; font-family: inherit; resize: none; padding: 0; }
  .ai-btn-row { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
  .ai-mic-btn { border: 1px solid #2a3146; background: transparent; color: #8a93a8; border-radius: 8px; padding: 6px 12px; font-size: 12.5px; cursor: pointer; }
  .ai-mic-btn.recording { background: #ef4444; border-color: #ef4444; color: #fff; }
  .ai-send-btn { border: none; background: #2dd4bf; color: #06121a; border-radius: 8px; padding: 6px 14px; font-size: 12.5px; font-weight: 700; cursor: pointer; }
  .ai-send-btn:disabled { opacity: .5; }
  .action-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding: 10px; background: #141827; border: 1px solid #2a3146; border-radius: 10px; flex-wrap: wrap; }
  .action-row-lbl { font-size: 12px; color: #8a93a8; font-weight: 600; }
  .ext-cb { width: 16px; height: 16px; accent-color: #2dd4bf; }
  .ext-select { flex: 1; min-width: 120px; background: #181d2e; border: 1px solid #2a3146; border-radius: 6px; color: #e6e8ee; font-size: 12px; padding: 5px 8px; }
  .ext-select:disabled { opacity: .4; }
  .actions { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
  button.act { flex: 1; min-width: 100px; border: none; border-radius: 10px; padding: 13px 10px; font-size: 14px; font-weight: 700; cursor: pointer; }
  button.approve { background: #2dd4bf; color: #06121a; }
  button.skip { background: #181d2e; color: #b6bccd; border: 1px solid #2a3146; }
  button.replied { background: #181d2e; color: #b6bccd; border: 1px solid #2a3146; }
  button.edit { background: #181d2e; color: #b6bccd; border: 1px solid #2a3146; }
  button.act:disabled { opacity: .5; }
  .edit-ok, .edit-x { width: 48px; height: 48px; border-radius: 10px; font-size: 19px; cursor: pointer; flex: none; }
  .edit-ok { border: none; background: #2dd4bf; color: #06121a; }
  .edit-x { border: 1px solid #2a3146; background: #181d2e; color: #b6bccd; }
  .stage-confirm { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; width: 100%; }
  .stage-confirm-lbl { font-size: 12px; color: #8a93a8; flex: 0 0 100%; }
  .skip-panel { margin-top: 10px; padding: 10px; background: #141827; border: 1px solid #2a3146; border-radius: 10px; }
  .skip-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .skip-lbl { font-size: 12px; color: #8a93a8; }
  .mini { height: 34px; border-radius: 8px; border: 1px solid #2a3146; background: transparent; color: #cfd5e3; cursor: pointer; padding: 0 10px; font-size: 12px; font-weight: 700; }
  .mini-danger { color: #f87171; }
  .atts { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
  .att { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: rgba(255,255,255,.04); border: 1px solid #2a3146; border-radius: 8px; font-size: 12px; color: #cfd5e3; }
  .att-reminder { border-color: rgba(251,191,36,.3); background: rgba(251,191,36,.06); color: #fde68a; }
  .att-img img { max-width: 140px; max-height: 100px; border-radius: 6px; display: block; }
  .attlbl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attrm { width: 22px; height: 22px; border-radius: 6px; border: none; background: rgba(239,68,68,.15); color: #fca5a5; cursor: pointer; flex: none; }
  .att-add-row { display: flex; gap: 6px; margin-top: 8px; }
  .att-add-input { flex: 1; min-width: 0; background: #141827; color: #e6e8ee; border: 1px solid #2a3146; border-radius: 8px; padding: 8px 10px; font-size: 12.5px; font-family: inherit; }
  .att-add-input:focus { outline: none; border-color: #2dd4bf; }
  .att-add-btn { background: #23293b; color: #b6bccd; border: 1px solid #2a3146; border-radius: 8px; padding: 8px 12px; font-size: 12.5px; font-weight: 600; cursor: pointer; flex: none; }
  .att-pick-btn { display: block; width: 100%; background: rgba(45,212,191,.14); color: #2dd4bf; border: 1px solid rgba(45,212,191,.4); border-radius: 8px; padding: 10px 12px; font-size: 12.5px; font-weight: 700; cursor: pointer; margin-top: 8px; }
  .picker-overlay { position: fixed; inset: 0; z-index: 999; background: rgba(6,10,16,.78); display: flex; align-items: center; justify-content: center; padding: 12px; box-sizing: border-box; opacity: 0; transition: opacity .16s ease; }
  .picker-overlay.show { opacity: 1; }
  .picker-modal { width: 100%; height: 100%; max-width: 720px; background: #181d2e; border: 1px solid #2a3146; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; transform: scale(.97) translateY(6px); transition: transform .18s ease; }
  .picker-overlay.show .picker-modal { transform: none; }
  .picker-hdr { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: #141827; border-bottom: 1px solid #2a3146; font-size: 12.5px; font-weight: 700; color: #e6e8ee; }
  .picker-close { background: none; border: none; color: #94a3b8; font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 6px; }
  .picker-modal iframe { flex: 1 1 auto; border: none; width: 100%; background: #181d2e; opacity: 0; transition: opacity .25s ease; }
  .picker-modal iframe.loaded { opacity: 1; }
  .stage-toggle { background: none; border: none; color: #6b7488; font-size: 12px; padding: 6px 0; margin-bottom: 4px; cursor: pointer; text-decoration: underline; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #181d2e; border: 1px solid #2a3146; color: #e6e8ee; padding: 10px 18px; border-radius: 10px; font-size: 13px; z-index: 20; max-width: 90vw; text-align: center; }
  .setup { max-width: 340px; margin: 80px auto; padding: 24px; text-align: center; }
  .setup input { width: 100%; background: #181d2e; color: #e6e8ee; border: 1px solid #2a3146; border-radius: 8px; padding: 12px; font-size: 15px; margin: 14px 0; }
  .setup button { width: 100%; background: #2dd4bf; color: #06121a; border: none; border-radius: 8px; padding: 12px; font-size: 15px; font-weight: 700; cursor: pointer; }
  .temp-ctl { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: -4px 0 14px; }
  .temp-ctl-lbl { font-size: 11.5px; color: #6b7488; font-weight: 600; margin-right: 2px; }
  .temp-btn { font-size: 11.5px; font-weight: 700; padding: 4px 9px; border-radius: 7px; border: 1px solid #2a3146; background: transparent; color: #8a93a8; cursor: pointer; }
  .temp-btn.temp-hot.active { border-color: rgba(239,68,68,.5); background: rgba(239,68,68,.16); color: #fca5a5; }
  .temp-btn.temp-warm.active { border-color: rgba(251,146,60,.5); background: rgba(251,146,60,.16); color: #fdba74; }
  .temp-btn.temp-cold.active { border-color: rgba(96,165,250,.5); background: rgba(96,165,250,.14); color: #93c5fd; }
  .ctx-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .ctx-btn { background: #23293b; color: #b6bccd; border: 1px solid #2a3146; border-radius: 8px; padding: 8px 12px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .ctx-attached { font-size: 12px; color: #6ee7b7; display: inline-flex; align-items: center; gap: 6px; }
  .ctx-x { width: 20px; height: 20px; border-radius: 5px; border: none; background: rgba(239,68,68,.15); color: #fca5a5; cursor: pointer; }
  .resched-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .resched-toggle { background: none; border: none; color: #6b7488; font-size: 12px; padding: 4px 0; cursor: pointer; text-decoration: underline; }
  .resched-date { background: #141827; color: #e6e8ee; border: 1px solid #2a3146; border-radius: 8px; padding: 7px 10px; font-size: 12.5px; font-family: inherit; }
  .conv-resize { height: 12px; margin: -6px 0 8px; cursor: ns-resize; display: flex; align-items: center; justify-content: center; touch-action: none; }
  .conv-resize::before { content: ""; width: 44px; height: 4px; border-radius: 3px; background: #2a3146; }
  .conv-resize:hover::before { background: #3b445e; }
</style>
</head>
<body>
<div id="app"></div>
<script>
(function () {
  var API = location.origin + "/api/public";
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var app = $("#app");

  var DEFAULT_GUIDE = [
    'You are a senior Bali real estate broker working directly with international clients on behalf of Unicorn Property, a real estate agency in Bali.',
    'You do not speak as "Robert\\'s assistant" or "the assistant of the broker". You speak as the broker directly.',
    'You represent yourself as a real person in the sales process, not as an AI. You communicate with clients mainly through WhatsApp, sometimes email, and your goal is to guide qualified buyers through the Bali real estate market, understand their needs, build trust, handle objections, and move them toward a call, meeting, viewing, reservation, or next clear step.',
    'Your role is not to simply send listings. Your role is to act as a market advisor, investment consultant, and deal guide.',
    '',
    'You help clients understand:',
    '- The Bali market: villas, land, off-plan, developer projects, private sellers',
    '- Legal structures: leasehold vs freehold, PT PMA, nominee arrangements',
    '- Realistic ROI and rental yield (honest, not inflated)',
    '- Due diligence, which developers to trust, and pitfalls to avoid',
    '',
    'MESSAGE RULES:',
    '- Address the lead by first name. Always.',
    '- Be warm, concise, confident. No corporate fluff.',
    '- Reference the last thing the lead said — continuity matters.',
    '- One clear question or CTA per message. Never two.',
    '- Under 100 words unless the situation genuinely requires more.',
    '- Sign off as Robert (first name only).',
    '',
    'DO NOT:',
    '- Claim guaranteed ROI, occupancy rates, or resale values.',
    '- Push apartments — Bali is a villa and land market.',
    '- Apologize for following up or sound desperate.',
    '- Send "just checking in" or any generic filler.',
    '- Sound like a bot or paste a template unchanged.',
    '- Repeat the same angle or question twice in a row.',
    '',
    'GOAL OF EACH MESSAGE:',
    'Move the lead one step closer to: a call -> a viewing -> a reservation.',
    'If the lead mentions budget, timeline, location preference, or competitors -> suggest a short call immediately.'
  ].join('\\n');

  // Embedded mode: the extension's bridge content script loads this exact
  // page in an iframe inside amoCRM instead of maintaining its own separate
  // UI. window.self !== window.top is a safe cross-origin read (never
  // throws) and is the one signal that reliably distinguishes "running
  // standalone as the PWA" from "running inside the bridge's iframe" —
  // nothing else in this file assumed it could be either until now.
  var EMBEDDED = (function () {
    try { return window.self !== window.top; } catch (e) { return true; }
  })();
  var _qs = new URLSearchParams(location.search);
  // The bridge knows the broker authoritatively (re-verified against the
  // live amoCRM session on every load) — trust its URL param over whatever
  // localStorage says, so an iframe never shows a stale or wrong broker's
  // leads just because this browser profile last had someone else's name
  // saved from the standalone PWA.
  var brokerName = (EMBEDDED && _qs.get("broker")) || localStorage.getItem("copilot_broker") || "";
  var embeddedGuide = EMBEDDED ? _qs.get("guide") : null;
  var embeddedOutputLanguage = EMBEDDED ? _qs.get("outputLanguage") : null;
  // "" = all pipelines, otherwise the exact pipeline name the broker picked
  // via the switcher. Only matters for a broker who genuinely has leads in
  // more than one pipeline — everyone else can leave it on "All pipelines".
  var pipelineView = localStorage.getItem("copilot_pipeline_view") || "";
  // Populated from /api/public/pipelines — whatever pipelines currently have
  // tracked leads. Empty until that first fetch resolves; the dropdown just
  // shows "All pipelines" alone until then.
  var pipelineOptions = [];
  // Admin-only: HoS or Admin can view/act as any other broker without
  // re-logging in. "" = viewing as themselves. activeBroker() is what every
  // API call actually uses — brokerName stays the real login so switching
  // back is just picking "(me)" again, not retyping the setup screen.
  var ADMIN_LOGINS = ["hos", "admin"];
  var HOS_ROSTER = ["Robert", "Amelia", "Sharon", "Yudi", "Saif", "Kristo", "Ferdian"];
  var hosViewAs = localStorage.getItem("copilot_hos_view_as") || "";
  function isHosLogin() { return ADMIN_LOGINS.indexOf((brokerName || "").trim().toLowerCase()) !== -1; }
  function activeBroker() { return (isHosLogin() && hosViewAs) ? hosViewAs : brokerName; }
  var activeTab = "live";
  // Staged-delegation panel state: the broker dials "bot acts without approve
  // up to stage X" from here. Settings live server-side (/api/public/autopilot).
  var apOpen = false;
  var apData = null;
  var items = { live: [], push: [], reach: [] };
  var openItem = null;
  var editing = false;
  var editValue = "";
  var toastMsg = "";
  var toastTimer = null;
  var convSplit = Number(localStorage.getItem("copilot_convsplit")) || 0;
  // Report tab state. reportCard is this broker's own; reportTeam is every
  // broker side by side and is fetched only for an admin login.
  var reportPeriod = "day";
  var reportCard = null;
  var reportTeam = null;
  var reportBusy = false;
  // A screen of its own, reached from the header — NOT a fourth tab. Live /
  // Reach / Push are three queues of the same job (answer this lead); the
  // report is about the broker, not about a lead, and sitting in that row it
  // read as a fourth pile of work to get through.
  var reportView = false;

  // ── Add a listing ────────────────────────────────────────────────────────
  // The team used to publish listings by sharing ONE Claude account across
  // three browsers, and the sessions collided constantly. So nothing here is
  // shared: the transcript, the draft and the photos live in THIS tab (and
  // this tab's localStorage), and every request carries them in full. The
  // server holds no intake session at all, which is exactly why two brokers
  // adding two villas at the same moment cannot step on each other.
  var LI_TYPES = ["villa", "apartment", "land", "townhouse", "hotel"];
  var listingView = false;
  var liTurns = [];      // {role, text, images:[]} — the conversation so far
  var liDraft = null;    // the card being built; null until the first answer
  var liImages = [];     // every photo that will be published
  var liPending = [];    // uploaded, not yet attached to a sent message
  var liInput = "";
  var liBusy = false;
  var liErr = "";
  var liCode = "";
  var liCodeHint = "";
  var liDone = null;     // {propertyId, url} once it is live

  function liSave() {
    try {
      localStorage.setItem("copilot_listing_state", JSON.stringify({
        turns: liTurns, draft: liDraft, images: liImages, pending: liPending, input: liInput, code: liCode
      }));
    } catch (e) { /* quota or private mode: the saved copy is a convenience, not the record */ }
  }
  function liRestore() {
    try {
      var raw = localStorage.getItem("copilot_listing_state");
      if (!raw) return;
      var s = JSON.parse(raw) || {};
      liTurns = s.turns || []; liDraft = s.draft || null; liImages = s.images || [];
      liPending = s.pending || []; liInput = s.input || ""; liCode = s.code || "";
    } catch (e) { /* a corrupt blob must not trap the broker on a broken screen */ }
  }
  function liReset() {
    liTurns = []; liDraft = null; liImages = []; liPending = [];
    liInput = ""; liErr = ""; liCode = ""; liCodeHint = ""; liDone = null;
    try { localStorage.removeItem("copilot_listing_state"); } catch (e) { /* nothing to clear */ }
  }

  // The same completeness rule the server enforces on publish. Kept here too so
  // the button is honest about WHY it is disabled instead of failing on press.
  function liHasPrice(d) {
    if (!d) return false;
    if (d.listingType === "rent") return !!(d.monthlyPriceIdr || d.yearlyPriceIdr || d.monthlyPriceUsd || d.yearlyPriceUsd);
    if (d.listingType === "sale") return !!(d.priceUsd || d.leaseholdPriceUsd);
    return false;
  }
  function liMissing(d) {
    if (!d) return ["title", "area", "listingType", "type", "bedrooms", "description", "price"];
    var out = [];
    if (!d.title) out.push("title");
    if (!d.area) out.push("area");
    if (!d.listingType) out.push("listingType");
    if (!d.type) out.push("type");
    if ((d.bedrooms === null || d.bedrooms === undefined) && d.type !== "land") out.push("bedrooms");
    if (!d.description) out.push("description");
    if (!liHasPrice(d)) out.push("price");
    return out;
  }

  function liThumbs(urls, removable) {
    if (!urls || !urls.length) return "";
    var h = '<div class="li-thumbs">';
    for (var i = 0; i < urls.length; i++) {
      h += '<div class="li-thumb"><img src="' + esc(urls[i]) + '" alt="">';
      if (removable) h += '<div class="x" data-rmimg="' + esc(urls[i]) + '">\\u00d7</div>';
      h += "</div>";
    }
    return h + "</div>";
  }

  function liFieldHtml(key, label, kind, options, miss, wide) {
    var raw = liDraft ? liDraft[key] : null;
    var v = (raw === null || raw === undefined) ? "" : raw;
    if (key === "features") v = (liDraft && liDraft.features ? liDraft.features : []).join(", ");
    var h = '<div class="li-f' + (wide ? " wide" : "") + (miss.indexOf(key) !== -1 ? " miss" : "") + '">';
    h += "<label>" + esc(label) + "</label>";
    if (kind === "select") {
      h += '<select data-k="' + key + '"><option value="">\\u2014</option>';
      for (var i = 0; i < options.length; i++) {
        h += '<option value="' + esc(options[i]) + '"' + (String(v) === options[i] ? " selected" : "") + ">" + esc(options[i]) + "</option>";
      }
      h += "</select>";
    } else if (kind === "textarea") {
      h += '<textarea data-k="' + key + '">' + esc(v) + "</textarea>";
    } else {
      h += '<input data-k="' + key + '" type="' + (kind === "number" ? "number" : "text") + '" value="' + esc(v) + '">';
    }
    return h + "</div>";
  }

  // Updates the publish button in place rather than re-rendering: a full render
  // on every keystroke would take the focus out of the field being typed in.
  function liSyncPublish() {
    var btn = $("#li-publish");
    if (!btn) return;
    var m = liMissing(liDraft);
    var codeEl = $("#li-code");
    var code = codeEl ? codeEl.value.trim() : liCode;
    btn.disabled = liBusy || m.length > 0 || !code;
    var note = $("#li-missing");
    if (note) note.textContent = m.length ? "Still needed: " + m.join(", ") : "";
  }

  async function liUpload(files) {
    if (!files || !files.length) return;
    liBusy = true; liErr = ""; render();
    try {
      var fd = new FormData();
      for (var i = 0; i < files.length; i++) fd.append("images", files[i]);
      var r = await fetch(API + "/listing-intake/upload", { method: "POST", body: fd });
      var j = await r.json();
      if (r.ok && j && j.images) liPending = liPending.concat(j.images);
      else liErr = (j && j.error) || "Could not upload the photos.";
    } catch (e) { liErr = "Could not upload the photos: " + (e && e.message); }
    liBusy = false; liSave(); render();
  }

  async function liFetchCode() {
    try {
      var lt = (liDraft && liDraft.listingType) || "";
      var r = await fetch(API + "/listing-intake/code?listingType=" + encodeURIComponent(lt));
      var j = await r.json();
      if (j && j.suggestion) {
        if (!liCode) liCode = j.suggestion;
        liCodeHint = "Next free code in the series already used in the catalog. Change it if this villa belongs to another one.";
      } else {
        liCodeHint = "Could not read the existing codes \\u2014 type the code yourself.";
      }
      liSave(); render();
    } catch (e) { /* no suggestion is not a failure: the broker types the code */ }
  }

  async function liSend() {
    if (liBusy) return;
    var el = $("#li-input");
    var text = (el ? el.value : liInput).trim();
    if (!text && !liPending.length) return;

    liTurns.push({ role: "user", text: text, images: liPending.slice() });
    for (var i = 0; i < liPending.length; i++) {
      if (liImages.indexOf(liPending[i]) === -1) liImages.push(liPending[i]);
    }
    liPending = []; liInput = ""; liErr = ""; liBusy = true;
    liSave(); render();

    try {
      var r = await fetch(API + "/listing-intake/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turns: liTurns, draft: liDraft, broker: activeBroker() })
      });
      var j = await r.json();
      if (!r.ok || (j && j.error)) {
        liErr = (j && j.error) || "The assistant could not answer. Try again.";
      } else {
        liTurns.push({ role: "assistant", text: j.reply || "" });
        if (j.draft) liDraft = j.draft;
        liBusy = false;
        liSave();
        if (!liCode) { liFetchCode(); }
      }
    } catch (e) { liErr = "Network error: " + (e && e.message); }
    liBusy = false; liSave(); render();
  }

  async function liPublish() {
    var codeEl = $("#li-code");
    var code = codeEl ? codeEl.value.trim() : liCode;
    if (!code || liBusy) return;
    liCode = code; liErr = ""; liBusy = true; render();
    try {
      var r = await fetch(API + "/listing-intake/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: liDraft, images: liImages, propertyId: code, broker: activeBroker() })
      });
      var j = await r.json();
      if (r.ok && j && j.ok) {
        liDone = j;
        showToast("Published \\u2014 " + j.propertyId);
      } else {
        liErr = (j && j.error) || "Could not publish.";
      }
    } catch (e) { liErr = "Could not publish: " + (e && e.message); }
    liBusy = false; render();
  }

  function renderListing() {
    var miss = liMissing(liDraft);
    var html = "";
    html += '<header><div class="top-row">';
    html += '<div class="brand"><span class="dot"></span> Add a listing</div>';
    html += '<div class="top-actions">';
    html += '<span class="broker-chip">\\ud83d\\udc64 <b>' + esc(activeBroker()) + "</b></span>";
    html += '<button class="refresh-btn" id="li-close" title="Back to leads">\\u2715</button>';
    html += "</div></div></header><main>";

    if (liDone) {
      html += '<div class="li-ok"><b>\\u2705 ' + esc(liDone.propertyId) + " is live.</b><br>";
      html += "It is on the site and the bot can already offer it to clients.<br>";
      html += '<a href="' + esc(liDone.url) + '" target="_blank" rel="noopener">' + esc(liDone.url) + "</a></div>";
      html += '<button class="li-btn" id="li-again">Add another listing</button> ';
      html += '<button class="li-btn ghost" id="li-close2">Back to leads</button>';
      html += "</main>";
      app.innerHTML = html;
      $("#li-close").onclick = function () { listingView = false; render(); };
      $("#li-close2").onclick = function () { listingView = false; liReset(); render(); };
      $("#li-again").onclick = function () { liReset(); render(); };
      return;
    }

    if (liErr) html += '<div class="li-err">' + esc(liErr) + "</div>";

    if (!liTurns.length) {
      html += '<div class="li-note">\\ud83c\\udfe1 Paste whatever the owner sent you \\u2014 the text, the price, the area, the size \\u2014 and attach the photos. ' +
        "The assistant builds the listing and asks about anything missing. Nothing reaches the site until you press Publish.</div>";
    } else {
      html += '<div class="li-chat" id="li-chat">';
      for (var i = 0; i < liTurns.length; i++) {
        var t = liTurns[i];
        html += '<div class="li-msg ' + (t.role === "assistant" ? "ai" : "me") + '">';
        html += '<div class="who">' + (t.role === "assistant" ? "Assistant" : "You") + "</div>";
        if (t.text) html += '<div class="li-bub">' + linkify(esc(t.text)) + "</div>";
        html += liThumbs(t.images, false);
        html += "</div>";
      }
      if (liBusy) {
        html += '<div class="li-msg ai"><div class="who">Assistant</div>' +
          '<div class="skel"><div></div><div></div><div></div><div></div></div></div>';
      }
      html += "</div>";
    }

    html += '<div class="li-compose">';
    html += '<textarea id="li-input" placeholder="For example: villa in Pererenan, 3 bedrooms, 88 juta a month, pool, available from September">' + esc(liInput) + "</textarea>";
    html += liThumbs(liPending, true);
    html += '<div class="li-actions">';
    html += '<input type="file" id="li-files" accept="image/*" multiple style="display:none">';
    html += '<button class="li-btn ghost" id="li-attach"' + (liBusy ? " disabled" : "") + ">\\ud83d\\udcce Photos</button>";
    html += '<button class="li-btn" id="li-send"' + (liBusy ? " disabled" : "") + ">" + (liBusy ? "Working\\u2026" : "Send") + "</button>";
    if (liTurns.length) html += '<button class="li-btn ghost" id="li-reset" style="margin-left:auto">Start over</button>';
    html += "</div></div>";

    if (liDraft) {
      var isSale = liDraft.listingType === "sale";
      html += '<div class="li-card">';
      html += '<label class="section">The listing as it will be published</label>';
      html += '<div class="li-grid">';
      html += liFieldHtml("title", "Title", "text", null, miss, true);
      html += liFieldHtml("area", "Area", "text", null, miss, false);
      html += liFieldHtml("type", "Type", "select", LI_TYPES, miss, false);
      html += liFieldHtml("listingType", "Rent or sale", "select", ["rent", "sale"], miss, false);
      html += liFieldHtml("bedrooms", "Bedrooms", "number", null, miss, false);
      html += liFieldHtml("bathrooms", "Bathrooms", "number", null, miss, false);
      html += liFieldHtml("landSize", "Land, m2", "number", null, miss, false);
      html += liFieldHtml("buildSize", "Build, m2", "number", null, miss, false);
      if (isSale) {
        html += liFieldHtml("priceUsd", "Freehold price, USD", "number", null, miss, false);
        html += liFieldHtml("leaseholdPriceUsd", "Leasehold price, USD", "number", null, miss, false);
        html += liFieldHtml("ownership", "Ownership", "select", ["freehold", "leasehold"], miss, false);
        html += liFieldHtml("leaseYears", "Lease, years", "number", null, miss, false);
      } else {
        // Rupiah first and dollars second, because that is the order the owner
        // quotes a Bali rental in — and the dollar columns are what once made
        // the bot quote dollars to a client budgeting in juta.
        html += liFieldHtml("monthlyPriceIdr", "Per month, IDR", "number", null, miss, false);
        html += liFieldHtml("yearlyPriceIdr", "Per year, IDR", "number", null, miss, false);
        html += liFieldHtml("monthlyPriceUsd", "Per month, USD", "number", null, miss, false);
        html += liFieldHtml("yearlyPriceUsd", "Per year, USD", "number", null, miss, false);
      }
      html += liFieldHtml("features", "Features, comma separated", "text", null, miss, true);
      html += liFieldHtml("videoUrl", "Video link", "text", null, miss, true);
      html += liFieldHtml("description", "Description shown on the site", "textarea", null, miss, true);
      html += "</div>";

      if (liImages.length) {
        html += '<div style="margin-top:12px"><label class="section">Photos (' + liImages.length + ")</label>";
        html += liThumbs(liImages, true) + "</div>";
      }

      html += '<div class="li-grid" style="margin-top:14px">';
      html += '<div class="li-f"><label>Property code</label><input id="li-code" value="' + esc(liCode) + '" placeholder="R-YUD-040"></div>';
      html += '<div class="li-f" style="display:flex;align-items:flex-end">';
      html += '<button class="li-btn" id="li-publish" style="width:100%"' + ((liBusy || miss.length || !liCode) ? " disabled" : "") + ">Publish to the site</button>";
      html += "</div></div>";
      html += '<div class="li-note" id="li-missing" style="margin:8px 0 0">' + (miss.length ? "Still needed: " + esc(miss.join(", ")) : "") + "</div>";
      if (liCodeHint) html += '<div class="li-note" style="margin:4px 0 0">' + esc(liCodeHint) + "</div>";
      html += "</div>";
    }

    html += "</main>";
    app.innerHTML = html;

    var chat = $("#li-chat");
    if (chat) chat.scrollTop = chat.scrollHeight;

    $("#li-close").onclick = function () { listingView = false; render(); };
    var inputEl = $("#li-input");
    // Stored on every keystroke but never re-rendered from: re-rendering here
    // would drop the caret mid-word.
    if (inputEl) inputEl.oninput = function () { liInput = inputEl.value; };
    var attachBtn = $("#li-attach");
    if (attachBtn) attachBtn.onclick = function () { $("#li-files").click(); };
    var filesEl = $("#li-files");
    if (filesEl) filesEl.onchange = function () { liUpload(filesEl.files); filesEl.value = ""; };
    var sendBtn = $("#li-send");
    if (sendBtn) sendBtn.onclick = liSend;
    var resetBtn = $("#li-reset");
    if (resetBtn) resetBtn.onclick = function () {
      if (confirm("Start a new listing? The current draft will be cleared.")) { liReset(); render(); }
    };
    var pubBtn = $("#li-publish");
    if (pubBtn) pubBtn.onclick = liPublish;
    var codeEl = $("#li-code");
    if (codeEl) codeEl.oninput = function () { liCode = codeEl.value; liSave(); liSyncPublish(); };

    document.querySelectorAll("[data-rmimg]").forEach(function (el) {
      el.onclick = function () {
        var u = el.getAttribute("data-rmimg");
        liPending = liPending.filter(function (x) { return x !== u; });
        liImages = liImages.filter(function (x) { return x !== u; });
        liSave(); render();
      };
    });

    document.querySelectorAll("[data-k]").forEach(function (el) {
      el.oninput = function () {
        if (!liDraft) return;
        var k = el.getAttribute("data-k");
        var val = el.value;
        if (k === "features") {
          liDraft.features = val.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        } else if (el.type === "number") {
          liDraft[k] = val === "" ? null : Math.round(Number(val));
        } else {
          liDraft[k] = val === "" ? null : val;
        }
        liSave(); liSyncPublish();
      };
      el.onchange = function () {
        // Only these two change WHICH fields the card shows (rent prices vs sale
        // prices, bedrooms vs land), so only these two earn a redraw.
        var k = el.getAttribute("data-k");
        if (k === "listingType" || k === "type") render();
      };
    });
  }

  var PIPELINE_STAGES = [
    "NEW LEAD","IN PROGRESS","1ST FOLLOW UP (NEXT DAY)","2ND FOLLOW UP (3 DAYS AFTER)",
    "FINAL FOLLOW UP (1 WEEK AFTER)","Shanti 5th msg (after 5 days)","LEAD ASSIGNED",
    "TAKEN TO WORK","Contact established","Mailing","Long-Term Cycle","Needs Assessed",
    "Options Sent","Zoom Call scheduled","Viewing Scheduled",
    "Feedback / Handling Objections","Reservation","Negotiations",
    "Contract signed","Closed - won","Closed - lost"
  ];

  // URLs in conversation bubbles are tappable: a client quoting a villa link
  // ("this one looks good") was dead text, so the broker could not open the very
  // villa being discussed. Linkified AFTER esc(), so nothing unescaped renders.
  //
  // Built WITHOUT a regex literal on purpose: this page is one big template
  // literal, and the backslashes of a URL regex were eaten on the way out —
  // the browser received a broken pattern, the whole script failed to parse and
  // the app rendered a blank screen on the owner's phone.
  function linkify(escaped) {
    var out = "", rest = String(escaped);
    for (;;) {
      var at = rest.indexOf("http");
      if (at === -1 || (rest.substr(at, 7) !== "http://" && rest.substr(at, 8) !== "https://")) break;
      out += rest.slice(0, at);
      rest = rest.slice(at);
      var stop = rest.length;
      for (var i = 0; i < rest.length; i++) {
        // Compared by CHARACTER CODE, never by an escape sequence: this page is
        // one template literal, so a backslash-n written anywhere here (even in
        // a comment) arrives as a real line break and breaks the whole script.
        var code = rest.charCodeAt(i);
        if (code === 32 || code === 60 || code === 10 || code === 13 || code === 9) { stop = i; break; }
      }
      var url = rest.slice(0, stop);
      while (url.length && ".,;:!?)".indexOf(url.charAt(url.length - 1)) !== -1) url = url.slice(0, -1);
      out += '<a href="' + url + '" target="_blank" rel="noopener" style="color:#7dd3fc;text-decoration:underline;word-break:break-all">' + url + "</a>";
      rest = rest.slice(url.length);
    }
    return out + rest;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function showToast(msg) {
    toastMsg = msg;
    render();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastMsg = ""; render(); }, 2500);
  }

  function taskStatusBadge(nextFollowupAt) {
    if (!nextFollowupAt) return '<span class="badge notask">No task</span>';
    var due = new Date(nextFollowupAt);
    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var dueStart = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    var diffDays = Math.round((dueStart - todayStart) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return '<span class="badge overdue">Overdue ' + Math.abs(diffDays) + 'd</span>';
    if (diffDays === 0) return '<span class="badge today">Today</span>';
    return '<span class="badge notask">In ' + diffDays + 'd</span>';
  }
  function tempBadge(t) {
    if (!t) return '';
    var map = { hot: '\\ud83d\\udd25 Hot', warm: '\\ud83c\\udf24 Warm', cold: '\\u2744\\ufe0f Cold' };
    var label = map[t]; if (!label) return '';
    return '<span class="badge temp-' + esc(t) + '">' + label + '</span>';
  }
  function cardBadges(item) {
    var html = taskStatusBadge(item.next_followup_at);
    if (item.profile_temperature) html += tempBadge(item.profile_temperature);
    // Which funnel this lead lives in. Only while viewing ALL pipelines — once
    // the broker has narrowed to one, every card would repeat the same word.
    if (!pipelineView && item.pipeline) html += '<span class="badge stagepill">' + esc(item.pipeline) + '</span>';
    if (item.lead_stage) html += '<span class="badge stagepill">' + esc(item.lead_stage) + '</span>';
    if (item.discard_flagged) html += '<span class="badge discard" title="' + esc(item.discard_reason || '') + '">\\u2298 Review</span>';
    return html;
  }

  // Every message shows when it was sent. Without it the broker opens a thread
  // and cannot tell whether the last line is from ten minutes or three days ago.
  // Times come from the phone's own clock, which on Bali is the client's clock.
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function fmtAt(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    var now = new Date();
    if (sameDay(d, now)) return hm;
    if (sameDay(d, new Date(now.getTime() - 86400000))) return "Yesterday " + hm;
    var base = d.getDate() + " " + MON[d.getMonth()];
    if (d.getFullYear() !== now.getFullYear()) base += " " + d.getFullYear();
    return base + ", " + hm;
  }

  function fmtAgo(iso) {
    if (!iso) return "";
    var s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  // ── Stage helpers (mirrors extension's PIPELINE_STAGES logic) ──────────────
  function stageName(s) { return (typeof s === "object" && s !== null) ? (s.name || "") : String(s || ""); }
  function stagesAfterCurrent(currentStage) {
    var idx = -1;
    for (var i = 0; i < PIPELINE_STAGES.length; i++) {
      if (stageName(PIPELINE_STAGES[i]).toLowerCase() === String(currentStage || "").toLowerCase()) { idx = i; break; }
    }
    var slice = idx === -1 ? PIPELINE_STAGES : PIPELINE_STAGES.slice(idx + 1);
    return slice.map(stageName);
  }
  function stageIdForName(name) {
    for (var i = 0; i < PIPELINE_STAGES.length; i++) {
      var s = PIPELINE_STAGES[i];
      if (stageName(s).toLowerCase() === String(name || "").toLowerCase()) {
        return (typeof s === "object" && s !== null) ? (s.id || null) : null;
      }
    }
    return null;
  }
  function detectStageTransition(text) {
    if (!text) return false;
    var t = text.toLowerCase();
    var kws = ["viewing","zoom call","video call","meet on","call on","просмотр","зум","созвон","встрет","запишем","запланируем","забронируем","reservation","резерв","schedule a"];
    for (var i = 0; i < kws.length; i++) { if (t.indexOf(kws[i]) !== -1) return true; }
    return false;
  }
  // Stage ids are unique PER FUNNEL even where the names match, so the picker
  // has to be told which funnel the open lead belongs to. Asking without one
  // returned Unicorn ids for every pipeline: on a Rental lead the broker picked
  // a stage, our DB recorded the advance, and amoCRM never moved the card.
  var STAGE_CACHE = {};
  var STAGE_PIPELINE = "";
  async function fetchStageOptions(pipeline) {
    var key = String(pipeline || "").trim();
    if (STAGE_CACHE[key]) { PIPELINE_STAGES = STAGE_CACHE[key]; STAGE_PIPELINE = key; return; }
    try {
      var url = API + "/stage-options" + (key ? "?pipeline=" + encodeURIComponent(key) : "");
      var res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) return;
      var json = await res.json();
      if (Array.isArray(json.stages) && json.stages.length > 0) {
        STAGE_CACHE[key] = json.stages;
        PIPELINE_STAGES = json.stages;
        STAGE_PIPELINE = key;
      }
    } catch (e) { /* keep built-in defaults */ }
  }
  async function fetchPipelineOptions() {
    try {
      var res = await fetch(API + "/pipelines", { cache: "no-cache" });
      if (!res.ok) return;
      var json = await res.json();
      if (Array.isArray(json)) {
        pipelineOptions = json.map(function (p) { return p.name; }).filter(Boolean);
        render();
      }
    } catch (e) { /* dropdown just stays "All pipelines" */ }
  }

  // ── PUSH tab sort: stage → task urgency → warmth (mirrors suggestions.ts) ─
  var PUSH_STAGE_RANK = { 'contact established': 9, 'needs assessed': 50, 'options sent': 51, 'option send': 51 };
  function pushStageRank(stage) {
    var s = (stage || '').toLowerCase();
    for (var key in PUSH_STAGE_RANK) { if (s.indexOf(key) !== -1) return PUSH_STAGE_RANK[key]; }
    return 99;
  }
  // 1 = due today, 2 = overdue, 3 = no task
  function pushTaskGroup(row) {
    var nfa = row.next_followup_at;
    if (!nfa) return 3;
    var due = new Date(nfa);
    var n = new Date();
    var dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    var todayDay = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    return dueDay.getTime() >= todayDay.getTime() ? 1 : 2;
  }
  function sortedList(kind) {
    // The server (suggestions.ts) now ranks PUSH by the adaptive priority score
    // (stage → temperature/potential → task urgency → warmth → aging). Preserve
    // that server order verbatim instead of re-sorting client-side. Legacy
    // pushStageRank/pushTaskGroup kept above only as a fallback reference.
    return (items[kind] || []).slice();
  }

  // removable is only true in edit mode, where the remove buttons get wired up —
  // rendering them in the read-only view would give the broker dead controls.
  // Bot-picked property links are removable too: the broker needs to be able to
  // drop or swap a listing they disagree with, not just the ones they added.
  function renderAttachments(item, removable) {
    if (!item.attachments || !item.attachments.length) return "";
    var html = '<div class="atts">';
    for (var i = 0; i < item.attachments.length; i++) {
      var a = item.attachments[i];
      var rm = removable ? '<button class="attrm" data-rmattach="' + i + '" title="Remove">\\u00d7</button>' : "";
      if (a.type === "reminder") {
        html += '<div class="att att-reminder"><span>\\ud83d\\udccc</span><span class="attlbl">' + esc(a.label) + '</span></div>';
      } else if (a.type === "image" && a.url) {
        html += '<div class="att att-img"><a href="' + esc(a.url) + '" target="_blank" rel="noopener"><img src="' + esc(a.url) + '" alt="' + esc(a.label || "") + '"></a><span class="attlbl">' + esc(a.label || "") + '</span>' + rm + '</div>';
      } else if (a.type === "image" && !a.url) {
        html += '<div class="att att-reminder"><span>\\ud83d\\uddbc</span><span class="attlbl">' + esc(a.label) + ' \\u2014 not uploaded yet</span></div>';
      } else if (a.type === "link") {
        html += '<div class="att att-link"><span>\\ud83d\\udd17</span><a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.label || a.url) + '</a>' + rm + '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  // Shared by the manual "+ Add" paste box and the site picker below, so both
  // paths dedupe and label a link the same way.
  //
  // Deliberately never removes anything on its own — only the × button removes
  // a link. A version of this once cleared whatever the bot had suggested the
  // moment the picker opened, which silently deleted a bot-picked villa the
  // broker had NOT removed and genuinely meant to keep alongside the new pick.
  // The system can't tell "forgot to remove" from "kept on purpose" — so it
  // doesn't guess: it only ever acts on the explicit × tap, and instead warns
  // when the list grows past what a client should be shown.
  function addAttachmentLink(item, url) {
    item.attachments = item.attachments || [];
    for (var i = 0; i < item.attachments.length; i++) {
      if (item.attachments[i].type === "link" && item.attachments[i].url === url) return false;
    }
    var m = url.match(/\\/property\\/([A-Za-z0-9-]+)/i);
    item.attachments.push({ type: "link", label: m ? m[1] : url, url: url, _broker: true });
    item._attachmentsCurated = true;
    var linkCount = item.attachments.filter(function (a) { return a.type === "link"; }).length;
    if (linkCount > 3) showToast(linkCount + " links attached — clients are usually shown 2-3, worth a check");
    return true;
  }

  var PICKER_ORIGIN = "https://unicorn-properties.com";

  // Opens unicorn-properties.com in a full-screen overlay so the broker can
  // click listings there instead of copy-pasting links. The site activates
  // picker mode via a postMessage handshake (a URL flag isn't reliable — the
  // site's own route-sync effects rewrite it away) and posts the chosen bare
  // property URLs back via postMessage on "Send to Copilot" — same message
  // contract the extension listens for.
  function openPropertyPicker(onSelect) {
    var overlay = document.createElement("div");
    overlay.className = "picker-overlay";
    overlay.innerHTML = '<div class="picker-modal">' +
      '<div class="picker-hdr"><span>\\ud83c\\udf10 Choose listings \\u2014 unicorn-properties.com</span><button class="picker-close" id="picker-close">\\u00d7</button></div>' +
      '<iframe src="' + PICKER_ORIGIN + '/"></iframe>' +
      '</div>';
    document.body.appendChild(overlay);
    var iframe = overlay.querySelector("iframe");
    requestAnimationFrame(function () { overlay.classList.add("show"); });
    // Reveal on the site's own "ready" handshake (React mounted), not the
    // iframe's load event — load waits for GTM/Meta Pixel/Yandex Metrika and
    // every image too, a second-plus later than the page is actually visible.
    // Timeout is just a safety net if the handshake never arrives.
    var revealTimer = setTimeout(function () { iframe.classList.add("loaded"); }, 2500);
    function reveal() { clearTimeout(revealTimer); iframe.classList.add("loaded"); }

    function close() {
      clearTimeout(revealTimer);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
      overlay.remove();
    }
    function onMessage(e) {
      if (e.origin !== PICKER_ORIGIN) return;
      if (e.source !== iframe.contentWindow) return;
      var d = e.data;
      if (!d) return;
      if (d.source === "unicorn-site" && d.type === "ready") {
        reveal();
        iframe.contentWindow.postMessage({ source: "unicorn-picker-host", type: "activate" }, PICKER_ORIGIN);
        return;
      }
      if (d.source === "unicorn-picker" && d.type === "selection" && Array.isArray(d.urls)) {
        onSelect(d.urls);
        close();
      }
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    var closeBtn = overlay.querySelector("#picker-close");
    if (closeBtn) closeBtn.onclick = close;
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey);
  }
  // ── Voice dictation (Web Speech API — same as extension; gracefully absent on iOS Safari) ─
  var _voiceEl = null, _voiceBtn = null, _directSR = null, _wakeLock = null, _voiceWanted = false;

  // iOS dims and locks the screen on its idle timer even while the mic is live,
  // which kills the SpeechRecognition session mid-sentence. Holding a screen
  // wake lock for the duration of dictation keeps the thought intact.
  async function acquireWakeLock() {
    try {
      if ("wakeLock" in navigator && !_wakeLock) {
        _wakeLock = await navigator.wakeLock.request("screen");
        _wakeLock.addEventListener("release", function () { _wakeLock = null; });
      }
    } catch (e) { /* not supported or refused — dictation still works */ }
  }
  function releaseWakeLock() {
    if (_wakeLock) { try { _wakeLock.release(); } catch (e) {} _wakeLock = null; }
  }
  // iOS drops the lock whenever the tab is backgrounded; re-take it on return
  // so a mid-dictation app switch doesn't silently lose the protection.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && _voiceEl) acquireWakeLock();
  });

  function stopVoiceDictation() {
    _voiceWanted = false;
    releaseWakeLock();
    if (_voiceEl) {
      if (_directSR) { try { _directSR.stop(); } catch (e) {} _directSR = null; }
      if (_voiceBtn) { _voiceBtn.textContent = "\\ud83c\\udfa4 Dictate"; _voiceBtn.classList.remove("recording"); }
      _voiceEl = null; _voiceBtn = null;
    }
  }
  function startVoiceDictation(edEl, btnEl) {
    if (!edEl) return;
    if (_voiceEl) {
      _voiceWanted = false;
      if (_directSR) { try { _directSR.stop(); } catch (e) {} _directSR = null; }
      return;
    }
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      if (btnEl) { btnEl.textContent = "\\ud83d\\udeab Not supported"; setTimeout(function () { btnEl.textContent = "\\ud83c\\udfa4 Dictate"; }, 3000); }
      return;
    }
    _voiceEl = edEl; _voiceBtn = btnEl;
    _voiceWanted = true;
    // Dictating means the on-screen keyboard is dead weight — on iPhone it eats
    // half the screen, hiding the very draft being corrected. Blur the field to
    // dismiss it; the transcript still lands in the field's value, and the
    // keyboard comes back the moment the broker taps the text to type.
    try {
      edEl.blur();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    } catch (e) {}
    if (btnEl) { btnEl.textContent = "\\u23f3"; btnEl.title = "Starting microphone…"; }
    var sr = new SR();
    sr.lang = navigator.language || "ru-RU";
    sr.continuous = true; sr.interimResults = true;
    _directSR = sr;
    var lastFinal = edEl.value;
    sr.onstart = function () {
      acquireWakeLock();
      if (_voiceBtn) { _voiceBtn.textContent = "\\u23f9"; _voiceBtn.title = "Recording… click to stop"; _voiceBtn.classList.add("recording"); }
    };
    sr.onresult = function (event) {
      var interim = "";
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          lastFinal += (lastFinal && lastFinal.slice(-1) !== " " ? " " : "") + t.trim();
        } else { interim += t; }
      }
      if (_voiceEl) {
        _voiceEl.value = lastFinal + (interim ? (lastFinal && lastFinal.slice(-1) !== " " ? " " : "") + interim : "");
        _voiceEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };
    sr.onerror = function (event) {
      _voiceWanted = false;
      releaseWakeLock();
      _directSR = null;
      if (_voiceBtn) {
        _voiceBtn.classList.remove("recording");
        var denied = event.error === "not-allowed" || event.error === "audio-capture";
        _voiceBtn.textContent = "\\ud83d\\udeab Mic blocked";
        _voiceBtn.title = denied ? "Mic blocked — allow microphone access for this site" : "Mic error: " + event.error;
        var b = _voiceBtn;
        setTimeout(function () { b.textContent = "\\ud83c\\udfa4 Dictate"; b.title = "Dictate your instruction"; }, 4000);
      }
      _voiceEl = null; _voiceBtn = null;
    };
    sr.onend = function () {
      _directSR = null;
      // iOS ends recognition on any pause in speech. Re-tapping to continue
      // costs a fresh mic permission prompt and breaks the broker's train of
      // thought mid-sentence, so restart silently while they still intend to
      // dictate — only a deliberate stop clears _voiceWanted.
      if (_voiceWanted && _voiceEl) {
        try {
          sr.start();
          return;
        } catch (e) { /* fall through and end cleanly */ }
      }
      releaseWakeLock();
      if (_voiceEl) { _voiceEl.value = lastFinal.trim(); _voiceEl.dispatchEvent(new Event("input", { bubbles: true })); }
      if (_voiceBtn) { _voiceBtn.textContent = "\\ud83c\\udfa4 Dictate"; _voiceBtn.title = "Dictate your instruction"; _voiceBtn.classList.remove("recording"); }
      _voiceEl = null; _voiceBtn = null;
    };
    sr.start();
  }

  async function fetchInbox() {
    if (!brokerName) return;
    try {
      var url = API + "/suggestions?responsibleUser=" + encodeURIComponent(activeBroker());
      if (pipelineView) url += "&pipeline=" + encodeURIComponent(pipelineView);
      var res = await fetch(url, { cache: "no-store" });
      var data = await res.json();
      var all = data.items || [];
      var REACH_STAGES = ["1st follow up", "2nd follow up", "final follow up"];
      var isReachStage = function (stage) {
        if (!stage) return false;
        var s = stage.toLowerCase();
        return REACH_STAGES.some(function (q) { return s.indexOf(q) !== -1; });
      };
      items = {
        live: all.filter(function (i) { return i.kind === "live"; }),
        reach: all.filter(function (i) { return i.kind === "push" && isReachStage(i.lead_stage); }),
        push: all.filter(function (i) { return i.kind === "push" && !isReachStage(i.lead_stage); }),
      };
      updateAppBadge();
      // Checked on the same beat as the inbox, so a fault surfaces as fast as work does.
      refreshStuck();
      // fetchInbox only ever refreshed the background list — an already-open
      // detail view is a snapshot taken once in openDetail() and nothing here
      // touched it again, so "Refresh" while a lead was open did nothing: same
      // text, same (possibly still-missing) attachments no matter how many
      // times the broker pressed it. Re-sync the open card from the fresh
      // fetch too, unless the broker is actively editing (never stomp that).
      if (openItem && !editing) {
        var freshOpen = all.find(function (i) { return i.id === openItem.id; });
        if (freshOpen) {
          openItem.text = freshOpen.suggestion_text || "";
          openItem.original = freshOpen.suggestion_text || "";
          openItem.attachments = Array.isArray(freshOpen.attachments) ? freshOpen.attachments.slice() : [];
          openItem.recent_messages = Array.isArray(freshOpen.recent_messages) ? freshOpen.recent_messages : [];
          openItem.lead_stage = freshOpen.lead_stage || null;
          openItem.suggested_stage = freshOpen.suggested_stage || null;
          openItem.suggested_stage_reason = freshOpen.suggested_stage_reason || null;
          openItem.suggested_stage_terminal = !!freshOpen.suggested_stage_terminal;
        }
      }
      render();
    } catch (e) { /* network hiccup — keep last snapshot */ }
  }

  function updateAppBadge() {
    if (!("setAppBadge" in navigator)) return;
    var total = items.live.length + items.reach.length + items.push.length;
    try {
      if (total > 0) navigator.setAppBadge(total).catch(function () {});
      else navigator.clearAppBadge().catch(function () {});
    } catch (e) {}
  }

  // ── Web Push subscription ────────────────────────────────────────────────
  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var rawData = atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  function pushMsg(msg) {
    showToast(msg);
  }

  // Registers (or re-uses) this page's own service worker. Shared by the tap
  // path and the silent re-sync below, so there is one copy of the scope trap
  // rather than two that can drift apart.
  async function ensureSwRegistration() {
    var reg = await navigator.serviceWorker.register("/m/sw.js", { scope: "/m/" });
    // Do NOT use navigator.serviceWorker.ready here: the page lives at /m
    // (no trailing slash) which is outside scope "/m/", so .ready never
    // resolves and the whole flow hangs silently. Wait on the registration's
    // own worker instead, with a hard timeout.
    await new Promise(function (resolve, reject) {
      if (reg.active) return resolve();
      var pending = reg.installing || reg.waiting;
      if (!pending) return reject(new Error("no worker installing"));
      var timer = setTimeout(function () { reject(new Error("activation timed out")); }, 15000);
      pending.addEventListener("statechange", function () {
        if (pending.state === "activated") { clearTimeout(timer); resolve(); }
        else if (pending.state === "redundant") { clearTimeout(timer); reject(new Error("worker became redundant")); }
      });
    });
    return reg;
  }

  async function subscribeAndSave(reg) {
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      var keyRes = await fetch(API + "/push/vapid-public-key");
      var keyData = await keyRes.json();
      if (!keyData.key) throw new Error("push not configured on server");
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyData.key),
      });
    }
    var saveRes = await fetch(API + "/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brokerId: brokerName, subscription: sub.toJSON() }),
    });
    if (!saveRes.ok) throw new Error("server rejected it (" + saveRes.status + ")");
    localStorage.setItem("copilot_push_enabled", "1");
    return sub;
  }

  // Silent re-enrolment, on every load.
  //
  // Notifications used to be a bell nobody was told about: opt-in, one tap, and
  // hidden entirely inside the extension - so they reached 2 brokers out of 12
  // while the other 10 never learned a client had written. A browser genuinely
  // cannot be subscribed from the server (the subscription is minted by THIS
  // device, only after the person grants permission), but everything after that
  // grant is ours to do, and now we do it: permission already granted means
  // subscribed, silently, here and on every future device. It also repairs the
  // case that is invisible to the broker - permission still granted while the
  // push endpoint was rotated or dropped by the browser, which left them
  // permanently unreachable with a bell that still looked switched on.
  // Does THIS device hold a live push subscription? The one authoritative
  // answer to "is this person already sorted", and the only one the banner is
  // allowed to act on: server-side coverage is about a broker, not a device,
  // and reading it here asked an owner with notifications working perfectly to
  // switch them on again on every single launch.
  var pushLocalSub = null;

  async function syncPushSubscription() {
    if (!pushSupported() || EMBEDDED) return;
    if (Notification.permission !== "granted") { pushLocalSub = false; render(); return; }
    try {
      await subscribeAndSave(await ensureSwRegistration());
      pushLocalSub = true;
    } catch (e) {
      // Never a toast: this runs unprompted on load, and a broker who asked for
      // nothing should not be handed an error.
      pushLocalSub = false;
    }
    render();
  }

  // Is this broker reachable on ANY device? Server-answered, for the extension
  // panel, which cannot read permission or subscriptions from inside a
  // cross-origin iframe. Keyed on the real login, never on an admin's
  // "view as" selection — the subscription belongs to whoever is logged in
  // here, not to the broker whose leads they are looking at.
  var pushCovered = null;
  function fetchPushCoverage() {
    var me = (brokerName || "").trim().toLowerCase();
    if (!me) return;
    fetch(API + "/push/coverage")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var row = (d.brokers || []).find(function (x) { return String(x.broker).trim().toLowerCase() === me; });
        pushCovered = row ? !!row.enabled : null;
        render();
      })
      .catch(function () {});
  }

  async function enablePush() {
    if (!pushSupported()) {
      pushMsg("Push not supported on this browser");
      return;
    }

    // IMPORTANT: Notification.requestPermission() must run synchronously inside
    // the tap gesture on iOS — any alert()/await before it consumes the gesture
    // and iOS silently returns "denied" without ever showing the system prompt.
    var permission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch (e) {
        pushMsg("Permission request failed: " + ((e && e.message) || e));
        return;
      }
    }
    if (permission !== "granted") {
      pushMsg("Notifications are blocked for this app. Delete the home-screen icon, re-add it via Share → Add to Home Screen, then tap the bell again.");
      render();
      return;
    }

    var reg;
    try {
      reg = await ensureSwRegistration();
    } catch (e) {
      pushMsg("Service worker failed: " + ((e && e.message) || e));
      return;
    }

    try {
      await subscribeAndSave(reg);
    } catch (e) {
      pushMsg("Could not turn on notifications: " + ((e && e.message) || e));
      return;
    }

    pushCovered = true;
    pushLocalSub = true;
    pushMsg("Notifications on. You will get client replies and the morning report.");
    render();
  }

  async function disablePush() {
    try {
      if ("serviceWorker" in navigator) {
        var reg = await navigator.serviceWorker.getRegistration("/m/");
        if (reg) {
          var sub = await reg.pushManager.getSubscription();
          if (sub) {
            await fetch(API + "/push/unsubscribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ endpoint: sub.endpoint }),
            }).catch(function () {});
            await sub.unsubscribe().catch(function () {});
          }
        }
      }
      if ("setAppBadge" in navigator) { try { await navigator.clearAppBadge(); } catch (e) {} }
    } catch (e) {}
    localStorage.removeItem("copilot_push_enabled");
    // Switched off on purpose from the bell — do not turn round and offer to
    // switch it back on. The bell is the way back.
    localStorage.setItem("copilot_push_banner_off", "1");
    pushLocalSub = false;
    showToast("Notifications disabled");
    render();
  }

  function togglePush() {
    if (pushEnabled()) disablePush();
    else enablePush();
  }

  function pushEnabled() {
    return typeof Notification !== "undefined" && Notification.permission === "granted" && localStorage.getItem("copilot_push_enabled") === "1";
  }

  // A status code is not an answer to the only question a broker has after a
  // failed send: does the client have this message or not? 502/503/504 mean the
  // server went away mid-request (a deploy restart, typically) and the send may
  // have got part-way; anything else means it never started.
  var INTERRUPTED_SEND =
    "Connection to the server dropped while sending. Part of the message may already have reached the client - open the chat in amoCRM and check before you press Send again.";

  function sendErrorText(httpStatus, hookStatus) {
    if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return INTERRUPTED_SEND;
    if (hookStatus != null && hookStatus !== 0 && (hookStatus < 200 || hookStatus >= 300)) {
      return "amoCRM refused the send (code " + hookStatus + ") - the message was NOT sent. Try again, and if it repeats send it by hand from amoCRM.";
    }
    return "Could not send (code " + httpStatus + ") - the message was NOT sent. Try again.";
  }

  async function approveServer(item, finalText) {
    item.busy = true; render();
    try {
      var res = await fetch(API + "/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suggestionId: item.id,
          message: finalText,
          edited: finalText.trim() !== (item.original || "").trim(),
          originalText: item.original || "",
          brokerId: activeBroker(),
          // Send the CURRENT attachment list — the broker may have removed or
          // added property links while editing, and the server would otherwise
          // fall back to the originally generated set.
          attachments: (item.attachments || []).filter(function (a) { return a.type === "link" && a.url; }),
          attachmentsCurated: !!item._attachmentsCurated,
          newStage: (item.lead_stage && item.lead_stage !== item._originalStage) ? item.lead_stage : undefined,
          stageId: (item.lead_stage && item.lead_stage !== item._originalStage) ? (stageIdForName(item.lead_stage) || item.lead_stage_id || undefined) : (item.lead_stage_id || undefined),
        }),
      });
      var json = await res.json().catch(function () { return {}; });
      if (!res.ok || !json.ok) {
        // The server refuses to send when it can't resolve the outbound channel —
        // say so in plain words instead of a bare status code, because the action
        // the broker must take (send it by hand) is completely different.
        // Everything else used to read "Webhook 502", which told a broker nothing
        // about the only thing that matters: did the client get it or not.
        item.error = json.message ? json.message : sendErrorText(res.status, json.hookStatus);
        item.busy = false; item._approving = false; render();
        return;
      }
      openItem = null; editing = false;
      // A resumed send explains itself (part of it had already reached the
      // client) — say that instead of a plain "Sent".
      showToast(json.message ? json.message : "Sent");
      await fetchInbox();
    } catch (e) {
      // The fetch itself failed (server gone, connection dropped) — same
      // uncertainty as a 502, so give the broker the same instruction.
      item.error = INTERRUPTED_SEND;
      item.busy = false; item._approving = false;
      render();
    }
  }

  async function skipServer(item) {
    item.busy = true; render();
    try {
      await fetch(API + "/skip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suggestionId: item.id }) });
    } catch (e) {}
    openItem = null; editing = false;
    showToast("Skipped");
    await fetchInbox();
  }

  async function brokerReplied(item) {
    item.busy = true; render();
    try {
      await fetch(API + "/no-reply-needed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId: item.lead_id }) });
    } catch (e) {}
    openItem = null; editing = false;
    showToast("No reply needed - will follow up later");
    await fetchInbox();
  }

  async function rewriteServer(item, feedback) {
    if (!item.revisionChain) item.revisionChain = [];
    item.revisionChain.push({ draft: item.text, feedback: feedback.trim() });
    var messages = (item.recent_messages || []).map(function (m) {
      return { from: m.from === "us" ? "broker" : "lead", text: m.text };
    });
    item.loading = true; item.error = ""; render();
    try {
      var res = await fetch(API + "/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // A broker who customized their guide/output-language via the
          // extension's options page (embedded-mode-only, carried in via
          // the ?guide=/?outputLanguage= URL params) keeps that preference
          // here instead of silently falling back to the English default —
          // this is the one place mobile.ts calls /suggest with a hardcoded
          // guide, so it's the one place this needed wiring.
          guide: embeddedGuide || DEFAULT_GUIDE,
          lead: { name: item.lead_name || ("Lead " + item.lead_id), company: "", stage: item.lead_stage || item.kind || "" },
          messages: messages,
          brokerName: activeBroker(),
          brokerId: activeBroker(),
          leadId: item.lead_id,
          revisionChain: item.revisionChain,
          image: item._contextImage || undefined,
          outputLanguage: embeddedOutputLanguage || "English",
          attachments: (item.attachments || []).filter(function (a) { return a.type === "link" && a.url; }),
        }),
      });
      // Show what the server actually said. "API 502" told the broker nothing —
      // the usual cause is the AI balance running out, which they can fix.
      if (!res.ok) {
        var errText = "API " + res.status;
        try { var ej = await res.json(); if (ej && ej.error) errText = ej.error; } catch (e2) {}
        throw new Error(errText);
      }
      var json = await res.json();
      if (json && json.text) item.text = json.text;
      // A revision about the listings re-picks them server-side. Links the
      // broker added by hand stay — they overrode the bot on purpose. But when
      // the panel was curated, the server now echoes the broker's own set back
      // verbatim (see suggest.ts) — concatenating item.attachments' own _broker
      // copy on top of that would just duplicate every link.
      if (json && Array.isArray(json.attachments)) {
        if (item._attachmentsCurated) {
          item.attachments = json.attachments;
        } else {
          var keep = (item.attachments || []).filter(function (a) { return a._broker; });
          item.attachments = json.attachments.concat(keep);
        }
        // _attachmentsCurated only reflects THIS round's edit — a link added by
        // hand in an EARLIER revision round keeps its _broker flag while the
        // curated flag itself doesn't carry forward, so the branch above can
        // still concat a link the server already echoed back on its own.
        // Dedupe by URL regardless of why, so the client never sees the same
        // listing attached twice.
        var seenUrls = {};
        var deduped = [];
        for (var di = 0; di < item.attachments.length; di++) {
          var dUrl = item.attachments[di].url;
          if (dUrl && seenUrls[dUrl]) continue;
          if (dUrl) seenUrls[dUrl] = true;
          deduped.push(item.attachments[di]);
        }
        item.attachments = deduped;
        showToast("Options updated: " + item.attachments.length + " link(s)");
      }
      // The bot re-read the temperature from the pasted screenshot — apply it so
      // the follow-up cadence and the chip reflect ground truth, not stale sync.
      if (json && json.reassessed_temperature) {
        item.profile_temperature = json.reassessed_temperature;
        item.profile_temperature_source = "ai";
        showToast("Temperature re-assessed: " + json.reassessed_temperature);
      }
      item._contextImage = null;
    } catch (e) {
      item.error = (e && e.message) || "AI rewrite failed";
    } finally {
      item.loading = false; render();
    }
  }

  function openDetail(item, tabKind) {
    var nextStages = stagesAfterCurrent(item.lead_stage || "");
    // Non-terminal stages apply themselves server-side on approve, so the only
    // thing that needs the broker's hand here is a closing stage (Closed
    // won/lost): pre-filled and pre-checked so confirming is a single tap.
    var termStage = item.suggested_stage_terminal ? (item.suggested_stage || "") : "";
    var stageChecked = termStage ? true : detectStageTransition(item.suggestion_text);
    openItem = {
      id: item.id,
      lead_id: item.lead_id,
      kind: tabKind,
      followup_level: item.followup_level,
      responsible_user: item.responsible_user,
      lead_name: item.lead_name || null,
      lead_stage: item.lead_stage || null,
      lead_stage_id: item.lead_stage_id || null,
      next_followup_at: item.next_followup_at || null,
      profile_temperature: item.profile_temperature || null,
      profile_temperature_source: item.profile_temperature_source || null,
      text: item.suggestion_text || "",
      original: item.suggestion_text || "",
      _contextImage: null,
      recent_messages: Array.isArray(item.recent_messages) ? item.recent_messages : [],
      attachments: Array.isArray(item.attachments) ? item.attachments.slice() : [],
      loading: false,
      busy: false,
      error: "",
      revisionChain: [],
      _stageChecked: stageChecked,
      _selectedStage: termStage || (stageChecked && nextStages.length > 0 ? nextStages[0] : ""),
      _originalStage: item.lead_stage || null,
      suggested_stage: item.suggested_stage || null,
      suggested_stage_reason: item.suggested_stage_reason || null,
      suggested_stage_terminal: !!item.suggested_stage_terminal,
      _skipExpanded: false,
      _skipTaskMode: false,
      _skipTaskVoice: "",
      _stageConfirm: null,
      _stageExpanded: false,
      _approving: false,
    };
    editing = false;
    render();
    window.scrollTo(0, 0);
  }

  function renderConnecting() {
    app.innerHTML =
      '<div class="setup"><div class="brand"><span class="dot"></span> Copilot Inbox</div>' +
      '<p style="color:#8a93a8;font-size:13px;margin-top:10px">Connecting…</p></div>';
  }

  function renderSetup() {
    app.innerHTML =
      '<div class="setup">' +
        '<div class="brand"><span class="dot"></span> Copilot Inbox</div>' +
        '<p style="color:#8a93a8;font-size:13px;margin-top:10px">Enter your broker name exactly as it appears in amoCRM (e.g. Robert, Amelia, HoS).</p>' +
        '<input id="broker-input" placeholder="Broker name" autocapitalize="words" />' +
        '<button id="broker-save">Continue</button>' +
      "</div>";
    $("#broker-save").onclick = function () {
      var v = $("#broker-input").value.trim();
      if (!v) return;
      brokerName = v;
      localStorage.setItem("copilot_broker", v);
      render();
      fetchInbox();
    };
  }

  // ── Report ───────────────────────────────────────────────────────────────
  function fetchReport() {
    var b = activeBroker();
    if (!b) return;
    reportBusy = true;
    var pipeQ = pipelineView ? "&pipeline=" + encodeURIComponent(pipelineView) : "";
    var mine = fetch(API + "/report?broker=" + encodeURIComponent(b) + "&period=" + reportPeriod + pipeQ)
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d.error) reportCard = d; })
      .catch(function () {});
    var team = isHosLogin()
      ? fetch(API + "/report/team?period=" + reportPeriod + pipeQ)
          .then(function (r) { return r.json(); })
          .then(function (d) { if (!d.error) reportTeam = d; })
          .catch(function () {})
      : Promise.resolve();
    return Promise.all([mine, team]).then(function () {
      reportBusy = false;
      if (reportView) render();
    });
  }

  function fmtMins(m) {
    if (m == null) return "\\u2014";
    if (m < 60) return Math.round(m) + " min";
    if (m < 60 * 24) return (Math.round(m / 6) / 10) + " h";
    return Math.round(m / 60 / 24) + " d";
  }

  // Movement against the previous period. Shown only where a direction has an
  // obvious meaning — "12 lost, up 4" reads as a warning, which it is.
  function delta(now, before, higherIsBetter) {
    if (before == null || before === now) return "";
    var diff = now - before;
    var up = diff > 0;
    var good = higherIsBetter ? up : !up;
    var cls = good ? "rep-good" : "rep-alert";
    return '<span class="rep-delta ' + cls + '">' + (up ? "\\u2191" : "\\u2193") + Math.abs(diff) + "</span>";
  }

  function statBox(n, label, alert) {
    return '<div class="rep-stat"><div class="n' + (alert && n > 0 ? " rep-alert" : "") + '">' + n +
      '</div><div class="l">' + label + "</div></div>";
  }

  function line(label, value, extra) {
    return '<div class="rep-line"><span>' + label + '</span><span class="v">' + value + (extra || "") + "</span></div>";
  }

  function renderReportCard(c, withName) {
    var html = "";
    if (withName) {
      html += '<div class="rep-name">' + esc(c.broker) +
        (c.notifications === "off" ? ' <span class="rep-delta rep-alert">\\ud83d\\udd15 no notifications</span>' : "") +
        "</div>";
    }
    html += '<div class="rep-hero">';
    html += '<div class="when">' + esc(c.label) + "</div>";
    html += '<div class="rep-headline">' + esc(c.headline) + "</div>";
    html += '<div class="rep-row">';
    html += statBox(c.waiting, "waiting for<br>an answer", true);
    html += statBox(c.waitingOverdue, "of them over<br>24 hours", true);
    html += statBox(c.overdueFollowups, "follow-ups<br>overdue", true);
    html += statBox(c.hotStalled, "warm, no contact<br>3+ days", true);
    html += "</div>";
    if (c.hotStalledNames && c.hotStalledNames.length) {
      html += '<div class="l" style="font-size:11.5px;color:#8a93a8;margin-top:10px">Going cold: ' +
        esc(c.hotStalledNames.join(", ")) + "</div>";
    }
    html += "</div>";

    // Promises the broker made and has not come back on. These used to exist
    // only inside a push notification fired once, so for a broker with no
    // subscription they were invisible everywhere.
    if (c.openPromises > 0) {
      html += '<div class="rep-head">Promised, not delivered</div>';
      var pr = c.openPromiseItems || [];
      for (var q = 0; q < pr.length; q++) {
        var it = pr[q];
        var who = it.leadName ? it.leadName : "#" + it.leadId;
        var age = it.hoursOverdue >= 48
          ? Math.round(it.hoursOverdue / 24) + "d late"
          : Math.max(0, it.hoursOverdue) + "h late";
        html += line(esc(who) + ": " + esc(it.promise), '<span class="rep-alert">' + esc(age) + "</span>");
      }
      if (c.openPromises > pr.length) {
        html += line("and more", c.openPromises - pr.length);
      }
    }

    if (c.waitingByPipeline && c.waitingByPipeline.length > 1) {
      html += '<div class="rep-head">Waiting, by funnel</div>';
      for (var p = 0; p < c.waitingByPipeline.length; p++) {
        var wp = c.waitingByPipeline[p];
        html += line(esc(wp.pipeline), wp.waiting + (wp.overdue > 0 ? ' <span class="rep-alert">(' + wp.overdue + " over a day)</span>" : ""));
      }
    }

    var prev = c.previous;
    html += '<div class="rep-head">' + (c.period === "day" ? "Today" : c.period === "week" ? "This week" : "This month") + "</div>";
    html += line("Messages sent", c.activity.sent, prev ? delta(c.activity.sent, prev.sent, true) : "");
    html += line("Drafts skipped", c.activity.skipped, prev ? delta(c.activity.skipped, prev.skipped, false) : "");
    html += line("Drafts never opened", c.activity.untouched);
    html += line("New leads", c.newLeads, prev ? delta(c.newLeads, prev.newLeads, true) : "");
    html += line("Median reply time", fmtMins(c.medianReplyMin));
    if (c.yesterday) {
      html += '<div class="rep-head">Yesterday</div>';
      html += line("Sent / skipped / never opened",
        c.yesterday.sent + " / " + c.yesterday.skipped + " / " + c.yesterday.untouched);
    }

    html += '<div class="rep-head">Result</div>';
    html += line("Moved forward in the funnel", c.advanced, prev ? delta(c.advanced, prev.advanced, true) : "");
    html += line("Viewings arranged", c.viewings, prev ? delta(c.viewings, prev.viewings, true) : "");
    html += line("Listings taken on", c.listingsTaken, prev ? delta(c.listingsTaken, prev.listingsTaken, true) : "");
    html += line("Lost", c.lost, prev ? delta(c.lost, prev.lost, false) : "");
    return html;
  }

  function renderReport() {
    var html = "";
    html += '<div class="rep-periods">';
    [["day", "Day"], ["week", "Week"], ["month", "Month"]].forEach(function (p) {
      html += '<div class="p ' + (reportPeriod === p[0] ? "on" : "") + '" data-period="' + p[0] + '">' + p[1] + "</div>";
    });
    html += "</div>";

    if (reportTeam && reportTeam.cards && reportTeam.cards.length) {
      // Admin view: everyone, own card first. Deliberately the same card shape
      // for each - one comparison, not a table nobody can read on a phone.
      var mine = (activeBroker() || "").trim().toLowerCase();
      var cards = reportTeam.cards.slice().sort(function (a, b) {
        var am = a.broker.trim().toLowerCase() === mine ? 0 : 1;
        var bm = b.broker.trim().toLowerCase() === mine ? 0 : 1;
        if (am !== bm) return am - bm;
        return (b.waiting + b.waitingOverdue) - (a.waiting + a.waitingOverdue);
      });
      for (var i = 0; i < cards.length; i++) {
        html += '<div style="margin-bottom:22px">' + renderReportCard(cards[i], true) + "</div>";
      }
      return html;
    }

    if (!reportCard) {
      html += '<div class="empty">' + (reportBusy ? "Loading\\u2026" : "No report yet.") + "</div>";
      return html;
    }
    html += renderReportCard(reportCard, false);
    return html;
  }

  // The banner that should have existed from the first day push was built.
  // Silence is the failure mode it exists for: a broker with notifications off
  // looks exactly like a broker with nothing to do.
  //
  // It is a one-time prompt, NOT a state indicator, and the difference is the
  // whole design. The first version asked again on every launch of an app whose
  // notifications were already working — because it read server-side coverage
  // (a fact about a broker) to decide something about a device, and because
  // nothing let anyone say "understood, stop asking". A prompt that repeats
  // after it has been answered is worse than no prompt: it trains people to
  // ignore the one place we put real warnings. Hence: local subscription is the
  // only test, and a dismissal is permanent. The bell in the header stays the
  // way to change your mind.
  // Leads the bot could not take on at all. Unlike the notification banner this
  // is NOT dismissible and NOT a prompt: it is a live fault. Every outage on
  // this project has looked like an empty inbox, so an empty inbox must be able
  // to tell the difference between "nothing to do" and "I am broken".
  var stuckCount = 0;
  async function refreshStuck() {
    try {
      var r = await fetch(API + "/stuck-leads?responsibleUser=" + encodeURIComponent(activeBroker()), { cache: "no-store" });
      var d = await r.json();
      stuckCount = d && typeof d.count === "number" ? d.count : 0;
    } catch (e) { /* never let this break the inbox */ }
  }
  function stuckBannerHtml() {
    if (!stuckCount) return "";
    return '<div class="push-banner">\u26a0\ufe0f <b>' + stuckCount + ' lead(s) the bot could not pick up.</b><br>' +
      'They are in a tracked pipeline but have no conversation and no draft, so they will not appear in any tab. ' +
      'Usually the scout note arrived in a layout the parser did not recognise. Worth a look in amoCRM.</div>';
  }

  function pushBannerDismissed() {
    return localStorage.getItem("copilot_push_banner_off") === "1";
  }
  function dismissBtn() {
    return '<button id="push-dismiss-btn" title="Do not show again" style="float:right;background:none;border:none;color:inherit;opacity:.6;font-size:17px;line-height:1;padding:0 0 0 10px;cursor:pointer">\\u00d7</button>';
  }
  function pushBannerHtml() {
    if (pushBannerDismissed()) return "";
    if (EMBEDDED) {
      // In the panel there is nothing local to read, so the server's answer is
      // all there is — but it still only ever appears while genuinely dark.
      if (pushCovered !== false) return "";
      return '<div class="push-banner">' + dismissBtn() + '\\ud83d\\udd15 <b>Your phone is not set up for notifications.</b><br>' +
        'You will not know a client replied until you open this panel, and the morning report will not reach you. ' +
        'Notifications can only be switched on from the app itself, on the device that should ring.' +
        '<br><a class="act" href="' + location.origin + '/m" target="_blank" rel="noopener">Open the app</a></div>';
    }
    if (!pushSupported()) return "";
    // Already subscribed on this device, or permission granted (in which case
    // syncPushSubscription has just subscribed): nothing to ask, ever.
    if (pushLocalSub === true) return "";
    if (Notification.permission === "granted") return "";
    // Still unknown (the check has not resolved): stay quiet rather than flash
    // a prompt at someone who turns out to be fine.
    if (pushLocalSub === null) return "";
    if (Notification.permission === "denied") {
      return '<div class="push-banner">' + dismissBtn() + '\\ud83d\\udd15 <b>Notifications are blocked for this app.</b><br>' +
        'Remove the icon from your home screen, add it again via Share \\u2192 Add to Home Screen, then turn them on.</div>';
    }
    return '<div class="push-banner">' + dismissBtn() + '\\ud83d\\udd15 <b>Notifications are off.</b><br>' +
      'Client replies and your 8am report will not reach you until you turn them on.' +
      '<br><button class="act" id="push-enable-btn">Turn on notifications</button></div>';
  }

  function renderList() {
    var list = sortedList(activeTab);
    var tabDef = [["live", "Live"], ["reach", "Reach"], ["push", "Push"]];
    var html = "";
    html += '<header>';
    html += '<div class="top-row">';
    html += '<div class="brand"><span class="dot"></span> Copilot Inbox</div>';
    html += '<div class="top-actions">';
    if (isHosLogin()) {
      // HoS-only: view/act as any other broker without re-logging in. Every
      // API call already reads activeBroker() instead of brokerName, so
      // switching here is enough — no separate "impersonate" endpoint needed.
      html += '<select id="hos-view-select" class="broker-chip" style="cursor:pointer;border-color:' + (hosViewAs ? "#fbbf24" : "#2a3146") + '">';
      html += '<option value=""' + (!hosViewAs ? " selected" : "") + '>\\ud83d\\udc64 ' + esc(brokerName) + ' (me)</option>';
      HOS_ROSTER.forEach(function (name) {
        html += '<option value="' + esc(name) + '"' + (hosViewAs === name ? " selected" : "") + '>\\ud83d\\udc41 ' + esc(name) + '</option>';
      });
      html += '</select>';
    } else {
      html += '<span class="broker-chip">\\ud83d\\udc64 <b>' + esc(brokerName) + '</b></span>';
    }
    // Live list from /api/public/pipelines — whatever pipelines actually have
    // tracked leads right now, so a newly-synced pipeline shows up here on
    // its own with no code change. "All pipelines" (unset) is the plain-
    // language default instead of an unexplained "Auto".
    html += '<select id="pipeline-select" class="broker-chip" style="cursor:pointer" title="Which pipeline\\'s leads to show">';
    html += '<option value=""' + (!pipelineView ? " selected" : "") + '>\\ud83d\\udd00 All pipelines</option>';
    pipelineOptions.forEach(function (name) {
      html += '<option value="' + esc(name) + '"' + (pipelineView.toLowerCase() === name.toLowerCase() ? " selected" : "") + '>' + esc(name) + '</option>';
    });
    html += '</select>';
    // Push relies on this document's own service-worker registration and
    // Notification permission — both Permissions-Policy-gated to 'self' for
    // a cross-origin iframe (amoCRM's domain vs. this server's), so offering
    // it here would be a bell that silently never works. The standalone PWA
    // (installed to the home screen) is the intended place for push.
    if (pushSupported() && !EMBEDDED) {
      var pushOn = pushEnabled();
      html += '<button class="refresh-btn" id="toggle-push-btn" title="' + (pushOn ? "Disable notifications" : "Enable notifications") + '" style="' + (pushOn ? "" : "opacity:.45") + '">' + (pushOn ? "\\ud83d\\udd14" : "\\ud83d\\udd15") + '</button>';
    }
    html += '<button class="refresh-btn" id="listing-btn" title="Add a listing" style="opacity:.65">\\ud83c\\udfe1</button>';
    html += '<button class="refresh-btn" id="report-btn" title="' + (reportView ? "Back to leads" : "My report") + '" style="' + (reportView ? "color:#2dd4bf" : "opacity:.65") + '">\\ud83d\\udcca</button>';
    html += '<button class="refresh-btn" id="refresh-btn" title="Refresh">\\u27f3</button>';
    html += '<button class="refresh-btn" id="autopilot-btn" title="Autopilot">\\ud83e\\udd16</button>';
    html += "</div></div>";
    if (apOpen) {
      var apStages = apData && apData.stages ? apData.stages : [];
      var apSet = (apData && apData.setting) || { mode: "off", upToStageName: null };
      var apOn = apSet.mode === "on" && apSet.upToStageName;
      html += '<div class="stage-hint" id="ap-panel" style="margin-top:8px">';
      html += '<b>\\ud83e\\udd16 Autopilot</b> \\u2014 send without approval up to a chosen stage. Off = every message waits for you, as now.<br>';
      html += '<select id="ap-sel" style="margin:6px 6px 0 0;max-width:75%">';
      html += '<option value=""' + (!apOn ? " selected" : "") + '>Off</option>';
      for (var ai = 0; ai < apStages.length; ai++) {
        html += '<option value="' + esc(apStages[ai]) + '"' + (apOn && apSet.upToStageName === apStages[ai] ? " selected" : "") + '>Up to \\u201c' + esc(apStages[ai]) + '\\u201d</option>';
      }
      html += "</select>";
      var bf = (apData && apData.bf) || { enabled: false, minMonthlyIdr: 0 };
      html += '<div style="margin-top:8px"><b>\\ud83d\\udcb0 Budget filter</b> \\u2014 rental leads with a stated budget below this go to Closed Lost automatically, no tokens spent:</div>';
      html += '<input id="bf-min" type="number" min="1" step="1" value="' + (bf.minMonthlyIdr ? Math.round(bf.minMonthlyIdr / 1000000) : 40) + '" style="width:70px;margin:6px 4px 0 0"> million IDR/mo ';
      html += '<select id="bf-on" style="margin:6px 0">';
      html += '<option value="off"' + (!bf.enabled ? " selected" : "") + '>Off</option>';
      html += '<option value="on"' + (bf.enabled ? " selected" : "") + '>On</option>';
      html += "</select><br>";
      html += '<button class="refresh-btn" id="ap-save" style="margin-top:6px">Save</button>';
      html += "</div>";
    }
    if (!reportView) {
      html += '<div class="tabs">';
      for (var i = 0; i < tabDef.length; i++) {
        var key = tabDef[i][0], label = tabDef[i][1];
        html += '<div class="tab ' + (activeTab === key ? "active" : "") + '" data-tab="' + key + '">' +
          label + '<span class="count">' + (items[key] || []).length + "</span></div>";
      }
      html += "</div>";
    }
    html += "</header><main>";

    html += stuckBannerHtml();
    html += pushBannerHtml();

    if (reportView) {
      html += renderReport();
    } else if (list.length === 0) {
      var emptyText = activeTab === "live"
        ? "All live replies handled. New ones will appear here as leads respond."
        : activeTab === "reach"
          ? "No qualification follow-ups due right now. They appear when amoCRM tasks are due."
          : "No active pipeline follow-ups right now.";
      html += '<div class="empty">All caught up \\ud83c\\udf89<br>' + emptyText + '</div>';
    } else {
      for (var j = 0; j < list.length; j++) {
        var item = list[j];
        var leadUrl = "https://unicornproperty.amocrm.ru/leads/detail/" + encodeURIComponent(item.lead_id);
        html += '<div class="card" data-id="' + esc(item.id) + '">';
        html += '<div class="card-top">';
        html += '<a class="card-lead-link" data-leadlink href="' + leadUrl + '">' + (item.lead_name ? esc(item.lead_name) + ' <span class="dim">#' + esc(item.lead_id) + '</span>' : "Lead " + esc(item.lead_id)) + '</a>';
        html += '<span class="card-time">' + fmtAgo(item.created_at) + "</span>";
        html += "</div>";
        if (item.lead_notes) {
          html += '<div class="card-notes">' + esc(String(item.lead_notes).split("\\n")[0].trim().slice(0, 80)) + '</div>';
        }
        html += '<div class="badges">' + cardBadges(item) + "</div>";
        var previewText = (item.kind === "live" && item.last_lead_text) ? item.last_lead_text : (item.suggestion_text || "");
        html += '<div class="card-preview">' + esc(previewText.slice(0, 160)) + "</div>";
        var footLabel = item.responsible_user ? item.responsible_user : (activeTab === "live" ? "Live reply" : activeTab === "reach" ? "Reach follow-up" : "Push follow-up");
        html += '<div class="card-foot"><span>' + esc(footLabel) + '</span><span class="card-arrow">\\u203a</span></div>';
        html += "</div>";
      }
    }
    html += "</main>";
    app.innerHTML = html;

    $("#refresh-btn").onclick = fetchInbox;
    var pipeSelect = $("#pipeline-select");
    if (pipeSelect) pipeSelect.onchange = function () {
      pipelineView = pipeSelect.value;
      localStorage.setItem("copilot_pipeline_view", pipelineView);
      openItem = null; editing = false;
      fetchInbox();
    };
    var hosSelect = $("#hos-view-select");
    if (hosSelect) hosSelect.onchange = function () {
      hosViewAs = hosSelect.value;
      localStorage.setItem("copilot_hos_view_as", hosViewAs);
      openItem = null; editing = false;
      fetchInbox();
    };
    var apBtn = $("#autopilot-btn");
    if (apBtn) apBtn.onclick = async function () {
      apOpen = !apOpen;
      if (apOpen && !apData) {
        try {
          var r = await fetch(API + "/autopilot?pipeline=rental");
          apData = await r.json();
          var rb = await fetch(API + "/budget-filter?pipeline=rental");
          var jb = await rb.json();
          apData.bf = (jb && jb.setting) || { enabled: false, minMonthlyIdr: 0 };
        } catch (e) { apData = null; }
      }
      render();
    };
    var apSave = $("#ap-save");
    if (apSave) apSave.onclick = async function () {
      var v = $("#ap-sel").value;
      var payload = v
        ? { pipeline: "rental", mode: "on", upToStageName: v, dailyCap: 30 }
        : { pipeline: "rental", mode: "off", upToStageName: null, dailyCap: 30 };
      try {
        var r2 = await fetch(API + "/autopilot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        var j2 = await r2.json();
        var bfOn = $("#bf-on").value === "on";
        var bfMin = Math.max(0, Math.round(Number($("#bf-min").value) || 0)) * 1000000;
        var r3 = await fetch(API + "/budget-filter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pipeline: "rental", enabled: bfOn, minMonthlyIdr: bfMin }) });
        var j3 = await r3.json();
        if (j2 && j2.ok && j3 && j3.ok) {
          if (apData) { apData.setting = j2.setting; apData.bf = j3.setting; }
          showToast((v ? "Autopilot up to \\u201c" + v + "\\u201d" : "Autopilot off") + " \\u00b7 Budget filter " + (bfOn ? "ON at " + Math.round(bfMin / 1000000) + "M" : "off"));
          apOpen = false; render();
        }
        else showToast((j2 && j2.error) || (j3 && j3.error) || "Could not save");
      } catch (e) { showToast("Could not save: " + (e && e.message)); }
    };
    var togglePushBtn = $("#toggle-push-btn");
    if (togglePushBtn) togglePushBtn.onclick = togglePush;
    var pushEnableBtn = $("#push-enable-btn");
    if (pushEnableBtn) pushEnableBtn.onclick = enablePush;
    var pushDismissBtn = $("#push-dismiss-btn");
    if (pushDismissBtn) pushDismissBtn.onclick = function () {
      localStorage.setItem("copilot_push_banner_off", "1");
      render();
    };
    document.querySelectorAll(".rep-periods .p").forEach(function (el) {
      el.onclick = function () {
        reportPeriod = el.getAttribute("data-period");
        reportCard = null; reportTeam = null;
        render();
        fetchReport();
      };
    });
    var listingBtn = $("#listing-btn");
    if (listingBtn) listingBtn.onclick = function () { listingView = true; render(); };
    var reportBtn = $("#report-btn");
    if (reportBtn) reportBtn.onclick = function () {
      reportView = !reportView;
      render();
      if (reportView) fetchReport();
    };
    document.querySelectorAll(".tab").forEach(function (el) {
      el.onclick = function () { activeTab = el.getAttribute("data-tab"); render(); };
    });
    document.querySelectorAll(".card").forEach(function (el) {
      el.onclick = function () {
        var id = el.getAttribute("data-id");
        var found = list.find(function (i) { return i.id === id; });
        if (found) openDetail(found, activeTab);
      };
      var link = el.querySelector("[data-leadlink]");
      if (link) link.addEventListener("click", function (e) { e.stopPropagation(); });
    });
  }

  function renderDetail() {
    var it = openItem;
    var leadUrl = "https://unicornproperty.amocrm.ru/leads/detail/" + encodeURIComponent(it.lead_id);
    var html = "";
    html += '<header><div class="detail-header">';
    html += '<button class="back-btn" id="back-btn">\\u2190 Back</button>';
    html += '<a class="openlead-btn" href="' + leadUrl + '" target="_blank" rel="noopener">\\u2197 Open Lead</a>';
    html += "</div>";
    html += '<div class="lead-hdr"><span class="lead-hdr-name">' + (it.lead_name ? esc(it.lead_name) + ' <span style="opacity:.5;font-weight:400">#' + esc(it.lead_id) + '</span>' : "Lead " + esc(it.lead_id)) + '</span>' + taskStatusBadge(it.next_followup_at) + '</div>';
    html += "</header><main>";

    // Broker-editable temperature. Their pick is authoritative and sticky
    // (source "broker"); the bot's own read shows as "(AI)". Feeds the adaptive
    // follow-up cadence — hot → sooner, cold → stretched.
    html += '<div class="temp-ctl">';
    html += '<span class="temp-ctl-lbl">Temp' + (it.profile_temperature_source === "broker" ? " \\u2713" : (it.profile_temperature_source === "ai" ? " (AI)" : "")) + '</span>';
    var _temps = [["hot", "\\ud83d\\udd25 Hot"], ["warm", "\\ud83c\\udf24 Warm"], ["cold", "\\u2744\\ufe0f Cold"]];
    for (var _ti = 0; _ti < _temps.length; _ti++) {
      var _tk = _temps[_ti][0];
      html += '<button class="temp-btn temp-' + _tk + (it.profile_temperature === _tk ? " active" : "") + '" data-settemp="' + _tk + '">' + _temps[_ti][1] + '</button>';
    }
    html += '</div>';

    var msgs = it.recent_messages || [];
    html += '<div class="thread-lbl">\\ud83d\\udcac Conversation</div>';
    html += '<div class="conv">';
    if (msgs.length === 0) {
      html += '<div class="no-conv">No conversation history yet</div>';
    } else {
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        var isUs = m.from === "us";
        html += '<div class="tmsg ' + (isUs ? "us" : "lead") + '">';
        var _at = fmtAt(m.at);
        html += '<div class="tmsg-hdr"><span class="tsender">' + (isUs ? "You" : "Lead") + '</span>' + (_at ? '<span class="tat">' + esc(_at) + '</span>' : '') + '</div>';
        html += '<div class="tbubble">' + linkify(esc(m.text)) + '</div>';
        html += '</div>';
      }
    }
    html += '</div>';
    html += '<div class="conv-resize" id="conv-resize" title="Drag to resize"></div>';

    html += '<div class="body-block">';
    if (editing) {
      html += '<label class="section">Edit message</label>';
      html += '<textarea id="msg-text" placeholder="Edit message…">' + esc(editValue) + '</textarea>';
      html += renderAttachments(it, true);
      html += '<button class="att-pick-btn" id="att-pick-btn">\\ud83c\\udf10 Choose on site</button>';
      html += '<div class="att-add-row"><input class="att-add-input" id="att-add-url" placeholder="…or paste a property link"><button class="att-add-btn" id="att-add-btn">+ Add</button></div>';
      html += '<input type="file" id="file-input" accept="image/*" style="display:none">';
      html += '<div class="ai-input-wrap">';
      html += '<textarea class="aiinput" id="ai-input" placeholder="Tell AI what to change…" rows="2"></textarea>';
      html += '<div class="ai-btn-row"><button class="ai-mic-btn" id="voice-btn" title="Voice input">\\ud83c\\udfa4 Dictate</button><button class="ai-send-btn" id="rewrite-btn" title="Send"' + (it.loading ? " disabled" : "") + '>\\u2191 Send</button></div>';
      html += '</div>';
      // Screenshot AS CONTEXT (not an attachment to send): the broker pastes or
      // picks a screenshot of the real chat; the bot reads it as ground truth,
      // bypassing any stale CRM sync, and re-assesses the reply + temperature.
      html += '<div class="ctx-row">';
      html += '<button class="ctx-btn" id="ctx-shot-btn">\\ud83d\\uddbc\\ufe0f Screenshot as context</button>';
      if (it._contextImage) html += '<span class="ctx-attached">\\u2713 screenshot attached <button class="ctx-x" id="ctx-clear" title="Remove">\\u2715</button></span>';
      html += '</div>';
      html += '<input type="file" id="ctx-file" accept="image/*" style="display:none">';
    } else if (it.loading) {
      html += '<label class="section">Suggested message</label>';
      html += '<div class="skel"><div></div><div></div><div></div><div></div></div>';
    } else {
      html += '<label class="section">Suggested message</label>';
      html += '<div class="msg-text">' + linkify(esc(it.text)) + '</div>';
      html += renderAttachments(it, false);
    }
    if (it.error) html += '<div class="err-text">' + esc(it.error) + '</div>';
    html += '</div>';

    if (!editing) {
      var nextStages = stagesAfterCurrent(it.lead_stage);
      if (it.suggested_stage) {
        html += '<div class="stage-hint">' +
          (it.suggested_stage_terminal
            ? '\\u26a0\\ufe0f Confirm to close: \\u201c' + esc(it.suggested_stage) + '\\u201d'
            : '\\u2713 Stage moves to \\u201c' + esc(it.suggested_stage) + '\\u201d on send') +
          (it.suggested_stage_reason ? ' <span class="dim">(' + esc(it.suggested_stage_reason) + ')</span>' : '') +
          '</div>';
      }
      // The stage now follows the conversation on its own, so the manual picker
      // is collapsed out of the way. It stays reachable for the cases the bot
      // deliberately won't do itself: confirming a close, setting an
      // administrative stage (Mailing, Long-Term Cycle — those describe work
      // outside the chat), or overriding a misjudged classification.
      var stageOpen = it._stageExpanded || it.suggested_stage_terminal || it._stageChecked;
      if (!stageOpen) {
        html += '<button class="stage-toggle" id="stage-toggle">Change stage \\u2304</button>';
      }
      html += '<div class="action-row"' + (stageOpen ? "" : ' style="display:none"') + '>';
      html += '<input type="checkbox" class="ext-cb" id="stage-cb" ' + (it._stageChecked ? "checked" : "") + '>';
      html += '<span class="action-row-lbl">Next step:</span>';
      html += '<select class="ext-select" id="stage-select" ' + (!it._stageChecked ? "disabled" : "") + '>';
      html += '<option value="">— select —</option>';
      for (var s = 0; s < nextStages.length; s++) {
        var sName = nextStages[s];
        html += '<option value="' + esc(sName) + '"' + (it._selectedStage === sName ? " selected" : "") + '>' + esc(sName) + '</option>';
      }
      html += '</select></div>';
    }

    html += '<div class="actions">';
    if (editing) {
      html += '<button class="edit-ok" id="save-edit-btn" title="Save">\\u2713</button>';
      html += '<button class="edit-x" id="cancel-edit-btn" title="Cancel">\\u2715</button>';
    } else if (it._stageConfirm) {
      html += '<div class="stage-confirm">';
      html += '<span class="stage-confirm-lbl">Move to \\u201c' + esc(it._stageConfirm.newStage) + '\\u201d:</span>';
      html += '<button class="act approve" id="confirm-send-move" ' + (it.busy ? "disabled" : "") + '>\\u2713 Send + Move</button>';
      html += '<button class="act skip" id="confirm-move-only" ' + (it.busy ? "disabled" : "") + '>\\u203a Only Move</button>';
      html += '<button class="act skip" id="confirm-cancel">\\u2715 Cancel</button>';
      html += '</div>';
    } else {
      html += '<button class="act approve" id="approve-btn" ' + ((it.busy || it.loading) ? "disabled" : "") + '>' + (it.busy ? "Sending…" : "\\u2713 Approve &amp; Send") + '</button>';
      if (it.kind === "live") {
        html += '<button class="act replied" id="replied-btn" ' + (it.busy ? "disabled" : "") + '>\\ud83d\\udeab No reply needed</button>';
      } else {
        html += '<button class="act skip" id="skip-btn" ' + (it.busy ? "disabled" : "") + '>\\u2715 Skip</button>';
      }
      html += '<button class="act edit" id="edit-btn" ' + ((it.busy || it.loading) ? "disabled" : "") + '>\\u270e Edit</button>';
    }
    html += '</div>';

    if (!editing && !it._stageConfirm) {
      html += '<div class="resched-row">';
      html += '<button class="resched-toggle" id="resched-toggle">\\ud83d\\udcc5 ' + (it._reschedOpen ? "Cancel reschedule" : "Reschedule follow-up") + '</button>';
      if (it._reschedOpen) {
        html += '<input type="date" id="resched-date" class="resched-date" value="' + (it._reschedDate || "") + '">';
        html += '<button class="mini" id="resched-confirm">\\u2713 Set date</button>';
      }
      html += '</div>';
    }

    if (it._skipExpanded && it.kind !== "live") {
      html += '<div class="skip-panel">';
      if (!it._skipTaskMode) {
        html += '<div class="skip-row">';
        html += '<span class="skip-lbl">Skip:</span>';
        html += '<button class="mini" id="skip-auto-btn">\\u2715 Continue auto schedule</button>';
        html += '<button class="mini" id="skip-taskmode-btn">\\ud83d\\udcc5 Set manual task</button>';
        html += '<button class="mini mini-danger" id="bot-exclude-btn">\\u2298 Remove from bot</button>';
        html += '</div>';
      } else {
        html += '<textarea class="aiinput" id="skip-task-voice" placeholder="Describe task by voice or text…" rows="2" style="background:#141827;border:1px solid #2a3146;border-radius:8px;padding:10px">' + esc(it._skipTaskVoice || "") + '</textarea>';
        html += '<div class="ai-btn-row" style="margin-top:6px">';
        html += '<button class="ai-mic-btn" id="skip-task-voice-btn" title="Voice input">\\ud83c\\udf99 Dictate</button>';
        html += '<button class="ai-send-btn" id="skip-task-confirm-btn" ' + (it.busy ? "disabled" : "") + '>\\u2713 Set Task</button>';
        html += '</div>';
      }
      html += '</div>';
    }

    html += "</main>";
    app.innerHTML = html;

    // The conversation box scrolls internally and renders oldest→newest, so it
    // opened parked on old history. Jump it to the bottom: the message the
    // broker needs to see is the lead's latest one, the one being replied to.
    var convEl = document.querySelector(".conv");
    if (convEl) convEl.scrollTop = convEl.scrollHeight;

    $("#back-btn").onclick = function () { openItem = null; editing = false; render(); };

    // Temperature chip — sticky broker override, POSTs /set-temperature.
    document.querySelectorAll("[data-settemp]").forEach(function (btn) {
      btn.onclick = async function () {
        var t = btn.getAttribute("data-settemp");
        if (it.profile_temperature === t) return;
        var prev = it.profile_temperature, prevSrc = it.profile_temperature_source;
        it.profile_temperature = t; it.profile_temperature_source = "broker";
        renderDetail();
        try {
          await fetch(API + "/set-temperature", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId: String(it.lead_id), temperature: t, brokerId: activeBroker() }) });
          showToast("Temperature set: " + t);
        } catch (e) {
          it.profile_temperature = prev; it.profile_temperature_source = prevSrc; renderDetail();
          showToast("Failed to set temperature");
        }
      };
    });

    // Draggable divider — resize the conversation box vs the message block.
    var _resizeEl = $("#conv-resize");
    var _convBox = document.querySelector(".conv");
    if (_resizeEl && _convBox) {
      if (convSplit) { _convBox.style.maxHeight = convSplit + "px"; _convBox.style.height = convSplit + "px"; }
      _resizeEl.onpointerdown = function (e) {
        e.preventDefault();
        var startY = e.clientY, startH = _convBox.offsetHeight;
        function mv(ev) {
          var h = Math.max(90, Math.min(640, startH + (ev.clientY - startY)));
          _convBox.style.maxHeight = h + "px"; _convBox.style.height = h + "px"; convSplit = h;
        }
        function up() {
          document.removeEventListener("pointermove", mv);
          document.removeEventListener("pointerup", up);
          try { localStorage.setItem("copilot_convsplit", String(convSplit)); } catch (e2) {}
        }
        document.addEventListener("pointermove", mv);
        document.addEventListener("pointerup", up);
      };
    }

    var stageToggle = $("#stage-toggle");
    if (stageToggle) {
      stageToggle.onclick = function () { it._stageExpanded = true; renderDetail(); };
    }

    var stageCb = $("#stage-cb");
    var stageSelect = $("#stage-select");
    if (stageCb && stageSelect) {
      stageCb.onchange = function () {
        it._stageChecked = stageCb.checked;
        stageSelect.disabled = !stageCb.checked;
        if (!stageCb.checked) { it._selectedStage = ""; stageSelect.value = ""; }
      };
      stageSelect.onchange = function () { it._selectedStage = stageSelect.value; };
    }

    if (editing) {
      var ta = $("#msg-text");
      ta.oninput = function () { editValue = ta.value; };
      requestAnimationFrame(function () {
        ta.focus();
        var len = ta.value.length;
        ta.setSelectionRange(len, len);
      });
      document.querySelectorAll("[data-rmattach]").forEach(function (btn) {
        btn.onclick = function () {
          var idx = Number(btn.getAttribute("data-rmattach"));
          it.attachments.splice(idx, 1);
          // The broker curated the list by hand — from now on the server must not
          // re-pick and resurrect what they just removed.
          it._attachmentsCurated = true;
          renderDetail();
        };
      });
      var attAddBtn = $("#att-add-btn");
      if (attAddBtn) {
        attAddBtn.onclick = function () {
          var input = $("#att-add-url");
          var url = (input.value || "").trim();
          if (!url) return;
          if (!/^https?:\\/\\//i.test(url)) { showToast("Needs to be a full link (https://…)"); return; }
          addAttachmentLink(it, url);
          input.value = "";
          renderDetail();
        };
      }
      var attPickBtn = $("#att-pick-btn");
      if (attPickBtn) {
        attPickBtn.onclick = function () {
          openPropertyPicker(function (urls) {
            // Purely additive — see addAttachmentLink's comment for why nothing
            // gets auto-removed here. The × button is the only way a link leaves.
            for (var i = 0; i < urls.length; i++) addAttachmentLink(it, urls[i]);
            renderDetail();
          });
        };
      }
      var fileInput = $("#file-input");
      fileInput.onchange = function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          it.attachments = it.attachments || [];
          it.attachments.push({ type: "image", url: reader.result, name: file.name, _broker: true });
          renderDetail();
        };
        reader.readAsDataURL(file);
      };
      $("#voice-btn").onclick = function () { startVoiceDictation($("#ai-input"), $("#voice-btn")); };
      $("#save-edit-btn").onclick = function () {
        stopVoiceDictation();
        // The checkmark ALWAYS saves the broker's manual edit verbatim. AI
        // rewriting is a separate, explicit action (the Send button next to the
        // AI box, or Enter inside it). Save must never regenerate the message:
        // a stray word left in the AI box would otherwise silently throw away
        // everything the broker just typed.
        it.text = editValue; editing = false; render();
      };
      $("#cancel-edit-btn").onclick = function () { stopVoiceDictation(); editing = false; render(); };
      $("#ai-input").onkeydown = function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          $("#rewrite-btn").click();
        }
      };
      $("#rewrite-btn").onclick = function () {
        var fb = $("#ai-input").value.trim() || "Rewrite this draft using the manual edits as guidance.";
        if (editValue && editValue !== it.text) it.text = editValue;
        // Same reasoning as voice dictation: on iPhone the keyboard eats half the
        // screen, and rewriteServer's re-render swaps out the focused field from
        // under it without ever telling Safari to dismiss it — the keyboard sat
        // there covering the incoming response while it loaded. Blur explicitly
        // before the async call, not after.
        try {
          $("#ai-input").blur();
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        } catch (e) {}
        rewriteServer(it, fb);
        editing = false; editValue = "";
      };
      // Screenshot-as-context: pick a file, or paste an image into the AI box.
      var ctxBtn = $("#ctx-shot-btn"), ctxFile = $("#ctx-file");
      if (ctxBtn && ctxFile) {
        ctxBtn.onclick = function () { ctxFile.click(); };
        ctxFile.onchange = function (e) {
          var f = e.target.files && e.target.files[0];
          if (!f) return;
          var r = new FileReader();
          r.onload = function () { it._contextImage = r.result; renderDetail(); showToast("Screenshot added as context"); };
          r.readAsDataURL(f);
        };
      }
      var ctxClear = $("#ctx-clear");
      if (ctxClear) ctxClear.onclick = function () { it._contextImage = null; renderDetail(); };
      var aiInEl = $("#ai-input");
      if (aiInEl) aiInEl.onpaste = function (e) {
        var cbItems = (e.clipboardData && e.clipboardData.items) || [];
        for (var pi = 0; pi < cbItems.length; pi++) {
          if (cbItems[pi].type && cbItems[pi].type.indexOf("image") === 0) {
            var file = cbItems[pi].getAsFile();
            if (file) {
              var r2 = new FileReader();
              r2.onload = function () { it._contextImage = r2.result; renderDetail(); showToast("Screenshot pasted as context"); };
              r2.readAsDataURL(file);
              e.preventDefault();
              return;
            }
          }
        }
      };
      return;
    }


    if (it._stageConfirm) {
      $("#confirm-send-move").onclick = async function () {
        if (it.busy) return;
        var text = it._stageConfirm.text, newStage = it._stageConfirm.newStage;
        it._stageConfirm = null; it._approving = true;
        it.lead_stage = newStage; it._selectedStage = newStage;
        await approveServer(it, text);
      };
      $("#confirm-move-only").onclick = async function () {
        if (it.busy) return;
        var text = it._stageConfirm.text, newStage = it._stageConfirm.newStage;
        it._stageConfirm = null;
        it.lead_stage = newStage; it._selectedStage = newStage;
        it.busy = true; render();
        try {
          await fetch(API + "/approve", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              suggestionId: it.id, message: text, brokerId: activeBroker(), newStage: newStage,
              stageId: stageIdForName(newStage) || it.lead_stage_id || undefined, skipMessage: true,
            }),
          });
          openItem = null;
          await fetchInbox();
        } catch (e) {
          it.error = String((e && e.message) || e);
          it.busy = false; render();
        }
      };
      $("#confirm-cancel").onclick = function () { it._stageConfirm = null; it._approving = false; render(); };
      return;
    }

    $("#approve-btn").onclick = async function () {
      if (it.busy || it._approving) return;
      var shouldChangeStage = !!(stageCb && stageCb.checked && stageSelect.value);
      var newStageVal = stageSelect ? stageSelect.value : "";
      // Property links are NOT appended to the text — the server sends each one
      // as its own follow-up WhatsApp message so every listing gets its own
      // link-preview banner instead of them all gluing into one message.
      var fullText = it.text;
      if (shouldChangeStage && newStageVal) {
        it._stageConfirm = { text: fullText, newStage: newStageVal };
        render();
        return;
      }
      it._approving = true;
      await approveServer(it, fullText);
    };
    if (it.kind === "live") {
      $("#replied-btn").onclick = function () { brokerReplied(it); };
    } else {
      $("#skip-btn").onclick = function () { it._skipExpanded = !it._skipExpanded; it._skipTaskMode = false; render(); };
    }
    $("#edit-btn").onclick = function () { editing = true; editValue = it.text; render(); };

    var reschedToggle = $("#resched-toggle");
    if (reschedToggle) reschedToggle.onclick = function () { it._reschedOpen = !it._reschedOpen; renderDetail(); };
    var reschedConfirm = $("#resched-confirm");
    if (reschedConfirm) reschedConfirm.onclick = async function () {
      var dEl = $("#resched-date"); var d = dEl ? dEl.value : "";
      if (!d) { showToast("Pick a date first"); return; }
      it._reschedDate = d; it.busy = true; render();
      try {
        var iso = new Date(d + "T09:00:00").toISOString();
        await fetch(API + "/reschedule-task", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId: String(it.lead_id), taskDate: iso }) });
        showToast("Follow-up moved to " + d);
        openItem = null; await fetchInbox();
      } catch (e) { showToast("Reschedule failed"); it.busy = false; render(); }
    };

    if (it._skipExpanded && it.kind !== "live") {
      if (!it._skipTaskMode) {
        $("#skip-auto-btn").onclick = function () { skipServer(it); };
        $("#skip-taskmode-btn").onclick = function () { it._skipTaskMode = true; render(); };
        $("#bot-exclude-btn").onclick = async function () {
          if (!confirm("Remove this lead from the bot? It will no longer appear in Push or Live. The lead stays in CRM.")) return;
          it.busy = true; render();
          try {
            await fetch(API + "/bot-exclude", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId: String(it.lead_id) }) });
            openItem = null;
            await fetchInbox();
          } catch (e) {
            showToast("Error: " + ((e && e.message) || e));
            it.busy = false; render();
          }
        };
      } else {
        var voiceTa = $("#skip-task-voice");
        voiceTa.oninput = function () { it._skipTaskVoice = voiceTa.value; };
        $("#skip-task-voice-btn").onclick = function () { startVoiceDictation(voiceTa, $("#skip-task-voice-btn")); };
        $("#skip-task-confirm-btn").onclick = async function () {
          var voiceText = (it._skipTaskVoice || "").trim();
          if (!voiceText) return;
          it.busy = true; render();
          try {
            showToast("Parsing task…");
            var pr = await fetch(API + "/parse-task", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: voiceText }) });
            var pj = await pr.json().catch(function () { return {}; });
            if (!pr.ok || !pj.taskDate) throw new Error(pj.error || "parse failed");
            showToast("Scheduling task…");
            await fetch(API + "/schedule-task", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId: String(it.lead_id), taskDate: pj.taskDate, taskText: pj.taskText }) });
            await fetch(API + "/skip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suggestionId: it.id }) });
            showToast("Task set: " + pj.taskDate + " — " + pj.taskText);
            openItem = null;
            await fetchInbox();
          } catch (e) {
            showToast("Error: " + String((e && e.message) || e).slice(0, 60));
            it.busy = false; render();
          }
        };
      }
    }
  }

  function render() {
    if (!brokerName) {
      // Embedded mode never asks the broker to type their own name — the
      // bridge is authoritative and posts it moments after the iframe loads.
      // Showing the manual-entry form here would both be redundant and,
      // worse, let someone accidentally type in the WRONG name inside a
      // panel meant to auto-identify them.
      if (EMBEDDED) { renderConnecting(); return; }
      renderSetup();
      return;
    }
    if (listingView) renderListing();
    else if (openItem) renderDetail();
    else renderList();

    var oldToasts = document.querySelectorAll(".toast");
    for (var i = 0; i < oldToasts.length; i++) oldToasts[i].remove();
    if (toastMsg) {
      var t = document.createElement("div");
      t.className = "toast";
      t.textContent = toastMsg;
      document.body.appendChild(t);
    }
  }

  // Opens a lead already present in the currently-fetched inbox (push
  // notification deep-link, or the bridge telling us amoCRM navigated to a
  // new lead). Known gap: a lead with NO pending suggestion yet (not seen by
  // any detector so far) finds nothing here and shows nothing — same as a
  // push deep-link always has. Generating one on demand needs a real
  // server-side "create a suggestion for this lead now" endpoint, which
  // doesn't exist yet; not building one under time pressure to avoid a
  // subtler bug (wrong kind, a duplicate suggestion).
  function openLeadById(leadId) {
    if (!leadId) return;
    var found = null, foundKind = null;
    ["live", "reach", "push"].forEach(function (k) {
      if (found) return;
      var match = (items[k] || []).find(function (i) { return String(i.lead_id) === String(leadId); });
      if (match) { found = match; foundKind = k; }
    });
    if (found) { activeTab = foundKind; openDetail(found, foundKind); }
  }

  function openDeepLinkedLead() {
    var params = new URLSearchParams(location.search);
    var targetLead = params.get("lead");
    if (!targetLead) return;
    history.replaceState(null, "", location.pathname);
    openLeadById(targetLead);
  }

  // ── Embedded-mode bridge: the extension's content script relays amoCRM
  // page context (which broker, which lead) into this iframe. Modeled on
  // openPropertyPicker's own postMessage handshake above — same
  // origin-and-source-checked pattern, just host and guest swapped: there
  // WE are the iframe talking to a nested one; here we're the iframe being
  // talked to by our parent.
  var BRIDGE_ORIGIN = "https://unicornproperty.amocrm.ru";
  window.addEventListener("message", function (e) {
    if (e.origin !== BRIDGE_ORIGIN) return;
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.source !== "copilot-bridge") return;
    if ((d.type === "init" || d.type === "broker") && d.broker) {
      var brokerWasEmpty = !brokerName;
      brokerName = d.broker;
      localStorage.setItem("copilot_broker", brokerName);
      if (brokerWasEmpty) {
        render();
        fetchStageOptions();
        // Embedded: the browser cannot be asked for permission from inside a
        // cross-origin iframe, but the SERVER knows whether this broker has a
        // device subscribed anywhere — so the panel can still tell them.
        fetchPushCoverage();
        if (reportView) fetchReport();
        fetchInbox().then(function () { if (d.leadId) openLeadById(d.leadId); });
      }
    }
    // Fetch fresh before opening — items may be a stale snapshot (up to 20s
    // old, or older still since the periodic refresh skips while a card is
    // open) from before this lead's suggestion/attachments were ready, and
    // openLeadById only ever searched whatever was already in memory.
    if (d.type === "lead" && d.leadId) fetchInbox().then(function () { openLeadById(d.leadId); });
    if (d.type === "broker-replied" && d.leadId) {
      if (openItem && String(openItem.lead_id) === String(d.leadId)) { openItem = null; render(); }
      fetchInbox();
    }
  });
  if (EMBEDDED) {
    try {
      window.parent.postMessage({ source: "copilot-embed", type: "ready" }, BRIDGE_ORIGIN);
    } catch (e) { /* non-fatal — bridge may retry, or this instance is standalone despite the frame check */ }
  }

  // The 8am report push deep-links straight to the tab it is about.
  if (_qs.get("view") === "report") reportView = true;
  // A half-written listing survives a reload, a phone lock, or amoCRM
  // navigating the panel away — the broker retyping the owner's message is
  // exactly the friction this screen exists to remove.
  liRestore();
  if (_qs.get("view") === "listing") listingView = true;

  render();
  fetchStageOptions();
  fetchPipelineOptions();
  if (brokerName) {
    // Enrolment and coverage are checked on EVERY load, not behind a button:
    // that is the whole difference between a feature that reached 2 brokers
    // and one that reaches everybody who opens the app.
    syncPushSubscription();
    fetchPushCoverage();
    if (reportView) fetchReport();
    fetchInbox().then(openDeepLinkedLead);
  }
  setInterval(function () { if (!openItem) fetchInbox(); }, 20000);
})();
</script>
</body>
</html>`;

router.get("/m", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  // Scoped to this route only — the extension's bridge embeds this exact
  // page in an iframe inside amoCRM, which is otherwise unrestricted (no
  // X-Frame-Options/CSP existed anywhere in this server before).
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self' https://unicornproperty.amocrm.ru");
  res.send(PAGE_HTML);
});

export default router;
