// Unicorn OS — calendar: the client viewings and villa inspections agreed in the chats.
// The same slots go one way to the Brokers Google Calendar. amoCRM tasks are not
// shown here: they come to the Inbox as Push drafts.
import { S, api, esc, I, screens, store, on, fmtTime, emit, isPhone } from "./core.js";

const TZ_OFF = 8 * 3600e3;
const FIRST = 8;
const LAST = 21; // rows 08:00 … 20:00
const VISIT_HOURS = 1;
function mondayOf(offsetWeeks) {
  const b = new Date(Date.now() + TZ_OFF);
  const day = (b.getUTCDay() + 6) % 7;
  const m = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() - day + offsetWeeks * 7));
  return new Date(m.getTime() - TZ_OFF);
}
const baliHour = (iso) => {
  const t = new Date(new Date(iso).getTime() + TZ_OFF);
  return t.getUTCHours() + t.getUTCMinutes() / 60;
};
const baliDayIndex = (iso, start) => Math.floor((new Date(iso).getTime() - start.getTime()) / 86400e3);
const dayLabel = (d, opts) => new Date(d.getTime() + TZ_OFF).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });

/** Visits that overlap sit side by side: each gets a lane and the width of its group. */
function lanes(evs) {
  const sorted = [...evs].sort((a, b) => baliHour(a.at) - baliHour(b.at));
  let group = [];
  let groupEnd = -1;
  const flush = () => {
    const ends = [];
    for (const e of group) {
      const s = baliHour(e.at);
      let lane = ends.findIndex((end) => end <= s);
      if (lane === -1) lane = ends.length;
      ends[lane] = s + VISIT_HOURS;
      e._lane = lane;
    }
    for (const e of group) e._lanes = ends.length;
    group = [];
  };
  for (const e of sorted) {
    const s = baliHour(e.at);
    if (group.length && s >= groupEnd) flush();
    group.push(e);
    groupEnd = Math.max(groupEnd, s + VISIT_HOURS);
  }
  flush();
  return sorted;
}

