const fs = require('fs');
const path = require('path');

function loadEnv() {
  try {
    const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
    const env = {};
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

module.exports = {
  apps: [{
    name: 'whatcan',
    script: 'node',
    args: '--enable-source-maps ./artifacts/api-server/dist/index.mjs',
    cwd: '/opt/whatcan',
    max_memory_restart: '512M',
    log: '/var/log/whatcan.log',
    // A send takes 10-15s (amoCRM field write, Salesbot trigger, then the
    // property links paced out one per message). PM2's default kill_timeout is
    // 1600ms, so every deploy SIGKILLed the server mid-send: the client had the
    // message, the broker saw "Webhook 502", and the retry delivered it twice.
    // index.ts drains in-flight requests on SIGINT — this gives it the time.
    kill_timeout: 25000,
    env: {
      ...loadEnv(),
      // Non-secret defaults (override .env if present)
      AMO_SUBDOMAIN: 'unicornproperty',
      REPLIT_DOMAINS: 'copilot.globalapplab.ru',
    }
  }]
};
