import { useState, useEffect, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import {
  RefreshCw, Home as HomeIcon, ChevronDown, Calendar,
  TrendingUp, TrendingDown, Minus, Star,
} from "lucide-react";
import { useLang, LangProvider, LangToggle } from "@/lib/i18n";

const SESSION_KEY = "copilot_dash_v1";

const STAGE_ORDER = [
  "New Lead", "In Progress",
  "1st Follow Up (Next Day)", "2nd Follow Up (3 Days After)",
  "Final Follow Up (1 Week After)", "Shanti 5th MSG (After 5 Days)",
  "Lead Assigned", "Taken to Work", "Contact Established",
  "Mailing", "Long-term Cycle", "Needs Assessed",
  "Options Sent", "Option Send",
  "Zoom Call Scheduled", "Viewing Scheduled",
  "Feedback / Handling Objections",
  "Reservation", "Negotiations", "Contract Signed", "Closed - Won",
];

const KEY_STAGES = new Set([
  "zoom call scheduled", "viewing scheduled", "contract signed", "closed - won",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

type DayEntry = {
  date: string; label: string;
  suggested: number; suggested_live: number; suggested_push: number;
  sent: number; sent_live: number; sent_push: number; outcomes: number;
};
type FunnelItem = {
  stage: string; count: number;
  previous: number; delta: number; hasPrevious: boolean;
  cameIn: number; wentOut: number;
};
type Progress = { forwardMoves: number; backwardMoves: number; netProgress: number; leadsAdvanced: number };
type Totals = {
  suggested: number; suggested_live: number; suggested_push: number;
  sent: number; sent_live: number; sent_push: number;
  outcomes: number; conversionRate: number;
  pushLeads: number; pushReactivated: number; pushReactivationRate: number;
};
type Analytics = {
  dailyActivity: DayEntry[];
  totals: Totals;
  funnel: FunnelItem[];
  totalMoved: number;
  progress: Progress;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad(n: number) { return String(n).padStart(2, "0"); }
function toInputDate(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function shift(d: Date, days: number) { const r = new Date(d); r.setDate(r.getDate() + days); return r; }

const DOW_RU = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const DOW_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayLabel(dateStr: string, lang: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const dow = lang === "ru" ? DOW_RU[d.getUTCDay()] : DOW_EN[d.getUTCDay()];
  if (lang === "ru") {
    const months = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
    return `${dow} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
  }
  return `${dow} ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`;
}

// ─── KPI Tiles ────────────────────────────────────────────────────────────────

function KpiTile({ label, value, color, sub }: { label: string; value: string | number; color: string; sub?: string }) {
  return (
    <div className="rounded-2xl border px-5 py-4 flex flex-col gap-1"
      style={{ background: "rgba(13,31,53,0.7)", borderColor: "rgba(77,184,255,0.1)" }}>
      <span className="text-[10px] font-bold text-white/30 uppercase tracking-wider">{label}</span>
      <span className="text-3xl font-bold" style={{ color }}>{value}</span>
      {sub && <span className="text-[10px] text-white/20">{sub}</span>}
    </div>
  );
}

// ─── Funnel ───────────────────────────────────────────────────────────────────

function DeltaBadge({ delta, hasPrevious, accumLabel }: { delta: number; hasPrevious: boolean; accumLabel: string }) {
  if (!hasPrevious) return <span className="text-[10px] text-white/15 italic">{accumLabel}</span>;
  if (delta === 0) return <span className="text-xs font-bold text-white/20">—</span>;
  const up = delta > 0;
  return (
    <span className="inline-flex items-center gap-0.5 text-xs font-bold px-1.5 py-0.5 rounded"
      style={{
        background: up ? "rgba(52,211,153,0.12)" : "rgba(248,113,113,0.12)",
        color: up ? "#34d399" : "#f87171",
      }}>
      {up ? "▲" : "▼"} {up ? "+" : ""}{delta}
    </span>
  );
}

function Funnel({ data }: { data: FunnelItem[] }) {
  const { t } = useLang();
  const byStage = new Map(data.map((d) => [d.stage.toLowerCase(), d]));
  const rows: FunnelItem[] = [];
  for (const s of STAGE_ORDER) {
    const item = byStage.get(s.toLowerCase());
    if (item && (item.count > 0 || item.previous > 0)) rows.push(item);
  }
  for (const item of data) {
    if (!STAGE_ORDER.some((s) => s.toLowerCase() === item.stage.toLowerCase()))
      if (item.count > 0 || item.previous > 0) rows.push(item);
  }
  const maxCount = Math.max(...rows.map((r) => r.count), ...rows.map((r) => r.previous), 1);
  const hasPrevious = rows.some((r) => r.hasPrevious);

  if (rows.length === 0) {
    return (
      <div className="py-10 text-center text-sm" style={{ color: "rgba(255,255,255,0.2)" }}>
        {t.funnel_empty}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 pb-2 mb-1 border-b text-[10px] font-bold uppercase tracking-wider"
        style={{ borderColor: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.2)" }}>
        <span style={{ width: "200px", flexShrink: 0 }}>{t.funnel_col_stage}</span>
        <span className="flex-1" />
        <span className="w-10 text-right shrink-0">{t.funnel_col_now}</span>
        <span className="w-14 text-center shrink-0">{t.funnel_col_delta}</span>
        <span className="w-10 text-right shrink-0" style={{ color: hasPrevious ? undefined : "rgba(255,255,255,0.1)" }}>
          {t.funnel_col_was}
        </span>
      </div>

      <div className="space-y-2">
        {rows.map((item) => {
          const isKey = KEY_STAGES.has(item.stage.toLowerCase());
          const idx = STAGE_ORDER.indexOf(item.stage);
          const color = isKey ? "#34d399"
            : idx <= 5  ? "#818cf8"
            : idx <= 11 ? "#22d3ee"
            : idx <= 16 ? "#fbbf24"
            : "#34d399";
          const pctCurrent  = Math.max(2, (item.count    / maxCount) * 100);
          const pctPrevious = Math.max(2, (item.previous / maxCount) * 100);
          return (
            <div key={item.stage}>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 shrink-0" style={{ width: "200px" }}>
                  {isKey && <Star className="w-2.5 h-2.5 shrink-0" style={{ color: "#34d399" }} />}
                  <span className="text-xs truncate"
                    style={{ color: isKey ? "#e2e8f0" : "rgba(255,255,255,0.5)" }}
                    title={item.stage}>{item.stage}</span>
                </div>
                <div className="flex-1 flex flex-col gap-0.5">
                  <div className="h-2 rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
                    <div className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${pctCurrent}%`, background: `${color}aa` }} />
                  </div>
                  {item.hasPrevious && (
                    <div className="h-1 rounded-full" style={{ background: "rgba(255,255,255,0.04)" }}>
                      <div className="h-full rounded-full"
                        style={{ width: `${pctPrevious}%`, background: "rgba(255,255,255,0.2)" }} />
                    </div>
                  )}
                </div>
                <span className="text-sm font-bold text-white w-10 text-right shrink-0">{item.count}</span>
                <div className="w-14 flex justify-center shrink-0">
                  <DeltaBadge delta={item.delta} hasPrevious={item.hasPrevious} accumLabel={t.funnel_accum} />
                </div>
                <span className="w-10 text-right shrink-0 text-xs"
                  style={{ color: item.hasPrevious ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.1)" }}>
                  {item.hasPrevious ? item.previous : "—"}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-4 pt-4 mt-2 border-t text-[10px]"
        style={{ borderColor: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.2)" }}>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-2 rounded-full inline-block" style={{ background: "rgba(129,140,248,0.7)" }} />
          {t.funnel_leg_current}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-1 rounded-full inline-block" style={{ background: "rgba(255,255,255,0.2)" }} />
          {t.funnel_leg_prev}
        </span>
        <span className="flex items-center gap-1.5 ml-auto">
          <Star className="w-2.5 h-2.5" style={{ color: "#34d399" }} />
          {t.funnel_leg_key}
        </span>
      </div>

      {!hasPrevious && (
        <p className="text-[10px] text-center mt-3 italic" style={{ color: "rgba(255,255,255,0.2)" }}>
          {t.funnel_note(7)}
        </p>
      )}
    </div>
  );
}

// ─── Funnel Movement ──────────────────────────────────────────────────────────

function FunnelMovement({ progress, totalSent }: { progress: Progress; totalSent: number }) {
  const { t } = useLang();
  const { forwardMoves, backwardMoves, netProgress, leadsAdvanced } = progress;
  const NetIcon = netProgress > 0 ? TrendingUp : netProgress < 0 ? TrendingDown : Minus;
  const netColor = netProgress > 0 ? "#34d399" : netProgress < 0 ? "#f87171" : "rgba(255,255,255,0.2)";

  return (
    <div className="rounded-2xl border px-5 py-4 h-full"
      style={{ background: "rgba(13,31,53,0.7)", borderColor: "rgba(77,184,255,0.1)" }}>
      <div className="flex items-center gap-2 mb-4">
        <NetIcon className="w-3.5 h-3.5" style={{ color: netColor }} />
        <span className="text-xs font-bold text-white/40 uppercase tracking-wider">{t.prog_title}</span>
      </div>

      {forwardMoves > 0 || backwardMoves > 0 ? (
        <div className="space-y-3">
          <div>
            <span className="text-3xl font-bold" style={{ color: netColor }}>
              {netProgress > 0 ? "+" : ""}{netProgress}
            </span>
            <span className="text-xs text-white/25 ml-2">{t.prog_net}</span>
          </div>

          <div className="space-y-2 text-xs">
            <div className="flex justify-between items-center">
              <span className="text-white/40">{t.prog_fwd}</span>
              <span className="font-bold text-sm" style={{ color: "#34d399" }}>+{forwardMoves}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-white/40">{t.prog_back}</span>
              <span className="font-bold text-sm" style={{ color: backwardMoves > 0 ? "#f87171" : "rgba(255,255,255,0.2)" }}>
                {backwardMoves > 0 ? `−${backwardMoves}` : "0"}
              </span>
            </div>
            <div className="flex justify-between items-center pt-2 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
              <span className="text-white/40">{t.prog_advanced}</span>
              <span className="font-bold text-sm" style={{ color: "#a78bfa" }}>{leadsAdvanced}</span>
            </div>
            {totalSent > 0 && forwardMoves > 0 && (
              <p className="text-[10px] text-white/20 pt-2 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                {t.prog_ratio(Math.round(totalSent / forwardMoves))}
              </p>
            )}
          </div>
        </div>
      ) : (
        <p className="text-xs text-white/20">{t.prog_none}</p>
      )}
    </div>
  );
}

// ─── Daily Actions Table ──────────────────────────────────────────────────────

type GroupBy = "day" | "week" | "month" | "year";

type GroupRow = { key: string; label: string; live: number; push: number; total: number };

function groupRows(data: DayEntry[], by: GroupBy, lang: string): GroupRow[] {
  const buckets = new Map<string, GroupRow>();
  for (const d of data) {
    const dt = new Date(d.date + "T12:00:00Z");
    let key: string;
    let label: string;

    if (by === "day") {
      key = d.date;
      label = dayLabel(d.date, lang);
    } else if (by === "week") {
      const dow = dt.getUTCDay();
      const diff = dow === 0 ? -6 : 1 - dow;
      const mon = new Date(dt);
      mon.setUTCDate(dt.getUTCDate() + diff);
      key = mon.toISOString().split("T")[0]!;
      const monLabel = mon.toLocaleDateString(lang === "ru" ? "ru-RU" : "en-GB",
        { day: "numeric", month: "short", timeZone: "UTC" });
      label = lang === "ru" ? `Нед. ${monLabel}` : `Wk ${monLabel}`;
    } else if (by === "month") {
      key = d.date.slice(0, 7);
      label = dt.toLocaleDateString(lang === "ru" ? "ru-RU" : "en-GB",
        { month: "long", year: "numeric", timeZone: "UTC" });
    } else {
      key = d.date.slice(0, 4);
      label = key;
    }

    const prev = buckets.get(key) ?? { key, label, live: 0, push: 0, total: 0 };
    buckets.set(key, {
      key, label,
      live:  prev.live  + d.sent_live,
      push:  prev.push  + d.sent_push,
      total: prev.total + d.sent,
    });
  }
  return [...buckets.values()].sort((a, b) => b.key.localeCompare(a.key));
}

function DailyActionsTable({ data }: { data: DayEntry[] }) {
  const { lang } = useLang();
  const [groupBy, setGroupBy] = useState<GroupBy>("day");

  const rows = useMemo(
    () => groupRows(data, groupBy, lang).filter((r) => r.live > 0 || r.push > 0),
    [data, groupBy, lang],
  );

  const totLive  = rows.reduce((s, r) => s + r.live,  0);
  const totPush  = rows.reduce((s, r) => s + r.push,  0);
  const totAll   = rows.reduce((s, r) => s + r.total, 0);

  const GROUP_OPTIONS: { value: GroupBy; labelRu: string; labelEn: string }[] = [
    { value: "day",   labelRu: "День",   labelEn: "Day"   },
    { value: "week",  labelRu: "Неделя", labelEn: "Week"  },
    { value: "month", labelRu: "Месяц",  labelEn: "Month" },
    { value: "year",  labelRu: "Год",    labelEn: "Year"  },
  ];

  const periodHeader: Record<GroupBy, { ru: string; en: string }> = {
    day:   { ru: "День",   en: "Day"   },
    week:  { ru: "Неделя", en: "Week"  },
    month: { ru: "Месяц",  en: "Month" },
    year:  { ru: "Год",    en: "Year"  },
  };

  const noData = lang === "ru" ? "Нет действий за выбранный период" : "No actions for selected period";

  return (
    <div className="rounded-2xl border overflow-hidden"
      style={{ background: "rgba(13,31,53,0.7)", borderColor: "rgba(77,184,255,0.1)" }}>

      {/* Header + group toggle */}
      <div className="px-5 py-3.5 border-b flex items-center gap-3"
        style={{ borderColor: "rgba(77,184,255,0.08)" }}>
        <span className="text-xs font-bold text-white/40 uppercase tracking-wider">
          {lang === "ru" ? "Экшены" : "Actions"}
        </span>
        <div className="ml-auto flex gap-1">
          {GROUP_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setGroupBy(opt.value)}
              className="px-2.5 py-1 rounded-md text-[10px] font-bold border transition-all"
              style={{
                background:   groupBy === opt.value ? "rgba(77,184,255,0.15)" : "transparent",
                borderColor:  groupBy === opt.value ? "rgba(77,184,255,0.35)" : "rgba(255,255,255,0.07)",
                color:        groupBy === opt.value ? "#4db8ff" : "rgba(255,255,255,0.25)",
              }}
            >
              {lang === "ru" ? opt.labelRu : opt.labelEn}
            </button>
          ))}
        </div>
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="border-b" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
            <th className="px-5 py-2.5 text-left text-[10px] font-bold text-white/25 uppercase tracking-wider">
              {lang === "ru" ? periodHeader[groupBy].ru : periodHeader[groupBy].en}
            </th>
            <th className="px-5 py-2.5 text-right text-[10px] font-bold uppercase tracking-wider" style={{ color: "#4db8ff66" }}>
              Live
            </th>
            <th className="px-5 py-2.5 text-right text-[10px] font-bold uppercase tracking-wider" style={{ color: "#f59e0b66" }}>
              Push
            </th>
            <th className="px-5 py-2.5 text-right text-[10px] font-bold text-white/20 uppercase tracking-wider">
              {lang === "ru" ? "Итого" : "Total"}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-5 py-8 text-center text-white/20">{noData}</td>
            </tr>
          ) : rows.map((r, i) => (
            <tr key={r.key}
              className="border-b hover:bg-white/[0.02]"
              style={{
                borderColor: "rgba(255,255,255,0.04)",
                background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
              }}>
              <td className="px-5 py-3 text-white/55 font-medium whitespace-nowrap">{r.label}</td>
              <td className="px-5 py-3 text-right font-bold"
                style={{ color: r.live > 0 ? "#4db8ff" : "rgba(255,255,255,0.12)" }}>
                {r.live > 0 ? r.live : "—"}
              </td>
              <td className="px-5 py-3 text-right font-bold"
                style={{ color: r.push > 0 ? "#f59e0b" : "rgba(255,255,255,0.12)" }}>
                {r.push > 0 ? r.push : "—"}
              </td>
              <td className="px-5 py-3 text-right font-bold text-white">
                {r.total > 0 ? r.total : "—"}
              </td>
            </tr>
          ))}
        </tbody>
        {rows.length > 1 && (
          <tfoot>
            <tr className="border-t" style={{ borderColor: "rgba(77,184,255,0.12)", background: "rgba(77,184,255,0.04)" }}>
              <td className="px-5 py-3 text-white/40 font-bold text-[10px] uppercase">
                {lang === "ru" ? "Итого" : "Total"}
              </td>
              <td className="px-5 py-3 text-right font-bold" style={{ color: "#4db8ff" }}>{totLive || "—"}</td>
              <td className="px-5 py-3 text-right font-bold" style={{ color: "#f59e0b" }}>{totPush || "—"}</td>
              <td className="px-5 py-3 text-right font-bold text-white">{totAll || "—"}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const PRESETS_EN = [
  { label: "Today", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
];
const PRESETS_RU = [
  { label: "Сегодня", days: 1 },
  { label: "7 дней",  days: 7 },
  { label: "30 дней", days: 30 },
];

const EMPTY_TOTALS: Totals = {
  suggested: 0, suggested_live: 0, suggested_push: 0,
  sent: 0, sent_live: 0, sent_push: 0,
  outcomes: 0, conversionRate: 0,
  pushLeads: 0, pushReactivated: 0, pushReactivationRate: 0,
};
const EMPTY_PROGRESS: Progress = { forwardMoves: 0, backwardMoves: 0, netProgress: 0, leadsAdvanced: 0 };

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { t, lang } = useLang();
  const authed = sessionStorage.getItem(SESSION_KEY) === "1";

  const PRESETS = lang === "ru" ? PRESETS_RU : PRESETS_EN;

  const [broker, setBroker] = useState("Robert");
  const [brokers, setBrokers] = useState<string[]>(["Robert"]);
  const [preset, setPreset] = useState<number | null>(7);
  const [customFrom, setCustomFrom] = useState(toInputDate(shift(new Date(), -6)));
  const [customTo,   setCustomTo]   = useState(toInputDate(new Date()));
  const [showCustom, setShowCustom] = useState(false);

  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  useEffect(() => {
    if (!authed) { setLocation("/login"); return; }
    fetch("/api/analytics/brokers")
      .then((r) => r.json())
      .then((d: any) => { if (d.brokers?.length) setBrokers(d.brokers); })
      .catch(() => {});
  }, [authed, setLocation]);

  const getRange = useCallback(() => {
    if (preset !== null) {
      const to = new Date();
      return { from: toInputDate(shift(to, -(preset - 1))), to: toInputDate(to), days: preset };
    }
    const days = Math.max(1, Math.round(
      (new Date(customTo).getTime() - new Date(customFrom).getTime()) / 86400000
    ) + 1);
    return { from: customFrom, to: customTo, days };
  }, [preset, customFrom, customTo]);

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { from, to } = getRange();
      const res = await fetch(`/api/analytics?${new URLSearchParams({ from, to, broker })}`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      setData(await res.json());
      setLastUpdate(new Date());
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [broker, getRange]);

  useEffect(() => { if (authed) fetchData(); }, [authed, fetchData]);

  if (!authed) return null;

  const { days } = getRange();
  const periodLabel = preset === 1 ? t.dash_sub_today
    : preset !== null ? t.dash_sub_days(preset)
    : t.dash_sub_custom(days);

  const totalLeads = data?.funnel.reduce((s, f) => s + f.count, 0) ?? 0;
  const totalMoved = data?.totalMoved ?? 0;
  const tl = data?.totals ?? EMPTY_TOTALS;
  const p  = data?.progress ?? EMPTY_PROGRESS;

  return (
    <div className="min-h-screen text-white" style={{ background: "linear-gradient(135deg,#060f1e 0%,#0d1f35 100%)" }}>

      {/* ── Header ── */}
      <div className="sticky top-0 z-40 border-b px-5 py-3 flex flex-wrap items-center gap-2"
        style={{ background: "rgba(6,15,30,0.93)", borderColor: "rgba(77,184,255,0.1)", backdropFilter: "blur(12px)" }}>
        <a href="/" className="text-white/25 hover:text-white/60 transition-colors mr-1">
          <HomeIcon className="w-4 h-4" />
        </a>
        <a href="/tasks"
          className="text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors"
          style={{ color: "rgba(96,165,250,0.8)", borderColor: "rgba(96,165,250,0.2)", background: "rgba(96,165,250,0.06)" }}
        >
          Tasks
        </a>
        <a href="/settings"
          className="text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors"
          style={{ color: "rgba(96,165,250,0.8)", borderColor: "rgba(96,165,250,0.2)", background: "rgba(96,165,250,0.06)" }}
        >
          Settings
        </a>
        <div className="mr-2">
          <h1 className="text-sm font-bold text-white">{t.dash_title}</h1>
          <p className="text-[10px] text-white/25">FollowUp AI · Unicorn Property · {periodLabel}</p>
        </div>

        {/* Broker */}
        <div className="relative">
          <select value={broker} onChange={(e) => setBroker(e.target.value)}
            className="appearance-none pl-3 pr-7 py-1.5 rounded-lg text-xs font-semibold text-white border cursor-pointer outline-none"
            style={{ background: "rgba(77,184,255,0.08)", borderColor: "rgba(77,184,255,0.2)" }}>
            {brokers.map((b) => <option key={b} value={b} style={{ background: "#0d1f35" }}>{b}</option>)}
          </select>
          <ChevronDown className="w-3 h-3 text-white/40 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>

        {/* Period presets */}
        <div className="flex items-center gap-1">
          {PRESETS.map((pr) => (
            <button key={pr.days} onClick={() => { setPreset(pr.days); setShowCustom(false); }}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all"
              style={{
                background: preset === pr.days ? "rgba(77,184,255,0.15)" : "rgba(255,255,255,0.03)",
                borderColor: preset === pr.days ? "rgba(77,184,255,0.35)" : "rgba(255,255,255,0.07)",
                color: preset === pr.days ? "#4db8ff" : "#64748b",
              }}>{pr.label}</button>
          ))}
          <button onClick={() => { setPreset(null); setShowCustom((v) => !v); }}
            className="px-2.5 py-1.5 rounded-lg border transition-all"
            style={{
              background: preset === null ? "rgba(77,184,255,0.15)" : "rgba(255,255,255,0.03)",
              borderColor: preset === null ? "rgba(77,184,255,0.35)" : "rgba(255,255,255,0.07)",
              color: preset === null ? "#4db8ff" : "#64748b",
            }}>
            <Calendar className="w-3.5 h-3.5" />
          </button>
        </div>

        {showCustom && preset === null && (
          <div className="flex items-center gap-2">
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
              className="px-2 py-1 rounded-lg text-xs border text-white outline-none"
              style={{ background: "rgba(13,31,53,0.8)", borderColor: "rgba(77,184,255,0.2)" }} />
            <span className="text-white/25 text-xs">—</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
              className="px-2 py-1 rounded-lg text-xs border text-white outline-none"
              style={{ background: "rgba(13,31,53,0.8)", borderColor: "rgba(77,184,255,0.2)" }} />
            <button onClick={fetchData} className="px-3 py-1 rounded-lg text-xs font-semibold text-white"
              style={{ background: "linear-gradient(135deg,#2563eb,#3b9eff)" }}>OK</button>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {lastUpdate && (
            <span className="text-[10px] text-white/20 hidden sm:block">
              {lastUpdate.toLocaleTimeString(lang === "ru" ? "ru-RU" : "en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <LangToggle />
          <button onClick={fetchData} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-40"
            style={{ background: "rgba(77,184,255,0.06)", borderColor: "rgba(77,184,255,0.15)", color: "#4db8ff" }}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-5 py-6 space-y-5">
        {error && (
          <div className="rounded-xl px-5 py-4 text-sm border border-red-500/20 bg-red-500/8 text-red-400">{error}</div>
        )}

        {/* ── KPI row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiTile
            label={lang === "ru" ? "Лидов в воронке" : "Leads in funnel"}
            value={totalLeads}
            color="white"
            sub={lang === "ru" ? "сейчас активных" : "currently active"}
          />
          <KpiTile
            label={lang === "ru" ? "Сдвигов по этапам" : "Stage moves"}
            value={totalMoved > 0 ? `+${totalMoved}` : totalMoved}
            color={totalMoved > 0 ? "#34d399" : "rgba(255,255,255,0.3)"}
            sub={lang === "ru" ? "за период" : "in period"}
          />
          <KpiTile
            label="Live"
            value={tl.sent_live}
            color="#4db8ff"
            sub={lang === "ru" ? "отправлено" : "sent"}
          />
          <KpiTile
            label="Push"
            value={tl.sent_push}
            color="#f59e0b"
            sub={lang === "ru" ? "отправлено" : "sent"}
          />
        </div>

        {/* ── Funnel + Movement ── */}
        <div className="grid gap-5" style={{ gridTemplateColumns: "1fr 260px" }}>

          {/* Funnel */}
          <div className="rounded-2xl border overflow-hidden"
            style={{ background: "rgba(13,31,53,0.7)", borderColor: "rgba(77,184,255,0.1)" }}>
            <div className="px-6 py-4 border-b flex items-center justify-between"
              style={{ borderColor: "rgba(77,184,255,0.08)", background: "rgba(6,15,30,0.5)" }}>
              <h2 className="text-xs font-bold text-white/50 uppercase tracking-wider">{t.funnel_title}</h2>
              <span className="text-xs text-white/20">{t.funnel_leads(totalLeads)}</span>
            </div>
            <div className="px-6 py-5">
              <Funnel data={data?.funnel ?? []} />
            </div>
          </div>

          {/* Funnel movement */}
          <FunnelMovement progress={p} totalSent={tl.sent} />
        </div>

        {/* ── Actions by day ── */}
        <DailyActionsTable data={data?.dailyActivity ?? []} />

        <p className="text-center text-[10px] text-white/10 pb-4">{t.dash_note}</p>
      </div>
    </div>
  );
}
