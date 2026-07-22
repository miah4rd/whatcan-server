import { Router } from "express";

const router = Router();

const THEME = {
  version: 9,
  css: `
    :host, * { box-sizing: border-box; }
    .wrap { font-family: Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; color: #e6e8ee; }
    .panel { width: 420px; max-width: calc(100vw - 32px); max-height: calc(100vh - 60px); display:flex; flex-direction:column; background: #273444; border: 1px solid #3a4a5e; border-radius: 8px; box-shadow: 0 18px 48px rgba(0,0,0,.55); overflow: hidden; animation: in .25s ease-out; }
    .panel > .hd, .panel > .reason, .panel > .actions { flex: 0 0 auto; }
    .panel > .body { flex: 1 1 auto; overflow-y: auto; min-height: 0; scrollbar-width: thin; scrollbar-color: #3a4a5e transparent; }
    @keyframes in { from { transform: translateY(8px); opacity: 0 } to { transform: none; opacity: 1 } }
    .hd { padding: 12px 14px; border-bottom: 1px solid #3a4a5e; background: #2c3e50; }
    .hdtop { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .badge { display:flex; align-items:center; gap: 9px; min-width: 0; flex:1; }
    .spark { width:28px; height:28px; border-radius:6px; background:#2196f3; display:grid; place-items:center; color:#fff; font-weight:900; font-size:15px; flex:none; }
    .who { font-size: 12.5px; font-weight: 800; color: #ffffff; line-height: 1.2; text-transform: uppercase; letter-spacing: .12em; }
    .sub { font-size: 13px; color: #8a96a8; margin-top: 4px; white-space: nowrap; overflow:hidden; text-overflow:ellipsis; max-width:280px; }
    .icons { display:flex; gap:2px; }
    .ib { width:28px; height:28px; border-radius:4px; background:transparent; border:0; color:#8a96a8; cursor:pointer; display:grid; place-items:center; font-size:16px; }
    .ib:hover { background:rgba(255,255,255,.08); color:#fff; }
    .reason { padding: 12px 14px; background: rgba(33,150,243,.08); border-bottom: 1px solid #3a4a5e; border-left: 3px solid #2196f3; display:flex; gap:9px; align-items:flex-start; }
    .reason .icon { color:#64b5f6; font-size:17px; flex:none; margin-top:1px; }
    .reason .txt { font-size: 14px; line-height: 1.55; color:#e6e8ee; font-weight:500; }
    .reason .lbl { display:block; font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color:#64b5f6; margin-bottom: 6px; }
    .body { padding: 12px 14px 10px; background:#273444; }
    .label { font-size: 11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:#8a96a8; margin-bottom:7px; }
    .msg { font-size: 15px; line-height: 1.6; color:#e6e8ee; white-space: pre-wrap; min-height: 80px; }
    .skel { display:flex; flex-direction:column; gap:7px; padding: 4px 0 8px; }
    .skel div { height:10px; background:rgba(255,255,255,.07); border-radius:4px; animation: p 1.2s ease-in-out infinite; }
    @keyframes p { 0%,100% {opacity:.5} 50% {opacity:1} }
    .err { color: #fca5a5; font-size: 13px; padding: 6px 0; }
    .ta { width:100%; background:#1d2a3a; color:#e6e8ee; border:1px solid #2196f3; border-radius:6px; padding:10px 12px; font-size:14.5px; font-family:inherit; resize:vertical; min-height:96px; }
    .actions { padding: 10px 12px; border-top: 1px solid #3a4a5e; background: #2c3e50; display:grid; grid-template-columns:1fr 1fr 1fr; gap:7px; }
    .primary { height:40px; border:0; border-radius:4px; background:#2196f3; color:#fff; font-weight:700; font-size:13.5px; cursor:pointer; text-transform:uppercase; letter-spacing:.06em; }
    .primary:hover:not(:disabled) { background:#1e88e5; }
    .primary:disabled { opacity:.4; cursor:default; }
    .secondary { height:40px; border-radius:4px; border:1px solid #3a4a5e; background:transparent; color:#cfd5e3; cursor:pointer; font-size:13.5px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; }
    .secondary:hover:not(:disabled) { background:rgba(255,255,255,.08); color:#fff; }
    .bubble { width:52px; height:52px; border-radius:50%; background:#2196f3; color:#fff; display:grid; place-items:center; box-shadow: 0 10px 30px rgba(33,150,243,.4); cursor:pointer; border:0; font-weight:900; font-size:22px; position: relative; }
    .tabs { display:flex; gap:4px; padding: 10px 12px; background:#273444; border-bottom:1px solid #3a4a5e; flex:0 0 auto; }
    .tabwrap { display:flex; gap:4px; padding:4px; border-radius:999px; background:rgba(33,150,243,.06); border:1px solid rgba(33,150,243,.12); width:100%; }
    .tab { flex:1; background:transparent; border:0; color:#8a96a8; cursor:pointer; padding:7px 12px; font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; display:flex; align-items:center; justify-content:center; gap:7px; border-radius:999px; }
    .tab:hover { color:#cfd5e3; }
    .tab.on { color:#fff; background:linear-gradient(135deg,#2196f3,#22d3ee); box-shadow:0 6px 18px -6px rgba(33,150,243,.7); }
    .list { padding: 8px 10px; display:flex; flex-direction:column; gap:8px; }
    .li { padding:11px 13px; background:#1d2a3a; border:1px solid #3a4a5e; border-radius:8px; cursor:pointer; }
    .li .prv { font-size:13px; color:#e6e8ee; line-height:1.5; }
    .empty { padding: 16px; text-align:center; font-size:12px; color:#8a96a8; }
    .rate { display:flex; gap:6px; margin-top:8px; align-items:center; font-size:11px; color:#8a96a8; }
    .rate .rb { height:26px; padding:0 9px; border-radius:4px; border:1px solid #3a4a5e; background:transparent; color:#cfd5e3; cursor:pointer; font-size:13px; }
    .rate .rb.on { background:#2196f3; border-color:#2196f3; color:#fff; }
  `,
  labels: {
    headerTitle: "Follow-up nudge",
    reasonLabel: "Why this follow-up now",
    suggestedLabel: "Suggested message",
    editLabel: "Edit message",
    approveBtn: "✓ Approve",
    skipBtn: "✕ Skip",
    editBtn: "✎ Edit",
    saveBtn: "✓ Save",
    cancelBtn: "Cancel",
    aiPlaceholder: "Tell AI what to change…",
    aiRewriteBtn: "AI rewrite",
    editHint: "Edit manually or type an instruction.",
    sleepingTitle: "Sleeping",
    sleepingBody: "Copilot only wakes up when a lead needs follow-up.",
    nextStepLabel: "Next step:",
    selectOption: "— select —",
    taskLabel: "Task:",
    taskTextPlaceholder: "Task text…",
    alreadyRepliedBtn: "✓ Already replied",
  },
};

router.options("/theme", (_req, res) => res.sendStatus(204));

router.get("/theme", (_req, res) => {
  res.set("Cache-Control", "public, max-age=30");
  res.json(THEME);
});

export default router;
