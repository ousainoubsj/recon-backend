module.exports = {
  apps: [
    {
      // Matches deploy.sh's existing $APP_NAME so `pm2 startOrReload`
      // reloads this in place instead of leaving the old "backend" process
      // running alongside a differently-named duplicate.
      name: 'backend',
      script: 'app.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'worker',
      script: 'workers/reconciliationWorker.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: { NODE_ENV: 'production' },
      // reconciliationWorker.js's SIGTERM handler waits for in-flight jobs
      // (download/parse/match/COPY) to finish before exiting — a redeploy or
      // `pm2 restart` sends SIGTERM first, then SIGKILL after kill_timeout.
      // pm2's 1.6s default is nowhere near enough for a large file's COPY
      // step; this gives an in-flight run real room to finish cleanly
      // instead of being killed mid-write and left stuck in `processing`.
      kill_timeout: 60000,
    },
  ],
}
