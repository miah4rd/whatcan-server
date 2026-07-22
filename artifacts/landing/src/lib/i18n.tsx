import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

export type Lang = "en" | "ru";

const STORAGE_KEY = "followup_lang";

// ─── All translations ─────────────────────────────────────────────────────────

export const T = {
  en: {
    // Nav
    nav_features: "Features",
    nav_how: "How it works",
    nav_why: "Why FollowUp AI",
    nav_login: "Sign In",
    nav_demo: "Book a Demo",

    // Hero
    hero_badge: "AI Agent for amoCRM",
    hero_h1_1: "Your AI Sales Agent",
    hero_h1_2: "Inside amoCRM.",
    hero_p: "FollowUp AI reads every lead's history, detects the right moment to follow up, and drafts the perfect WhatsApp message — in your voice. One click to approve and send.",
    hero_cta1: "Get Early Access",
    hero_cta2: "Book a Demo →",
    hero_trust: "Trusted by real estate teams on amoCRM",
    hero_just_replied: "Just replied...",
    hero_draft_label: "FollowUp AI Draft",
    hero_approve: "✓ Approve & Send",
    hero_edit: "Edit",

    // Problem
    prob_h2: "Leads don't wait. Your CRM does.",
    prob_p: "In real estate, leads message multiple agents at once. The first to reply with the right message wins the deal. Most teams lose because switching between CRM, WhatsApp, and notes takes too long.",
    prob_card1_title: "Slow Response = Lost Deals",
    prob_card1_body: "Jumping between amoCRM, WhatsApp, and property notes takes minutes. In competitive markets, minutes cost you clients.",
    prob_card2_title: "Generic Replies Don't Convert",
    prob_card2_body: "Auto-responders sound like robots. Real clients expect responses that show you read their message and know your product.",

    // How it works
    how_h2: "How FollowUp AI works",
    how_p: "FollowUp AI doesn't replace your brokers — it gives them a co-pilot inside amoCRM that surfaces the perfect reply before they even start typing.",
    how_step1_title: "Reads Every Lead",
    how_step1_desc: "The extension lives in your amoCRM sidebar. It reads the lead's full history, current CRM stage, and the latest message — in real time.",
    how_step2_title: "Drafts in Your Voice",
    how_step2_desc: "Using your custom playbook and past successful conversations, FollowUp AI drafts a stage-aware reply in your exact tone. No corporate speak — sharp, effective, on-brand.",
    how_step3_title: "One Click to Send",
    how_step3_desc: "Review the draft in the sidebar. Edit if needed. Click once to push it directly into WhatsApp. Your broker looks like they've been waiting for that exact message.",

    // Manifesto
    man_badge: "Zero Distractions",
    man_h2: "Built for Brokers,\nNot for Prompts.",
    man_p: "Most AI tools demand attention — open a new tab, write a prompt, copy context, paste it back. FollowUp AI works silently inside amoCRM so your team stays focused on closing.",
    man_li1: "Lives entirely inside amoCRM — no tab switching, no copy-paste.",
    man_li2: "Learns your tone, playbook, and objection scripts from day one.",
    man_li3: "Stage-aware logic: knows what message fits each step of your funnel.",
    man_stat1: "Draft Speed",
    man_stat2: "amoCRM Sync",
    man_stat3: "Tab Switching",
    man_stat4: "More Follow-ups",

    // CTA
    cta_h2: "Ready to close more deals",
    cta_p: "Join the teams already using FollowUp AI to move leads faster through the funnel — without burning out their brokers.",
    cta_email_placeholder: "Your work email",
    cta_btn_access: "Get Early Access",
    cta_btn_demo: "Book a Demo Instead →",
    cta_badge: "No credit card required",
    cta_note: "Free early access · Cancel anytime",

    // Footer
    foot_privacy: "Privacy",
    foot_terms: "Terms",
    foot_support: "Support",
    foot_tag: "AI Agent for amoCRM Sales Teams",

    // Quote
    quote_text: "\"Before FollowUp AI, I lost a $2M deal because I took 15 minutes to check details and reply. Now I respond with perfect accuracy in seconds. It's an unfair advantage.\"",
    quote_name: "Marcus V.",
    quote_title: "Senior Partner, Bali Premium Real Estate",

    // Login
    login_title: "Sales Dashboard",
    login_sub: "FollowUp AI · Unicorn Property",
    login_label: "Password",
    login_btn: "Sign In",
    login_back: "← Back to Home",
    login_wrong: "Wrong password",

    // Dashboard header
    dash_title: "Sales Dashboard",
    dash_sub_today: "today vs yesterday",
    dash_sub_days: (n: number) => `${n} days vs previous ${n}`,
    dash_sub_custom: (n: number) => `${n} days vs previous ${n}`,
    dash_refresh: "Refresh",

    // Dashboard funnel card
    funnel_title: "Sales Funnel",
    funnel_col_stage: "Stage",
    funnel_col_now: "Now",
    funnel_col_delta: "Δ",
    funnel_col_was: "Was",
    funnel_leg_current: "current period",
    funnel_leg_prev: "start of period (was)",
    funnel_leg_key: "key stages toward deal",
    funnel_empty: "No data — configure amoCRM sync",
    funnel_accum: "accumulating",
    funnel_note: (n: number) => `"Was" data accumulates — comparison appears after ${n} days`,
    funnel_moves: (n: number) => `${n} moves`,
    funnel_leads: (n: number) => `${n} leads`,

    // Dashboard actions
    actions_title: "Broker Actions",
    actions_type: "Type",
    actions_suggested: "AI Suggested",
    actions_done: "Done",
    actions_pct: "%",
    actions_live: "Live contact",
    actions_push: "Follow-up (push)",
    actions_tasks: "Tasks",
    actions_total: "Total",

    // Dashboard reactivation
    react_title: "Push → Live",
    react_rate: "reactivated",
    react_detail: (reactivated: number, total: number) => `${reactivated} of ${total} push leads returned to live`,
    react_none: "No push contacts in period",

    // Dashboard progress
    prog_title: "Funnel Movement",
    prog_net: "net progress",
    prog_fwd: "Forward →",
    prog_back: "Back ←",
    prog_advanced: "Leads advanced",
    prog_ratio: (n: number) => `~${n} touches per forward move`,
    prog_none: "Movements recorded as work progresses",

    // Dashboard chart
    chart_title: "Daily Activity",
    chart_suggested: "AI suggested",
    chart_live: "Live",
    chart_push: "Push",

    // Stage history
    history_title: "Stage History",
    history_lead: "Lead",
    history_from: "From",
    history_to: "To",
    history_broker: "Broker",
    history_time: "Time",
    history_new: "new",

    // Dashboard footer
    dash_note: "Funnel snapshots saved daily · comparison appears 7 days after launch",
  },

  ru: {
    // Nav
    nav_features: "Возможности",
    nav_how: "Как работает",
    nav_why: "Почему FollowUp AI",
    nav_login: "Войти",
    nav_demo: "Записаться на демо",

    // Hero
    hero_badge: "AI-агент для amoCRM",
    hero_h1_1: "Ваш AI-агент по продажам",
    hero_h1_2: "внутри amoCRM.",
    hero_p: "FollowUp AI читает историю каждого лида, определяет нужный момент для касания и составляет идеальное WhatsApp-сообщение — в вашем стиле. Один клик, чтобы одобрить и отправить.",
    hero_cta1: "Получить ранний доступ",
    hero_cta2: "Записаться на демо →",
    hero_trust: "Доверяют командам по недвижимости на amoCRM",
    hero_just_replied: "Только что ответил...",
    hero_draft_label: "FollowUp AI Draft",
    hero_approve: "✓ Одобрить и отправить",
    hero_edit: "Редактировать",

    // Problem
    prob_h2: "Лиды не ждут. Ваша CRM — ждёт.",
    prob_p: "В недвижимости лид пишет нескольким агентам одновременно. Побеждает тот, кто ответит первым и по делу. Большинство команд проигрывают, потому что переключение между CRM, WhatsApp и заметками занимает слишком много времени.",
    prob_card1_title: "Медленный ответ = потерянная сделка",
    prob_card1_body: "Переключаться между amoCRM, WhatsApp и заметками по объектам — это минуты. На конкурентных рынках минуты стоят клиентов.",
    prob_card2_title: "Шаблонные ответы не конвертируют",
    prob_card2_body: "Авто-ответчики звучат как роботы. Настоящие клиенты ожидают ответа, который показывает: вы прочитали их сообщение и знаете свой продукт.",

    // How it works
    how_h2: "Как работает FollowUp AI",
    how_p: "FollowUp AI не заменяет ваших брокеров — он даёт им второго пилота прямо внутри amoCRM, который предлагает идеальный ответ ещё до начала набора текста.",
    how_step1_title: "Читает каждого лида",
    how_step1_desc: "Расширение живёт в боковой панели amoCRM. Оно читает полную историю лида, его текущий этап и последнее сообщение — в реальном времени.",
    how_step2_title: "Пишет в вашем стиле",
    how_step2_desc: "Используя ваш плейбук и успешные прошлые переписки, FollowUp AI составляет ответ с учётом этапа воронки — в вашем точном тоне. Никакого канцелярита, только чёткий продающий текст.",
    how_step3_title: "Отправка в один клик",
    how_step3_desc: "Просмотрите черновик в панели. При необходимости отредактируйте. Один клик — и он летит в WhatsApp. Брокер выглядит так, будто ждал именно этого сообщения.",

    // Manifesto
    man_badge: "Ноль отвлечений",
    man_h2: "Создан для брокеров,\nне для промптов.",
    man_p: "Большинство AI-инструментов требуют внимания — открой вкладку, напиши промпт, скопируй контекст, вставь обратно. FollowUp AI работает тихо внутри amoCRM, чтобы команда оставалась сосредоточенной на закрытии сделок.",
    man_li1: "Живёт полностью внутри amoCRM — никаких переключений и copy-paste.",
    man_li2: "С первого дня учится вашему тону, плейбуку и отработке возражений.",
    man_li3: "Логика учитывает этап воронки: знает, какое сообщение подходит на каждом шаге.",
    man_stat1: "Скорость черновика",
    man_stat2: "Синхронизация amoCRM",
    man_stat3: "Переключений вкладок",
    man_stat4: "Больше касаний",

    // CTA
    cta_h2: "Готовы закрывать больше сделок",
    cta_p: "Присоединяйтесь к командам, которые уже используют FollowUp AI для ускорения работы с лидами — без выгорания брокеров.",
    cta_email_placeholder: "Ваш рабочий email",
    cta_btn_access: "Получить ранний доступ",
    cta_btn_demo: "Записаться на демо →",
    cta_badge: "Без банковской карты",
    cta_note: "Бесплатный ранний доступ · Отмена в любой момент",

    // Footer
    foot_privacy: "Конфиденциальность",
    foot_terms: "Условия",
    foot_support: "Поддержка",
    foot_tag: "AI-агент для команд на amoCRM",

    // Quote
    quote_text: "«До FollowUp AI я потерял сделку на $2M, потому что потратил 15 минут на уточнение деталей. Теперь я отвечаю с точностью за секунды. Это нечестное преимущество.»",
    quote_name: "Маркус В.",
    quote_title: "Старший партнёр, Bali Premium Real Estate",

    // Login
    login_title: "Sales Dashboard",
    login_sub: "FollowUp AI · Unicorn Property",
    login_label: "Пароль",
    login_btn: "Войти",
    login_back: "← Вернуться на главную",
    login_wrong: "Неверный пароль",

    // Dashboard header
    dash_title: "Sales Dashboard",
    dash_sub_today: "сегодня vs вчера",
    dash_sub_days: (n: number) => `${n} дней vs предыдущие ${n}`,
    dash_sub_custom: (n: number) => `${n} дн. vs предыдущие ${n}`,
    dash_refresh: "Обновить",

    // Dashboard funnel card
    funnel_title: "Воронка продаж",
    funnel_col_stage: "Этап",
    funnel_col_now: "Сейчас",
    funnel_col_delta: "Δ",
    funnel_col_was: "Было",
    funnel_leg_current: "текущий период",
    funnel_leg_prev: "начало периода (было)",
    funnel_leg_key: "ключевые этапы к сделке",
    funnel_empty: "Нет данных — настройте синхронизацию с amoCRM",
    funnel_accum: "накапл.",
    funnel_note: (n: number) => `Данные «Было» накапливаются — сравнение появится через ${n} дней`,
    funnel_moves: (n: number) => `${n} сдвигов`,
    funnel_leads: (n: number) => `${n} лидов`,

    // Dashboard actions
    actions_title: "Действия брокера",
    actions_type: "Тип",
    actions_suggested: "AI предл.",
    actions_done: "Сделано",
    actions_pct: "%",
    actions_live: "Live контакт",
    actions_push: "Follow-up (push)",
    actions_tasks: "Задачи",
    actions_total: "Итого",

    // Dashboard reactivation
    react_title: "Push → Live",
    react_rate: "реанимировано",
    react_detail: (reactivated: number, total: number) => `${reactivated} из ${total} push-лидов вернулись в live`,
    react_none: "Нет push-касаний за период",

    // Dashboard progress
    prog_title: "Движение по воронке",
    prog_net: "чистый прогресс",
    prog_fwd: "Вперёд →",
    prog_back: "Назад ←",
    prog_advanced: "Лидов продвинулось",
    prog_ratio: (n: number) => `~${n} касания на один сдвиг вперёд`,
    prog_none: "Движения фиксируются по мере работы",

    // Dashboard chart
    chart_title: "Активность по дням",
    chart_suggested: "AI предложил",
    chart_live: "Live",
    chart_push: "Push",

    // Stage history
    history_title: "История сдвигов",
    history_lead: "Лид",
    history_from: "Откуда",
    history_to: "Куда",
    history_broker: "Брокер",
    history_time: "Время",
    history_new: "новый",

    // Dashboard footer
    dash_note: "Снимки воронки сохраняются ежедневно · сравнение появится через 7 дней после запуска",
  },
} as const;

