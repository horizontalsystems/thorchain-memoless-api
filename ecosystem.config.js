// pm2 process definition. deploy/deploy.sh runs `pm2 startOrReload ecosystem.config.js` after
// every build. cwd is the repo root because .env is read from there.
module.exports = {
  apps: [
    {
      name: 'memoless-api',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      time: true
    }
  ]
}
