module.exports = {
  apps: [{
    name: 'sxb-backend',
    script: '/var/www/sxb-vpn/dist/server.cjs',
    cwd: '/var/www/sxb-vpn',
    env_file: '/var/www/sxb-vpn/.env',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      NODE_PATH: '/var/www/sxb-vpn/backend/node_modules'
    }
  }]
};