// Loosen literal string types so `ru` is assignable to the same shape as `en`
export type Translations = {
  [K in keyof typeof T.en]: typeof T.en[K] extends string ? string : typeof T.en[K]
};

// ─── Context ──────────────────────────────────────────────────────────────────

type LangCtx = { lang: Lang; t: Translations; setLang: (l: Lang) => void };
const LangContext = createContext<LangCtx>({
  lang: "ru",
  t: T.ru,
  setLang: () => {},
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return (saved === "en" || saved === "ru") ? saved : "ru";
  });

  const setLang = (l: Lang) => {
    localStorage.setItem(STORAGE_KEY, l);
    setLangState(l);
  };

  return (
    <LangContext.Provider value={{ lang, t: T[lang], setLang }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  return useContext(LangContext);
}

// ─── Toggle button ────────────────────────────────────────────────────────────

export function LangToggle({ className = "" }: { className?: string }) {
  const { lang, setLang } = useLang();
  return (
    <div
      className={`flex items-center rounded-lg overflow-hidden border text-xs font-bold select-none ${className}`}
      style={{ borderColor: "rgba(77,184,255,0.2)" }}
    >
      {(["en", "ru"] as Lang[]).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          className="px-2.5 py-1 transition-all"
          style={{
            background: lang === l ? "rgba(77,184,255,0.18)" : "transparent",
            color: lang === l ? "#4db8ff" : "rgba(255,255,255,0.3)",
          }}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
