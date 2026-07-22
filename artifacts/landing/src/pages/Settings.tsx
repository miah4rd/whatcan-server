import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Save, RefreshCw, Home as HomeIcon, Plus, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { LangToggle } from "@/lib/i18n";

const SESSION_KEY = "copilot_dash_v1";

type FollowupStep = { delayMs: number; message?: string };
type BrokerPicksSegment = { label: string; picks: string };
type QualificationStep = { label: string; message: string };

type Settings = {
  followupSteps: FollowupStep[];
  brokerPicks: BrokerPicksSegment[];
  qualificationSteps: QualificationStep[];
};

function msToHours(ms: number) { return Math.round(ms / (1000 * 60 * 60)); }
function msToDisplay(ms: number) {
  const h = ms / (1000 * 60 * 60);
  if (h >= 24) return `${Math.round(h / 24)} д.`;
  return `${Math.round(h)} ч.`;
}
function hoursToMs(h: number) { return h * 60 * 60 * 1000; }

const TOUCH_LABELS = ["Touch 1 — 1st Follow Up", "Touch 2 — 2nd Follow Up", "Touch 3 — Final Follow Up"];

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border" style={{ borderColor: "rgba(77,184,255,0.12)", background: "rgba(13,31,53,0.6)" }}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-6 py-4 text-left"
      >
        <span className="text-sm font-semibold text-white/80 uppercase tracking-widest">{title}</span>
        {open ? <ChevronUp className="w-4 h-4 text-white/30" /> : <ChevronDown className="w-4 h-4 text-white/30" />}
      </button>
      {open && <div className="px-6 pb-6 space-y-4">{children}</div>}
    </div>
  );
}

