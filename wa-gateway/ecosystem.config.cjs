// Separate from the whatcan ecosystem on purpose: deploy.sh restarts whatcan on
// every deploy, and a restart here drops every linked WhatsApp number for a few
// seconds. This process is restarted only when wa-gateway itself changes.
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch {}
  return env;
}

module.exports = {
  apps: [{
    name: 'wa-gateway',
    script: 'index.mjs',
    cwd: __dirname,
    max_memory_restart: '350M',
    log: '/var/log/wa-gateway.log',
    kill_timeout: 10000,
    env: { ...loadEnv(), NODE_ENV: 'production' },
  }],
};
