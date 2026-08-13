// Configuration PM2 -- `.cjs` car le depot racine est en ESM ("type":"module"),
// alors que PM2 charge ce fichier en CommonJS.
//
//   pm2 start ecosystem.config.cjs
//   pm2 logs movix-addon
//   pm2 restart movix-addon
//   pm2 save && pm2 startup     # relance automatique au reboot
module.exports = {
  apps: [
    {
      name: 'movix-addon',
      script: 'server.js',
      cwd: __dirname,

      // Une seule instance: le cache est en memoire du process, donc plusieurs
      // instances multiplieraient les appels aux scrapers sans rien partager.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      // Les scrapers gardent des reponses en cache; au-dela on redemarre proprement.
      max_memory_restart: '400M',

      env: {
        NODE_ENV: 'production',
      },

      // Logs horodates, sinon impossible de relier une erreur a une lecture.
      time: true,
      merge_logs: true,
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
    },
  ],
};
