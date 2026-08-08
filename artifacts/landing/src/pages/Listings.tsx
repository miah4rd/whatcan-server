import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import {
  Home as HomeIcon, RefreshCw, Check, X, Copy, ChevronDown, ChevronUp, ExternalLink,
} from "lucide-react";

const SESSION_KEY = "copilot_dash_v1";

type Submission = {
  id: string;
  title: string;
  area: string;
  type: string | null;
  listingType: string;
  bedrooms: number | null;
  bathrooms: number | null;
  landSize: number | null;
  buildSize: number | null;
  priceUsd: number | null;
  leaseholdPriceUsd: number | null;
  monthlyPriceUsd: number | null;
  yearlyPriceUsd: number | null;
  monthlyPriceIdr: number | null;
  yearlyPriceIdr: number | null;
  ownership: string | null;
  leaseYears: number | null;
  purpose: string | null;
  zone: string | null;
  description: string | null;
  features: string[] | null;
  images: string[] | null;
  videoUrl: string | null;
  submitterName: string | null;
  submitterContact: string | null;
  status: "pending" | "approved" | "rejected";
  rejectionReason: string | null;
  finalPropertyId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

const TABS: { value: string; label: string }[] = [
  { value: "pending", label: "На проверке" },
  { value: "approved", label: "Опубликованы" },
  { value: "rejected", label: "Отклонены" },
];

function money(n: number | null, currency: string) {
  if (!n) return null;
  return `${n.toLocaleString("en-US")} ${currency}`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function ReviewCard({ s, onDecided }: { s: Submission; onDecided: () => void }) {
  const [open, setOpen] = useState(false);
  const [finalId, setFinalId] = useState(s.finalPropertyId ?? "");
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const approve = useCallback(async () => {
    if (!finalId.trim()) { setErr("Укажите код объекта (например SAI-030)"); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/public/listing-submissions/${s.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ finalPropertyId: finalId.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Ошибка ${res.status}`);
      }
      onDecided();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, [finalId, s.id, onDecided]);

  const reject = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/public/listing-submissions/${s.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: rejectReason || undefined }),
      });
      if (!res.ok) throw new Error(`Ошибка ${res.status}`);
      onDecided();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, [rejectReason, s.id, onDecided]);

  const priceLine =
    s.listingType === "rent"
      ? money(s.monthlyPriceIdr, "IDR/mo") ?? money(s.yearlyPriceIdr, "IDR/yr") ?? "—"
      : money(s.priceUsd, "USD") ?? money(s.leaseholdPriceUsd, "USD (leasehold)") ?? "—";

  return (
    <div className="rounded-2xl border overflow-hidden" style={{ borderColor: "rgba(77,184,255,0.12)", background: "rgba(13,31,53,0.6)" }}>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 px-4 py-3 text-left">
        {s.images?.[0] ? (
          <img src={s.images[0]} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0" />
        ) : (
          <div className="w-14 h-14 rounded-lg shrink-0" style={{ background: "rgba(255,255,255,0.05)" }} />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white truncate">{s.title}</div>
          <div className="text-xs text-white/40">
            {s.area} · {s.listingType === "rent" ? "аренда" : "продажа"} · {s.bedrooms ?? "?"}BR · {priceLine}
          </div>
        </div>
        <div className="text-[10px] text-white/25 shrink-0 hidden sm:block">{fmtDate(s.createdAt)}</div>
        {open ? <ChevronUp className="w-4 h-4 text-white/30 shrink-0" /> : <ChevronDown className="w-4 h-4 text-white/30 shrink-0" />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
          {s.images && s.images.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pt-4">
              {s.images.map((src, i) => (
                <img key={i} src={src} alt="" className="w-24 h-24 rounded-lg object-cover shrink-0" />
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-xs pt-1">
            <div><span className="text-white/30">Тип: </span><span className="text-white/70">{s.type ?? "—"}</span></div>
            <div><span className="text-white/30">Спальни/Ванные: </span><span className="text-white/70">{s.bedrooms ?? "?"}/{s.bathrooms ?? "?"}</span></div>
            <div><span className="text-white/30">Участок/Застройка: </span><span className="text-white/70">{s.landSize ?? "?"}/{s.buildSize ?? "?"} м²</span></div>
            <div><span className="text-white/30">Владение: </span><span className="text-white/70">{s.ownership ?? "—"}{s.leaseYears ? ` (${s.leaseYears} лет)` : ""}</span></div>
            <div><span className="text-white/30">Цель: </span><span className="text-white/70">{s.purpose ?? "—"}</span></div>
            <div><span className="text-white/30">Зона: </span><span className="text-white/70">{s.zone ?? "—"}</span></div>
          </div>

          {s.features && s.features.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {s.features.map((f, i) => (
                <span key={i} className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: "rgba(77,184,255,0.1)", color: "#7dd3fc" }}>{f}</span>
              ))}
            </div>
          )}

          {s.description && <p className="text-xs text-white/50 leading-relaxed">{s.description}</p>}

          {s.videoUrl && (
            <a href={s.videoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-[#4db8ff]/70 hover:text-[#4db8ff]">
              <ExternalLink className="w-3 h-3" /> Видео
            </a>
          )}

          {(s.submitterName || s.submitterContact) && (
            <p className="text-[10px] text-white/25">Отправил(а): {s.submitterName ?? "—"} {s.submitterContact ? `· ${s.submitterContact}` : ""}</p>
          )}

          {err && <p className="text-xs text-red-400">{err}</p>}

          {s.status === "pending" ? (
            <div className="flex flex-col sm:flex-row gap-2 pt-1">
              <input value={finalId} onChange={(e) => setFinalId(e.target.value)} placeholder="Код объекта, напр. SAI-030"
                className="flex-1 px-3 py-2 rounded-lg text-xs text-white outline-none focus:ring-1 focus:ring-[#4db8ff]/50"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(77,184,255,0.2)" }} />
              <button onClick={approve} disabled={busy}
                className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
                style={{ background: "linear-gradient(135deg,#16a34a,#22c55e)" }}>
                <Check className="w-3.5 h-3.5" /> Опубликовать
              </button>
              <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Причина отказа (необязательно)"
                className="flex-1 px-3 py-2 rounded-lg text-xs text-white outline-none focus:ring-1 focus:ring-red-400/50"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(248,113,113,0.2)" }} />
              <button onClick={reject} disabled={busy}
                className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-red-300 disabled:opacity-40"
                style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.25)" }}>
                <X className="w-3.5 h-3.5" /> Отклонить
              </button>
            </div>
          ) : s.status === "approved" ? (
            <p className="text-xs" style={{ color: "#34d399" }}>
              ✓ Опубликован как <span className="font-mono">{s.finalPropertyId}</span>
              {s.reviewedAt ? ` · ${fmtDate(s.reviewedAt)}` : ""}
            </p>
          ) : (
            <p className="text-xs text-red-400">
              ✗ Отклонён{s.rejectionReason ? `: ${s.rejectionReason}` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Listings() {
  const [, setLocation] = useLocation();
  const authed = sessionStorage.getItem(SESSION_KEY) === "1";

  const [tab, setTab] = useState("pending");
  const [items, setItems] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/public/listing-submissions?status=${tab}`);
      const d = await res.json();
      setItems(d.submissions ?? []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    if (!authed) { setLocation("/login"); return; }
    load();
  }, [authed, setLocation, load]);

  if (!authed) return null;

  const submitUrl = `${window.location.origin}/listings/new`;

  return (
    <div className="min-h-screen text-white" style={{ background: "linear-gradient(135deg,#060f1e 0%,#0d1f35 100%)" }}>
      <div className="sticky top-0 z-40 border-b px-5 py-3 flex flex-wrap items-center gap-2"
        style={{ background: "rgba(6,15,30,0.93)", borderColor: "rgba(77,184,255,0.1)", backdropFilter: "blur(12px)" }}>
        <a href="/" className="text-white/25 hover:text-white/60 transition-colors mr-1"><HomeIcon className="w-4 h-4" /></a>
        <span className="text-white/15 text-sm">/</span>
        <a href="/dashboard" className="text-white/40 hover:text-white/70 text-sm transition-colors">Dashboard</a>
        <span className="text-white/15 text-sm">/</span>
        <span className="text-white/70 text-sm font-medium">Listings</span>

        <button onClick={load} disabled={loading}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-40"
          style={{ background: "rgba(77,184,255,0.06)", borderColor: "rgba(77,184,255,0.15)", color: "#4db8ff" }}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
        <div className="rounded-2xl border p-4 flex items-center gap-3" style={{ borderColor: "rgba(77,184,255,0.15)", background: "rgba(77,184,255,0.05)" }}>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold text-white/40 uppercase tracking-wider mb-1">Ссылка для загрузки объекта</div>
            <div className="text-sm text-[#7dd3fc] font-mono truncate">{submitUrl}</div>
          </div>
          <button
            onClick={() => { navigator.clipboard.writeText(submitUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white shrink-0"
            style={{ background: copied ? "rgba(34,197,94,0.3)" : "linear-gradient(135deg,#2563eb,#3b9eff)" }}>
            <Copy className="w-3.5 h-3.5" /> {copied ? "Скопировано" : "Копировать"}
          </button>
        </div>

        <div className="flex gap-1">
          {TABS.map((t) => (
            <button key={t.value} onClick={() => setTab(t.value)}
              className="px-3.5 py-1.5 rounded-lg text-xs font-semibold border transition-all"
              style={{
                background: tab === t.value ? "rgba(77,184,255,0.15)" : "rgba(255,255,255,0.03)",
                borderColor: tab === t.value ? "rgba(77,184,255,0.35)" : "rgba(255,255,255,0.07)",
                color: tab === t.value ? "#4db8ff" : "#64748b",
              }}>{t.label}</button>
          ))}
        </div>

        <div className="space-y-3">
          {loading ? (
            <div className="text-center py-16 text-white/30 text-sm">Загрузка...</div>
          ) : items.length === 0 ? (
            <div className="text-center py-16 text-white/20 text-sm">Пусто</div>
          ) : (
            items.map((s) => <ReviewCard key={s.id} s={s} onDecided={load} />)
          )}
        </div>
      </div>
    </div>
  );
}