function DelayInput({ label, value, onChange }: { label: string; value: number; onChange: (ms: number) => void }) {
  const [hours, setHours] = useState(msToHours(value));

  useEffect(() => { setHours(msToHours(value)); }, [value]);

  const handleChange = (v: string) => {
    const n = parseInt(v, 10);
    if (!isNaN(n) && n > 0) { setHours(n); onChange(hoursToMs(n)); }
  };

  return (
    <div className="flex items-center gap-4">
      <span className="text-sm text-white/60 w-48 shrink-0">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          value={hours}
          onChange={(e) => handleChange(e.target.value)}
          className="w-20 px-3 py-1.5 rounded-lg text-sm text-white text-center outline-none focus:ring-1 focus:ring-[#4db8ff]/50"
          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(77,184,255,0.2)" }}
        />
        <span className="text-xs text-white/40">ч. ({msToDisplay(hoursToMs(hours))})</span>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [, setLocation] = useLocation();
  const authed = sessionStorage.getItem(SESSION_KEY) === "1";

  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authed) { setLocation("/login"); return; }
    fetch("/api/public/settings")
      .then((r) => r.json())
      .then((d: Settings) => setSettings(d))
      .catch(() => setError("Не удалось загрузить настройки"))
      .finally(() => setLoading(false));
  }, [authed, setLocation]);

  const save = useCallback(async () => {
    if (!settings) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const res = await fetch("/api/public/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          followupSteps: settings.followupSteps,
          brokerPicks: settings.brokerPicks,
          qualificationSteps: settings.qualificationSteps,
        }),
      });
      if (!res.ok) throw new Error(`Ошибка ${res.status}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [settings]);

  if (!authed) return null;

  return (
    <div className="min-h-screen text-white" style={{ background: "linear-gradient(135deg,#060f1e 0%,#0d1f35 100%)" }}>

      {/* Header */}
      <div className="sticky top-0 z-40 border-b px-5 py-3 flex flex-wrap items-center gap-2"
        style={{ background: "rgba(6,15,30,0.93)", borderColor: "rgba(77,184,255,0.1)", backdropFilter: "blur(12px)" }}>
        <a href="/" className="text-white/25 hover:text-white/60 transition-colors mr-1">
          <HomeIcon className="w-4 h-4" />
        </a>
        <span className="text-white/15 text-sm">/</span>
        <a href="/dashboard" className="text-white/40 hover:text-white/70 text-sm transition-colors">Dashboard</a>
        <span className="text-white/15 text-sm">/</span>
        <span className="text-white/70 text-sm font-medium">Settings</span>

        <div className="ml-auto flex items-center gap-3">
          <LangToggle />
          <button
            onClick={save}
            disabled={saving || !settings}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-semibold text-white disabled:opacity-40 transition-all"
            style={{ background: saved ? "rgba(34,197,94,0.3)" : "linear-gradient(135deg,#2563eb,#3b9eff)", border: "none" }}
          >
            {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {saved ? "Сохранено ✓" : saving ? "Сохраняю..." : "Сохранить"}
          </button>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-5 py-8 space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">Настройки плагина</h1>
          <p className="text-sm text-white/40">Задержки между follow-up, подсказки для брокера и скрипты квалификации.</p>
        </div>

        {error && (
          <div className="rounded-lg px-4 py-3 text-sm text-red-300" style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.25)" }}>
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-center py-16 text-white/30 text-sm">Загрузка...</div>
        ) : !settings ? null : (
          <>
            {/* ── Follow-up delays ── */}
            <Section title="Задержки между касаниями">
              <p className="text-xs text-white/35 mb-4">
                Сколько времени ждать после предыдущего сообщения брокера перед тем, как показать следующий follow-up.
              </p>
              {settings.followupSteps.map((step, i) => (
                <DelayInput
                  key={i}
                  label={TOUCH_LABELS[i] ?? `Touch ${i + 1}`}
                  value={step.delayMs}
                  onChange={(ms) => {
                    const steps = [...settings.followupSteps];
                    steps[i] = { ...steps[i], delayMs: ms };
                    setSettings({ ...settings, followupSteps: steps });
                  }}
                />
              ))}
            </Section>

            {/* ── Broker picks ── */}
            <Section title="Подборки объектов по брокеру">
              <p className="text-xs text-white/35 mb-4">
                Список объектов по сегментам — бот вставляет их в рекомендации когда знает бюджет/цель клиента.
                Формат: одна строка = один объект, например <span className="font-mono text-white/50">UP-1001: Best ROI in Pererenan</span>
              </p>
              {settings.brokerPicks.map((seg, i) => (
                <div key={i} className="space-y-1.5">
                  <input
                    value={seg.label}
                    onChange={(e) => {
                      const picks = [...settings.brokerPicks];
                      picks[i] = { ...picks[i], label: e.target.value };
                      setSettings({ ...settings, brokerPicks: picks });
                    }}
                    placeholder="Название сегмента"
                    className="w-full px-3 py-1.5 rounded-lg text-sm text-white outline-none focus:ring-1 focus:ring-[#4db8ff]/50"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(77,184,255,0.15)" }}
                  />
                  <textarea
                    value={seg.picks}
                    onChange={(e) => {
                      const picks = [...settings.brokerPicks];
                      picks[i] = { ...picks[i], picks: e.target.value };
                      setSettings({ ...settings, brokerPicks: picks });
                    }}
                    rows={3}
                    placeholder="UP-1001: Best ROI in Pererenan&#10;UP-1042: Canggu ocean view"
                    className="w-full px-3 py-2 rounded-lg text-sm text-white/80 font-mono outline-none focus:ring-1 focus:ring-[#4db8ff]/50 resize-none"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(77,184,255,0.12)" }}
                  />
                  <div className="flex justify-end">
                    <button
                      onClick={() => {
                        const picks = settings.brokerPicks.filter((_, j) => j !== i);
                        setSettings({ ...settings, brokerPicks: picks });
                      }}
                      className="flex items-center gap-1 text-xs text-red-400/60 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-3 h-3" /> Удалить сегмент
                    </button>
                  </div>
                </div>
              ))}
              <button
                onClick={() => setSettings({ ...settings, brokerPicks: [...settings.brokerPicks, { label: "", picks: "" }] })}
                className="flex items-center gap-2 text-xs text-[#4db8ff]/60 hover:text-[#4db8ff] transition-colors mt-2"
              >
                <Plus className="w-3.5 h-3.5" /> Добавить сегмент
              </button>
            </Section>

            {/* ── Qualification steps ── */}
            <Section title="Скрипты квалификации" defaultOpen={false}>
              <p className="text-xs text-white/35 mb-4">
                Фиксированные сообщения по каждому этапу квалификации. Бот использует их как шаблон.
              </p>
              {settings.qualificationSteps.map((step, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <input
                      value={step.label}
                      onChange={(e) => {
                        const steps = [...settings.qualificationSteps];
                        steps[i] = { ...steps[i], label: e.target.value };
                        setSettings({ ...settings, qualificationSteps: steps });
                      }}
                      placeholder="Название этапа"
                      className="flex-1 px-3 py-1.5 rounded-lg text-sm text-white outline-none focus:ring-1 focus:ring-[#4db8ff]/50"
                      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(77,184,255,0.15)" }}
                    />
                    <button
                      onClick={() => {
                        const steps = settings.qualificationSteps.filter((_, j) => j !== i);
                        setSettings({ ...settings, qualificationSteps: steps });
                      }}
                      className="ml-2 text-red-400/50 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <textarea
                    value={step.message}
                    onChange={(e) => {
                      const steps = [...settings.qualificationSteps];
                      steps[i] = { ...steps[i], message: e.target.value };
                      setSettings({ ...settings, qualificationSteps: steps });
                    }}
                    rows={4}
                    placeholder="Текст сообщения для этого этапа..."
                    className="w-full px-3 py-2 rounded-lg text-sm text-white/80 outline-none focus:ring-1 focus:ring-[#4db8ff]/50 resize-y"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(77,184,255,0.12)" }}
                  />
                </div>
              ))}
              <button
                onClick={() => setSettings({ ...settings, qualificationSteps: [...settings.qualificationSteps, { label: "", message: "" }] })}
                className="flex items-center gap-2 text-xs text-[#4db8ff]/60 hover:text-[#4db8ff] transition-colors mt-2"
              >
                <Plus className="w-3.5 h-3.5" /> Добавить этап
              </button>
            </Section>

            {/* Save button bottom */}
            <div className="flex justify-end pt-2">
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-semibold text-white disabled:opacity-40 transition-all"
                style={{ background: saved ? "rgba(34,197,94,0.3)" : "linear-gradient(135deg,#2563eb,#3b9eff)" }}
              >
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {saved ? "Сохранено ✓" : saving ? "Сохраняю..." : "Сохранить настройки"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
