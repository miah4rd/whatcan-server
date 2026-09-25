// Unicorn OS service worker: shows the Copilot's web pushes and opens the card in the OS.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Unicorn OS", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Unicorn OS";
  const url = toOsUrl(data.url || data.data?.url || "/os/");
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/os/icon.svg",
      badge: "/os/icon.svg",
      tag: data.tag || undefined,
      data: { url },
    }),
  );
});

// The Copilot deep-links to /m?lead=<id>; in the OS the same card opens in the side panel.
function toOsUrl(u) {
  try {
    const url = new URL(u, self.location.origin);
    const lead = url.searchParams.get("lead");
    if (lead) return `/os/#/inbox?lead=${encodeURIComponent(lead)}`;
    if (url.searchParams.get("view") === "report") return "/os/#/day";
  } catch (e) {
    /* fall through */
  }
  return "/os/";
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/os/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes("/os")) {
          c.focus();
          return c.navigate(target);
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
