import { useRef, useState } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Dashboard from "@/pages/Dashboard";
import Tasks from "@/pages/Tasks";
import Login from "@/pages/Login";
import SettingsPage from "@/pages/Settings";
import { motion, useInView } from "framer-motion";
import { ArrowRight, MessageSquare, Zap, Crosshair, Target, Shield, Check, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LangProvider, LangToggle, useLang } from "@/lib/i18n";

import amoOverviewImg from "@assets/Screenshot_2026-05-31_at_09.46.11_1780191991179.png";
import pluginDetailImg from "@assets/Screenshot_2026-05-31_at_09.46.22_1780191991178.png";
import baliVillaImg from "@/assets/bali-villa.png";

const queryClient = new QueryClient();

const fadeInUp = {
  hidden: { opacity: 0, y: 40 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" } }
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.1 } }
};

function FadeInWhenVisible({ children, delay = 0, className = "" }: { children: React.ReactNode, delay?: number, className?: string }) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  return (
    <motion.div
      ref={ref}
      initial="hidden"
      animate={isInView ? "visible" : "hidden"}
      variants={{
        hidden: { opacity: 0, y: 30 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.6, delay, ease: "easeOut" } }
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function AmoLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizes = { sm: "text-base", md: "text-xl", lg: "text-3xl" };
  return (
    <span className={`font-bold tracking-tight ${sizes[size]} text-white select-none flex items-baseline gap-2`}>
      <span>Follow<span className="text-[#4db8ff]">Up</span> AI</span>
      <span className="font-normal text-white/35 text-[0.55em] tracking-widest uppercase">for amoCRM</span>
    </span>
  );
}

function NavBar() {
  const { t } = useLang();
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 glass-panel border-b border-[#4db8ff]/10 px-6 py-4 flex items-center justify-between">
      <AmoLogo size="md" />
      <div className="hidden md:flex items-center gap-8 text-sm text-white/50 font-medium">
        <a href="#features" className="hover:text-white transition-colors">{t.nav_features}</a>
        <a href="#how-it-works" className="hover:text-white transition-colors">{t.nav_how}</a>
        <a href="#manifesto" className="hover:text-white transition-colors">{t.nav_why}</a>
      </div>
      <div className="flex items-center gap-3">
        <LangToggle />
        <a href="/login">
          <Button
            variant="outline"
            className="rounded-lg h-9 px-5 text-sm font-semibold border-white/15 bg-white/5 hover:bg-white/10 text-white"
          >
            {t.nav_login}
          </Button>
        </a>
        <Button
          className="rounded-lg h-9 px-5 text-sm font-semibold hidden sm:flex"
          style={{ background: "linear-gradient(135deg,#2563eb,#3b9eff)", border: "none", color: "#fff" }}
        >
          {t.nav_demo} <ArrowRight className="w-4 h-4 ml-1.5" />
        </Button>
      </div>
    </nav>
  );
}

function Hero() {
  const { t } = useLang();
  return (
    <section className="relative min-h-[100dvh] flex items-center justify-center pt-24 overflow-hidden">
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[600px] rounded-full blur-[140px] pointer-events-none"
        style={{ background: "radial-gradient(ellipse,rgba(59,158,255,0.18) 0%,transparent 70%)" }} />

      <div className="container px-6 relative z-10 grid lg:grid-cols-2 gap-16 items-center">
        <motion.div initial="hidden" animate="visible" variants={staggerContainer} className="max-w-2xl">

          <motion.div variants={fadeInUp} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#4db8ff]/25 bg-[#4db8ff]/8 text-[#7dd3fc] text-xs font-medium uppercase tracking-widest mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-[#4db8ff] animate-pulse" />
            {t.hero_badge}
          </motion.div>

          <motion.h1 variants={fadeInUp} className="text-5xl sm:text-6xl font-bold leading-[1.1] mb-6 text-white">
            {t.hero_h1_1}<br />
            <span className="text-gradient">{t.hero_h1_2}</span>
          </motion.h1>

          <motion.p variants={fadeInUp} className="text-lg text-white/55 mb-10 max-w-lg leading-relaxed font-light">
            {t.hero_p}
          </motion.p>

          <motion.div variants={fadeInUp} className="flex flex-col sm:flex-row gap-3">
            <Button size="lg" className="h-12 px-7 font-semibold text-sm rounded-lg text-white"
              style={{ background: "linear-gradient(135deg,#2563eb,#3b9eff)", border: "none" }}>
              {t.hero_cta1}
            </Button>
            <Button variant="outline" size="lg" className="h-12 px-7 font-semibold text-sm rounded-lg border-white/15 bg-white/5 hover:bg-white/10 text-white">
              {t.hero_cta2}
            </Button>
          </motion.div>

          <motion.div variants={fadeInUp} className="mt-10 flex items-center gap-3 text-xs text-white/40 font-medium uppercase tracking-widest">
            <div className="flex -space-x-2">
              {["#1e3a5f","#1d4ed8","#2563eb"].map((c, i) => (
                <div key={i} className="w-8 h-8 rounded-full border-2 border-[#0d1f35]" style={{ background: c }} />
              ))}
            </div>
            <span>{t.hero_trust}</span>
          </motion.div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
          className="relative"
        >
          <div className="relative aspect-square md:aspect-[4/3] lg:aspect-square rounded-xl overflow-hidden border border-[#4db8ff]/15 glass-panel p-2">
            <div className="absolute inset-0 bg-gradient-to-tr from-[#0d1f35]/60 via-transparent to-transparent z-10 pointer-events-none" />
            <img src={amoOverviewImg} alt="FollowUp AI Agent for amoCRM" className="w-full h-full object-cover rounded-lg" />

            <div className="absolute bottom-8 -left-6 right-6 glass-panel border border-[#4db8ff]/20 rounded-xl p-5 z-20 shadow-2xl">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 rounded-full bg-[#1d4ed8]/60 flex items-center justify-center">
                  <span className="text-xs font-bold text-white">LD</span>
                </div>
                <div>
                  <div className="text-sm font-semibold text-white">Liam Davies</div>
                  <div className="text-xs text-[#4db8ff]">{t.hero_just_replied}</div>
                </div>
              </div>
              <div className="bg-white/5 border border-white/8 rounded-lg p-3 mb-3">
                <p className="text-sm text-white/75">"Is the Seminyak villa still available for viewing tomorrow?"</p>
              </div>
              <div className="relative">
                <div className="absolute -left-2 top-0 bottom-0 w-0.5 rounded-full bg-[#4db8ff]" />
                <div className="pl-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs text-[#4db8ff] font-medium flex items-center gap-1.5">
                      <Zap className="w-3 h-3" /> {t.hero_draft_label}
                    </span>
                    <span className="text-xs text-white/35">0.2s</span>
                  </div>
                  <p className="text-sm text-white/85">"Hi Liam, yes it is. I have a slot at 2 PM or 4 PM — it just came back on market this morning. What time works best?"</p>
                  <div className="flex gap-2 mt-3">
                    <Button size="sm" className="h-8 text-xs font-semibold w-full rounded-md text-white"
                      style={{ background: "linear-gradient(135deg,#2563eb,#3b9eff)", border: "none" }}>
                      {t.hero_approve}
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs rounded-md border-white/15 bg-white/5 text-white/60 px-3">{t.hero_edit}</Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function TheProblem() {
  const { t } = useLang();
  return (
    <section id="features" className="py-28 relative border-y border-[#4db8ff]/8"
      style={{ background: "rgba(8,20,40,0.5)" }}>
      <div className="container px-6 max-w-5xl">
        <div className="grid md:grid-cols-3 gap-12">
          <FadeInWhenVisible className="md:col-span-1">
            <h2 className="text-3xl font-bold text-white mb-4">{t.prob_h2}</h2>
            <p className="text-white/50 text-sm leading-relaxed">{t.prob_p}</p>
          </FadeInWhenVisible>

          <div className="md:col-span-2 grid sm:grid-cols-2 gap-5">
            {[
              { icon: <Crosshair className="w-7 h-7 text-[#4db8ff]" />, title: t.prob_card1_title, body: t.prob_card1_body },
              { icon: <MessageSquare className="w-7 h-7 text-[#4db8ff]" />, title: t.prob_card2_title, body: t.prob_card2_body },
            ].map((card, i) => (
              <FadeInWhenVisible key={i} delay={0.1 * (i + 1)}
                className="glass-panel p-7 rounded-xl border border-[#4db8ff]/12 hover:border-[#4db8ff]/25 transition-colors">
                <div className="mb-5">{card.icon}</div>
                <h3 className="text-lg font-semibold text-white mb-2">{card.title}</h3>
                <p className="text-sm text-white/50">{card.body}</p>
              </FadeInWhenVisible>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const { t } = useLang();
  const steps = [
    { step: "01", title: t.how_step1_title, desc: t.how_step1_desc, align: "left",  img: null },
    { step: "02", title: t.how_step2_title, desc: t.how_step2_desc, align: "right", img: pluginDetailImg },
    { step: "03", title: t.how_step3_title, desc: t.how_step3_desc, align: "left",  img: null },
  ] as { step: string; title: string; desc: string; align: string; img: string | null }[];

  return (
    <section id="how-it-works" className="py-28 container px-6">
      <div className="text-center max-w-2xl mx-auto mb-20">
        <h2 className="text-4xl font-bold text-white mb-5">{t.how_h2}</h2>
        <p className="text-white/50 text-lg font-light">{t.how_p}</p>
      </div>

      <div className="space-y-28 relative">
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-[#4db8ff]/20 to-transparent hidden md:block" />

        {steps.map((item, i) => (
          <FadeInWhenVisible key={i} className={`flex flex-col md:flex-row items-center gap-12 ${item.align === "right" ? "md:flex-row-reverse" : ""}`}>
            <div className={`flex-1 ${item.align === "left" ? "md:text-right" : "text-left"}`}>
              <div className="text-[#4db8ff] font-mono text-lg mb-3 font-bold">{item.step}</div>
              <h3 className="text-2xl font-bold text-white mb-3">{item.title}</h3>
              <p className="text-white/50 text-base font-light leading-relaxed">{item.desc}</p>
            </div>

            <div className="w-10 h-10 rounded-full border border-[#4db8ff]/40 bg-[#0d1f35] z-10 flex items-center justify-center shadow-[0_0_24px_rgba(77,184,255,0.2)] hidden md:flex flex-shrink-0">
              <div className="w-2 h-2 rounded-full bg-[#4db8ff]" />
            </div>

            <div className="flex-1 w-full">
              {item.img ? (
                <div className="rounded-xl overflow-hidden border border-[#4db8ff]/15 shadow-2xl">
                  <img src={item.img} alt={item.title} className="w-full h-auto object-cover" />
                </div>
              ) : (
                <div className="aspect-[4/3] glass-panel border border-[#4db8ff]/12 rounded-xl p-1 relative overflow-hidden group hover:border-[#4db8ff]/25 transition-colors duration-500">
                  <div className="absolute inset-0 group-hover:bg-[#4db8ff]/5 transition-colors duration-500" />
                  <div className="absolute inset-x-0 top-1/2 h-px bg-[#4db8ff]/15 shadow-[0_0_8px_rgba(77,184,255,0.4)]" />
                  <div className="absolute inset-y-0 left-1/2 w-px bg-[#4db8ff]/15 shadow-[0_0_8px_rgba(77,184,255,0.4)]" />
                  <div className="absolute top-4 left-4 font-mono text-[10px] text-[#4db8ff]/40">STATUS: ONLINE</div>
                  <div className="absolute bottom-4 right-4 flex gap-0.5 items-end">
                    {[3,4,2,5,3,4].map((h, j) => (
                      <div key={j} className="w-1 rounded-sm bg-[#4db8ff]/40" style={{ height: `${h * 4}px` }} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </FadeInWhenVisible>
        ))}
      </div>
    </section>
  );
}

function QuoteImage() {
  const { t } = useLang();
  return (
    <section className="relative h-[55vh] min-h-[450px] flex items-center border-y border-[#4db8ff]/10 overflow-hidden">
      <div className="absolute inset-0 z-0">
        {baliVillaImg && <img src={baliVillaImg} alt="Bali Villa" className="w-full h-full object-cover opacity-30" />}
        <div className="absolute inset-0" style={{ background: "linear-gradient(90deg,#0d1f35 0%,rgba(13,31,53,0.85) 50%,transparent 100%)" }} />
      </div>

      <div className="container px-6 relative z-10">
        <FadeInWhenVisible className="max-w-2xl">
          <div className="text-[#4db8ff] mb-5 opacity-60">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
          </div>
          <h2 className="text-2xl sm:text-3xl font-light text-white leading-snug mb-7">{t.quote_text}</h2>
          <div className="text-sm">
            <div className="text-white font-semibold">{t.quote_name}</div>
            <div className="text-white/45 text-xs mt-0.5">{t.quote_title}</div>
          </div>
        </FadeInWhenVisible>
      </div>
    </section>
  );
}

function Manifesto() {
  const { t } = useLang();
  return (
    <section id="manifesto" className="py-28 container px-6">
      <div className="grid md:grid-cols-2 gap-16 items-center">
        <FadeInWhenVisible>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#4db8ff]/20 bg-[#4db8ff]/8 text-[#7dd3fc] text-xs font-medium uppercase tracking-widest mb-7">
            <Target className="w-3 h-3" /> {t.man_badge}
          </div>
          <h2 className="text-4xl font-bold text-white mb-5">{t.man_h2}</h2>
          <p className="text-lg text-white/50 font-light mb-8 leading-relaxed">{t.man_p}</p>
          <ul className="space-y-4 text-sm">
            {[t.man_li1, t.man_li2, t.man_li3].map((item, i) => (
              <li key={i} className="flex items-start gap-3">
                <Check className="w-4 h-4 text-[#4db8ff] shrink-0 mt-0.5" />
                <span className="text-white/55">{item}</span>
              </li>
            ))}
          </ul>
        </FadeInWhenVisible>

        <FadeInWhenVisible delay={0.2}>
          <div className="grid grid-cols-2 gap-4">
            {[
              { value: "0.2s", label: t.man_stat1, offset: false, highlight: true },
              { value: "100%", label: t.man_stat2, offset: true,  highlight: false },
              { value: "Zero", label: t.man_stat3, offset: false, highlight: false },
              { value: "3×",   label: t.man_stat4, offset: false, highlight: true },
            ].map((stat, i) => (
              <div key={i} className={`glass-panel p-6 rounded-xl border border-[#4db8ff]/12 flex flex-col items-center justify-center text-center aspect-square hover:border-[#4db8ff]/25 transition-colors ${stat.offset && i === 1 ? "mt-6" : i === 2 ? "-mt-6" : ""}`}>
                <div className={`text-4xl font-bold mb-2 ${stat.highlight ? "text-[#4db8ff]" : "text-white"}`}>{stat.value}</div>
                <div className="text-xs text-white/40 font-medium uppercase tracking-widest">{stat.label}</div>
              </div>
            ))}
          </div>
        </FadeInWhenVisible>
      </div>
    </section>
  );
}

function CTA() {
  const { t } = useLang();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email.trim()) setSubmitted(true);
  };

  return (
    <section className="py-28 relative overflow-hidden border-t border-[#4db8ff]/10">
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at 50% 100%,rgba(37,99,235,0.18) 0%,transparent 70%)" }} />

      <div className="container px-6 relative z-10 text-center max-w-2xl mx-auto">
        <h2 className="text-5xl md:text-6xl font-bold text-white mb-6">
          {t.cta_h2}<span className="text-[#4db8ff]">?</span>
        </h2>
        <p className="text-xl text-white/50 font-light mb-12">{t.cta_p}</p>

        {submitted ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="glass-panel border border-[#4db8ff]/25 rounded-2xl px-10 py-8 inline-block"
          >
            <div className="w-12 h-12 rounded-full bg-[#4db8ff]/15 flex items-center justify-center mx-auto mb-4">
              <Check className="w-6 h-6 text-[#4db8ff]" />
            </div>
            <p className="text-white font-semibold text-lg mb-1">You're on the list.</p>
            <p className="text-white/45 text-sm">We'll reach out as soon as your slot is ready.</p>
          </motion.div>
        ) : (
          <>
            <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3 max-w-lg mx-auto mb-5">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t.cta_email_placeholder}
                className="flex-1 h-14 px-5 rounded-lg text-sm text-white placeholder-white/30 outline-none focus:ring-1 focus:ring-[#4db8ff]/50"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(77,184,255,0.2)" }}
              />
              <Button
                type="submit"
                size="lg"
                className="h-14 px-8 font-semibold text-sm rounded-lg text-white whitespace-nowrap shadow-[0_0_40px_rgba(37,99,235,0.35)] hover:shadow-[0_0_60px_rgba(37,99,235,0.5)] transition-all"
                style={{ background: "linear-gradient(135deg,#2563eb,#3b9eff)", border: "none" }}
              >
                {t.cta_btn_access}
              </Button>
            </form>

            <div className="flex items-center justify-center gap-4 mb-6">
              <div className="h-px flex-1 bg-white/8 max-w-[80px]" />
              <span className="text-white/25 text-xs uppercase tracking-widest">or</span>
              <div className="h-px flex-1 bg-white/8 max-w-[80px]" />
            </div>

            <a href="mailto:hello@followupai.io" className="text-[#4db8ff]/70 hover:text-[#4db8ff] text-sm font-medium transition-colors">
              {t.cta_btn_demo}
            </a>

            <div className="mt-8 flex items-center justify-center gap-2 text-xs text-white/30">
              <Shield className="w-3 h-3 text-[#4db8ff]/50" />
              <span>{t.cta_badge} · {t.cta_note}</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Footer() {
  const { t } = useLang();
  return (
    <footer className="border-t border-[#4db8ff]/10 py-10" style={{ background: "rgba(8,16,30,0.7)" }}>
      <div className="container px-6 flex flex-col md:flex-row items-center justify-between gap-5">
        <AmoLogo size="sm" />

        <div className="flex gap-6 text-sm text-white/35 font-medium">
          <a href="#" className="hover:text-white/70 transition-colors">{t.foot_privacy}</a>
          <a href="#" className="hover:text-white/70 transition-colors">{t.foot_terms}</a>
          <a href="#" className="hover:text-white/70 transition-colors">{t.foot_support}</a>
        </div>

        <div className="text-xs text-white/30 flex items-center gap-2">
          <Globe className="w-3 h-3" /> {t.foot_tag}
        </div>
      </div>
    </footer>
  );
}

function Home() {
  return (
    <div className="min-h-screen w-full text-foreground overflow-x-hidden">
      <NavBar />
      <Hero />
      <TheProblem />
      <HowItWorks />
      <QuoteImage />
      <Manifesto />
      <CTA />
      <Footer />
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/tasks" component={Tasks} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/login" component={Login} />
      <Route path="/" component={Home} />
      <Route component={Home} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <LangProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </LangProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
