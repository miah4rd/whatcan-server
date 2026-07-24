module.exports = {
  apps: [{
    name: 'whatcan',
    script: 'node',
    args: '--enable-source-maps ./artifacts/api-server/dist/index.mjs',
    cwd: '/opt/whatcan',
    max_memory_restart: '512M',
    log: '/var/log/whatcan.log',
    env_file: '.env',
    env: {
      NODE_ENV: 'production',
      PORT: 5000,
      AMO_SUBDOMAIN: 'unicornproperty',
      REPLIT_DOMAINS: 'copilot.globalapplab.ru',
    }
  }]
};
