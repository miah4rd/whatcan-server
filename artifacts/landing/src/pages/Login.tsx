import { useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Lock } from "lucide-react";
import { useLang, LangToggle } from "@/lib/i18n";

const PASSWORD = "unicorn";
const SESSION_KEY = "copilot_dash_v1";

export default function Login() {
  const [, setLocation] = useLocation();
  const [val, setVal] = useState("");
  const [err, setErr] = useState(false);
  const { t } = useLang();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (val === PASSWORD) {
      sessionStorage.setItem(SESSION_KEY, "1");
      setLocation("/dashboard");
    } else {
      setErr(true);
      setVal("");
      setTimeout(() => setErr(false), 2000);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "linear-gradient(135deg,#060f1e 0%,#0d1f35 100%)" }}>
      <div className="w-full max-w-sm mx-4">
        {/* Lang toggle top-right */}
        <div className="flex justify-end mb-4">
          <LangToggle />
        </div>

        <div className="text-center mb-8">
          <div
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-5 border border-[#4db8ff]/20"
            style={{ background: "rgba(77,184,255,0.08)" }}
          >
            <Lock className="w-6 h-6 text-[#4db8ff]" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">{t.login_title}</h1>
          <p className="text-sm text-white/40">{t.login_sub}</p>
        </div>

        <form
          onSubmit={submit}
          className="rounded-2xl p-8 border"
          style={{ background: "rgba(13,31,53,0.8)", borderColor: "rgba(77,184,255,0.12)" }}
        >
          <label className="block text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">
            {t.login_label}
          </label>
          <input
            type="password"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder="••••••••"
            autoFocus
            className="w-full px-4 py-3 rounded-xl text-white placeholder-white/20 outline-none text-sm border transition-all"
            style={{
              background: "rgba(255,255,255,0.05)",
              borderColor: err ? "#f87171" : "rgba(77,184,255,0.2)",
              boxShadow: err ? "0 0 0 3px rgba(248,113,113,0.15)" : undefined,
            }}
          />
          {err && <p className="text-xs text-red-400 mt-2">{t.login_wrong}</p>}
          <button
            type="submit"
            className="mt-4 w-full py-3 rounded-xl font-semibold text-sm text-white flex items-center justify-center gap-2 transition-all hover:opacity-90"
            style={{ background: "linear-gradient(135deg,#2563eb,#3b9eff)" }}
          >
            {t.login_btn} <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <p className="text-center text-xs text-white/20 mt-6">
          <a href="/" className="hover:text-white/40 transition-colors">{t.login_back}</a>
        </p>
      </div>
    </div>
  );
}
