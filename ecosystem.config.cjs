/** PM2 — dùng với aaPanel hoặc VPS: pm2 start ecosystem.config.cjs */
module.exports = {
  apps: [
    {
      name: 'tool-video',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
        PORT: 3008,
        HOST: '127.0.0.1',
      },
    },
  ],
};
