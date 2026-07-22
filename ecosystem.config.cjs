module.exports = {
  apps: [{
    name: 'whatcan',
    script: 'node',
    args: '--enable-source-maps ./artifacts/api-server/dist/index.mjs',
    cwd: '/opt/whatcan',
    max_memory_restart: '512M',
    log: '/var/log/whatcan.log',
    env: {
      NODE_ENV: 'production',
      PORT: 5000,
      DATABASE_URL: 'postgresql://copilot:copilot_db_pass_2026@localhost:5432/whatcan',
      ANTHROPIC_API_KEY: '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',
      AMOCRM_CLIENT_ID: '525b6eed-ad42-4761-8eca-3ae860811561',
      AMOCRM_CLIENT_SECRET: 'aTkiQcyek3oTHCPsN2YvIxfNouOPyMm6weITo8gP9QHvr0L0EFBT7QBHqAeiqDkH',
      AMOCRM_LONG_LIVED_TOKEN: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6ImE4ZGIzMzAxMTMyYmEwNDVhMTlhYmQ0M2EzMmI4ODA1YWNmOGQ5YTI5ZTI2MjVhYzRjMzJmYjBiZjM1ZDQ0NmQxM2M3ODM5MDczOGZiZGY5In0.eyJhdWQiOiI1MjViNmVlZC1hZDQyLTQ3NjEtOGVjYS0zYWU4NjA4MTE1NjEiLCJqdGkiOiJhOGRiMzMwMTEzMmJhMDQ1YTE5YWJkNDNhMzJiODgwNWFjZjhkOWEyOWUyNjI1YWM0YzMyZmIwYmYzNWQ0NDZkMTNjNzgzOTA3MzhmYmRmOSIsImlhdCI6MTc4NDY3MjQ4MiwibmJmIjoxNzg0NjcyNDgyLCJleHAiOjE4MTY5OTIwMDAsInN1YiI6IjExMjMwMzg2IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjMxODMwODU0LCJiYXNlX2RvbWFpbiI6ImFtb2NybS5ydSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJwdXNoX25vdGlmaWNhdGlvbnMiLCJmaWxlcyIsImNybSIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiZjdmZjI2NjctMGNjNC00OTkyLThjOTctMjg0MDhiMWQzMWI1IiwiYXBpX2RvbWFpbiI6ImFwaS1iLmFtb2NybS5ydSJ9.DSLngE5_x_dl81HKZT7tQGhadrXQ85emqltHsSBkBnyG3xWId7AoeSiDNm4P5_YhO3aI6ekUL91wvCuEwNSBoiaECnzGG9y8k7aJjuxWXeExxa8gVTUhWCOZWk3bAWrhwOYfWBysr6vJY8K_Be35x_TnzdV_JdSEIe9Epdn4X1UCniM77oKJ7nWdSAk0clEzfi2ijCyKjMvsVvjnND_e3mtneKbIEADqREwJ2E_8gH57yH4oWxoz06lzNd4tRawMvDaj1E1iWg9PTzrfjfwUfAEUtNzJ0_3a4bvcpZPvr4HQXMegR5MNPqGXagW_Z20OEskA9_PZvMTaa2R3IlBs0w',
      AMO_SUBDOMAIN: 'unicornproperty',
      REPLIT_DOMAINS: 'copilot.globalapplab.ru',
      DASHBOARD_PASSWORD: 'unicorn'
    }
  }]
};