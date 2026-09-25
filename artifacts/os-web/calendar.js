// Unicorn OS — calendar: agreed viewings and inspections (the same slots the Brokers Google Calendar gets) and amoCRM tasks.
import { S, api, esc, I, screens, store, on, fmtTime, emit, isStaff } from "./core.js";

const TZ_OFF = 8 * 3600e3;
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

screens.calendar = {
  title: "Calendar",
  async render({ el, tools }) {
    let week = Number(store.get("cal-week", 0));
    const showTasks = store.get("cal-tasks", true);
    const draw = async () => {
      const start = mondayOf(week);
      const end = new Date(start.getTime() + 7 * 86400e3);
      tools.innerHTML = `<button class="btn sm" id="cal-prev">${I.back}</button><button class="btn sm" id="cal-today">This week</button><button class="btn sm" id="cal-next">${I.fwd}</button>
        <span class="chip on">${esc(new Date(start.getTime() + TZ_OFF).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }))} – ${esc(new Date(end.getTime() + TZ_OFF - 86400e3).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }))}</span>
        <button class="chip ${showTasks ? "on" : ""}" id="cal-tasks">Tasks</button>
        <a class="btn sm" href="https://calendar.google.com/calendar/r/week" target="_blank" rel="noopener">${I.ext} Google Calendar</a>`;
      tools.querySelector("#cal-prev").onclick = () => (store.set("cal-week", --week), draw());
      tools.querySelector("#cal-next").onclick = () => (store.set("cal-week", ++week), draw());
      tools.querySelector("#cal-today").onclick = () => ((week = 0), store.set("cal-week", 0), draw());
      tools.querySelector("#cal-tasks").onclick = () => (store.set("cal-tasks", !showTasks), screens.calendar.render({ el, tools }));
      el.innerHTML = `<div class="loading">Loading the week…</div>`;
      let events = [];
      try {
        events = (await api(`/calendar?from=${start.toISOString()}&to=${end.toISOString()}`)).events;
      } catch (e) {
        el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
        return;
      }
      if (!showTasks) events = events.filter((e) => e.kind !== "task");
      const days = [...Array(7)].map((_, i) => new Date(start.getTime() + i * 86400e3));
      const todayIdx = baliDayIndex(new Date().toISOString(), start);
      const legend = `<div class="legend"><span><i style="background:var(--live)"></i>Client viewing</span><span><i style="background:var(--accent)"></i>Villa inspection</span><span><i style="background:var(--push)"></i>amoCRM task</span>
        <span class="faint">Viewings and inspections come from the slots agreed in the chats; the same slots are added to the Brokers Google Calendar.</span></div>`;
      if (window.innerWidth <= 860) {
        el.innerHTML = legend + `<div class="agenda">${days
          .map((dd, i) => {
            const evs = events.filter((e) => baliDayIndex(e.at, start) === i);
            return `<div class="day"><h3>${esc(new Date(dd.getTime() + TZ_OFF).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }))}</h3><div class="stack">${
              evs.map((e) => `<div class="note" data-lead="${esc(e.leadId || "")}" style="cursor:pointer;border-left-color:${e.kind === "viewing" ? "var(--live)" : e.kind === "inspection" ? "var(--accent)" : "var(--push)"}"><b>${esc(fmtTime(e.at))} · ${esc(e.title)}</b>${e.sub ? `<br><span class="faint">${esc(e.sub)}</span>` : ""}</div>`).join("") || `<span class="faint">—</span>`
            }</div></div>`;
          })
          .join("")}</div>`;
      } else {
        const hours = [...Array(13)].map((_, i) => 8 + i);
        let g = `<div class="hd"></div>` + days.map((dd, i) => `<div class="hd ${i === todayIdx ? "today" : ""}">${esc(new Date(dd.getTime() + TZ_OFF).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }))}<b>${new Date(dd.getTime() + TZ_OFF).getUTCDate()}</b></div>`).join("");
        const early = (e) => baliHour(e.at) < 8 || baliHour(e.at) >= 21 || !e.timeKnown;
        g += `<div class="hr" style="height:auto;min-height:30px">other</div>` + days.map((_, i) => `<div class="allday">${events.filter((e) => baliDayIndex(e.at, start) === i && early(e)).map((e) => `<div class="ev ${e.kind}" data-lead="${esc(e.leadId || "")}" title="${esc(e.title)}"><b>${esc(fmtTime(e.at))} ${esc(e.title)}</b></div>`).join("")}</div>`).join("");
        for (const h of hours) {
          g += `<div class="hr">${String(h).padStart(2, "0")}:00</div>`;
          for (let i = 0; i < 7; i++) {
            const here = events.filter((e) => !early(e) && baliDayIndex(e.at, start) === i && Math.floor(baliHour(e.at)) === h);
            g += `<div class="slot">${here
              .map((e, k) => `<div class="ev ${e.kind}" data-lead="${esc(e.leadId || "")}" title="${esc(e.title)}${e.sub ? " · " + esc(e.sub) : ""}" style="top:${(baliHour(e.at) - h) * 46}px;height:${e.kind === "task" ? 24 : 56}px;left:${3 + k * 8}px"><b>${esc(fmtTime(e.at))} ${esc(e.title)}</b>${e.sub ? esc(e.sub) : ""}</div>`)
              .join("")}</div>`;
          }
        }
        el.innerHTML = legend + `<div class="cal">${g}</div>`;
      }
      on(el, "click", "[data-lead]", (e, x) => x.dataset.lead && emit("open-peek", { type: "lead", id: x.dataset.lead }));
    };
    await draw();
  },
};
