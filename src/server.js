'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('./app');

const env = process.env;
const port = Number(env.PORT) || 3000;
const host = env.HOST || '0.0.0.0';
const dbFile = env.DB_FILE || path.join(__dirname, '..', 'data', 'questionario.db');

let adminPassword = env.ADMIN_PASSWORD;
if (!adminPassword) {
  adminPassword = crypto.randomBytes(12).toString('base64url');
  console.warn('ATTENZIONE: ADMIN_PASSWORD non impostata.');
  console.warn(`Password amministratore temporanea (valida fino al riavvio): ${adminPassword}`);
} else if (adminPassword.length < 10) {
  console.warn('ATTENZIONE: ADMIN_PASSWORD è corta, usare almeno 10 caratteri.');
}

const { app, store } = createApp({
  dbFile,
  adminPassword,
  publicBaseUrl: env.PUBLIC_BASE_URL || '',
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  secureCookies: env.COOKIE_SECURE === '1' || env.COOKIE_SECURE === 'true',
});

const server = app.listen(port, host, () => {
  console.log(`Questionario avviato su http://localhost:${port}  (area admin: /admin)`);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
