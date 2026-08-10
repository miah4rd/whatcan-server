import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// A send is not a quick request: approving a reply writes an amoCRM field,
// triggers Salesbot, then paces the property links out one at a time — 10-15
// seconds end to end. PM2 sends SIGINT on every `pm2 restart`, i.e. on every
// deploy, and Node's default is to die on the spot. Killed mid-send, the
// message was already with the client while the broker saw a bare "Webhook
// 502" — on 2026-08-10 the server was restarted eight times in an hour while
// brokers were working, and lead 23166131 received the same reply twice.
//
// So: stop accepting new connections, let the in-flight requests finish, and
// only then exit. ecosystem.config.cjs raises kill_timeout to match — PM2's
// default 1600ms would SIGKILL us long before a send completes.
const SHUTDOWN_GRACE_MS = 20_000;
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown: draining in-flight requests before exit");

  const forced = setTimeout(() => {
    logger.warn({ signal, graceMs: SHUTDOWN_GRACE_MS }, "shutdown: grace period expired — exiting with requests still open");
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  forced.unref();

  server.close(() => {
    logger.info({ signal }, "shutdown: all requests finished, exiting cleanly");
    process.exit(0);
  });
  // Without this, close() also waits on keep-alive sockets that are merely idle
  // (the brokers' inbox polls hold one open), so every restart would burn the
  // full grace period instead of exiting as soon as the real work is done.
  server.closeIdleConnections();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(signal));
}

// The drain above only covers an ORDERLY stop. Node's own defaults kill the
// process on the spot for these two, which cuts an in-flight send exactly the
// way a restart used to — that is how the "currentResponsibleUser is not
// defined" bug took the server down mid-request.
//
// A stray rejection is almost always a fire-and-forget background promise (a
// scheduler, a CRM task, a push) and is no reason to drop a broker's send: log
// it and keep serving. An uncaught exception leaves the process in an unknown
// state, so we do exit — but through the drain, so whatever is already being
// delivered gets to finish first.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection — logged, server kept alive");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaught exception — draining before exit");
  shutdown("uncaughtException");
});