screens.calendar = {
  title: "Calendar",
  flush: false,
  async render({ el, tools }) {
    let week = Number(store.get("cal-week", 0));
    const draw = async () => {
      const start = mondayOf(week);
      const end = new Date(start.getTime() + 7 * 86400e3);
      tools.innerHTML = `<button class="btn sm" id="cal-prev" title="Previous week">${I.back}</button><button class="btn sm" id="cal-today">This week</button><button class="btn sm" id="cal-next" title="Next week">${I.fwd}</button>
        <span class="chip on">${esc(dayLabel(start, { day: "numeric", month: "short" }))} – ${esc(dayLabel(new Date(end.getTime() - 86400e3), { day: "numeric", month: "short" }))}</span>
        <a class="btn sm" href="https://calendar.google.com/calendar/r/week" target="_blank" rel="noopener">${I.ext} Google Calendar</a>`;
      tools.querySelector("#cal-prev").onclick = () => (store.set("cal-week", --week), draw());
      tools.querySelector("#cal-next").onclick = () => (store.set("cal-week", ++week), draw());
      tools.querySelector("#cal-today").onclick = () => ((week = 0), store.set("cal-week", 0), draw());
      const key = `cal:${start.toISOString()}`;
      if (!S.cache[key]) el.innerHTML = `<div class="loading">Loading the week…</div>`;
      let events = S.cache[key]?.value;
      const paint = (evs) => {
        events = evs.filter((e) => e.kind === "viewing" || e.kind === "inspection");
        const days = [...Array(7)].map((_, i) => new Date(start.getTime() + i * 86400e3));
        const todayIdx = baliDayIndex(new Date().toISOString(), start);
        const legend = `<div class="legend"><span><i style="background:var(--live)"></i>Client viewing</span><span><i style="background:var(--accent)"></i>Villa inspection</span>
          <span class="faint">From the slots agreed in the chats. The same visits are added to the Brokers Google Calendar; a visit typed straight into Google does not show here.</span></div>`;
        const evHtml = (e, style) =>
          `<div class="ev ${e.kind}" data-lead="${esc(e.leadId || "")}" title="${esc(e.title)}${e.sub ? " · " + esc(e.sub) : ""}" ${style ? `style="${style}"` : ""}><b>${esc(fmtTime(e.at))} ${esc(e.title.replace(/^(Viewing|Inspection) · /, ""))}</b>${e.sub ? `<span>${esc(e.sub)}</span>` : ""}</div>`;
        if (isPhone()) {
          el.innerHTML = `<div class="calwrap">${legend}<div class="agenda">${days
            .map((dd, i) => {
              const evs = events.filter((e) => baliDayIndex(e.at, start) === i);
              return `<div class="day"><h3>${esc(dayLabel(dd, { weekday: "long", day: "numeric", month: "short" }))}</h3><div class="stack">${
                evs.map((e) => `<div class="note" data-lead="${esc(e.leadId || "")}" style="cursor:pointer;border-left-color:${e.kind === "viewing" ? "var(--live)" : "var(--accent)"}"><b>${esc(fmtTime(e.at))} · ${esc(e.title)}</b>${e.sub ? `<br><span class="faint">${esc(e.sub)}</span>` : ""}</div>`).join("") || `<span class="faint">No visits</span>`
              }</div></div>`;
            })
            .join("")}</div></div>`;
        } else {
          const untimed = (e) => !e.timeKnown || baliHour(e.at) < FIRST || baliHour(e.at) >= LAST;
          const hasUntimed = events.some(untimed);
          const hours = [...Array(LAST - FIRST)].map((_, i) => FIRST + i);
          let g = `<div class="hd"></div>` + days.map((dd, i) => `<div class="hd ${i === todayIdx ? "today" : ""}">${esc(dayLabel(dd, { weekday: "short" }))}<b>${new Date(dd.getTime() + TZ_OFF).getUTCDate()}</b></div>`).join("");
          if (hasUntimed) {
            g += `<div class="hr allday-h">other</div>` + days.map((_, i) => `<div class="allday">${events.filter((e) => baliDayIndex(e.at, start) === i && untimed(e)).map((e) => evHtml(e)).join("")}</div>`).join("");
          }
          const perDay = days.map((_, i) => lanes(events.filter((e) => !untimed(e) && baliDayIndex(e.at, start) === i)));
          for (const h of hours) {
            g += `<div class="hr">${String(h).padStart(2, "0")}:00</div>`;
            for (let i = 0; i < 7; i++) {
              const here = perDay[i].filter((e) => Math.floor(baliHour(e.at)) === h);
              g += `<div class="slot ${i === todayIdx ? "today" : ""}">${here
                .map((e) => {
                  const w = 100 / e._lanes;
                  return evHtml(e, `top:${((baliHour(e.at) - h) * 100).toFixed(1)}%;height:calc(${VISIT_HOURS * 100}% - 3px);left:calc(${(e._lane * w).toFixed(3)}% + 2px);width:calc(${w.toFixed(3)}% - 4px)`);
                })
                .join("")}</div>`;
            }
          }
          const rows = `auto ${hasUntimed ? "auto " : ""}repeat(${hours.length}, minmax(44px, 1fr))`;
          el.innerHTML = `<div class="calwrap">${legend}<div class="cal" style="grid-template-rows:${rows}">${g}</div>${
            events.length ? "" : `<p class="faint cal-empty">No viewings or inspections agreed for this week.</p>`
          }</div>`;
        }
        on(el, "click", "[data-lead]", (e, x) => x.dataset.lead && emit("open-peek", { type: "lead", id: x.dataset.lead }));
      };
      if (events) paint(events);
      try {
        const fresh = (await api(`/calendar?from=${start.toISOString()}&to=${end.toISOString()}`)).events;
        S.cache[key] = { at: Date.now(), value: fresh };
        if (S.route.screen === "calendar" && mondayOf(week).getTime() === start.getTime()) paint(fresh);
      } catch (e) {
        if (!events) el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      }
    };
    await draw();
  },
};
