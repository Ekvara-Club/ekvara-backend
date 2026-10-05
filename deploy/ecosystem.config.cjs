// pm2 sur le Pi : redémarre l'API si elle plante et au reboot (pm2 startup).
// Les variables viennent de ~/ekvara/backend/.env (lu par dotenv au démarrage).
module.exports = {
  apps: [
    {
      name: "ekvara-api",
      cwd: __dirname + "/..",
      script: "dist/src/main.js",
      instances: 1,
      max_memory_restart: "600M",
      env: { NODE_ENV: "production" },
    },
  ],
};
