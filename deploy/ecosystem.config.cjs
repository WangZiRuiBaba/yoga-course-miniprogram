/**
 * pm2 启动配置（与 systemd 二选一）。
 *   npm i -g pm2
 *   pm2 start deploy/ecosystem.config.cjs --env production
 *   pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: 'yoga',
      script: 'server/index.js',
      cwd: __dirname.replace(/[\\/]deploy$/, ''),
      node_args: '--no-warnings',
      instances: 1, // 单实例：SQLite 单文件 + 进程内事件总线，不要开 cluster
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'development',
        PORT: 3100,
        HOST: '127.0.0.1',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3100,
        HOST: '127.0.0.1',
      },
      out_file: './logs/pm2.out.log',
      error_file: './logs/pm2.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
