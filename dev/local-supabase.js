'use strict';
/*
 * Emulatore locale di Supabase per sviluppo e test (NON per produzione).
 * - Database: PGlite (PostgreSQL reale compilato in WebAssembly) con lo schema
 *   di supabase/schema.sql e i ruoli/funzioni minime di Supabase (anon,
 *   authenticated, auth.uid()).
 * - HTTP: serve la cartella site/ ed emula gli endpoint usati dal frontend:
 *   POST /rest/v1/rpc/<funzione>, POST /auth/v1/token, POST /auth/v1/logout.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.join(__dirname, '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');

const SUPABASE_STUBS = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists auth;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
create table if not exists auth.users (id uuid primary key, email text unique not null, password text not null);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
`;

// Tipi dei parametri delle funzioni RPC (PostgREST li ricava dal catalogo).
const ARG_TYPES = {
  p_token: 'text', p_answers: 'jsonb', p_id: 'bigint', p_title: 'text', p_description: 'text',
  p_questions: 'jsonb', p_status: 'text', p_count: 'int', p_slug: 'text', p_action: 'text',
};

async function createDb() {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  await db.exec(SCHEMA);
  let queue = Promise.resolve();

  /** Esegue una RPC come farebbe PostgREST: transazione, ruolo e claim JWT. */
  function rpc(fn, args = {}, { sub = null } = {}) {
    const run = async () => {
      if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw Object.assign(new Error('Funzione non valida'), { status: 404 });
      const names = Object.keys(args);
      for (const n of names) {
        if (!ARG_TYPES[n]) throw Object.assign(new Error(`Parametro sconosciuto: ${n}`), { status: 400 });
      }
      const params = names.map((n) => {
        const v = args[n];
        if (v === null || v === undefined) return null;
        return ARG_TYPES[n] === 'jsonb' ? JSON.stringify(v) : String(v);
      });
      const call = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}::${ARG_TYPES[n]}`).join(', ')}) as r`;
      return db.transaction(async (tx) => {
        await tx.query(`select set_config('role', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
          [sub ? 'authenticated' : 'anon', sub || '']);
        const res = await tx.query(call, params);
        return res.rows[0].r;
      });
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  async function addUser(email, password, { admin = false } = {}) {
    const id = crypto.randomUUID();
    await db.query('insert into auth.users (id, email, password) values ($1, $2, $3)', [id, email, password]);
    if (admin) await db.query('insert into public.admins (user_id) values ($1)', [id]);
    return id;
  }

  async function findUser(email, password) {
    const r = await db.query('select id, email from auth.users where email = $1 and password = $2', [email, password]);
    return r.rows[0] || null;
  }

  return { db, rpc, addUser, findUser, close: () => db.close() };
}

/** Converte gli errori PostgreSQL nel formato di PostgREST. */
function pgError(e) {
  const code = e.code || '';
  let status = e.status || 400;
  if (code === '42501') status = 403;
  else if (code === '42883') status = 404;
  else if (code === 'P0002') status = 404;
  return { status, body: { code, message: e.message, details: null, hint: null } };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json',
};

async function createServer({ port = 8787, apiKey = 'local-dev-key' } = {}) {
  const store = await createDb();
  const sessions = new Map(); // access_token -> { sub, email }
  const refresh = new Map(); // refresh_token -> { sub, email }
  const siteDir = path.join(ROOT, 'site');

  function issue(user) {
    const access = 'dev-' + crypto.randomBytes(24).toString('hex');
    const ref = 'ref-' + crypto.randomBytes(24).toString('hex');
    sessions.set(access, { sub: user.id, email: user.email });
    refresh.set(ref, { sub: user.id, email: user.email });
    return { access_token: access, refresh_token: ref, token_type: 'bearer', expires_in: 3600, user: { id: user.id, email: user.email } };
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(type === 'application/json' && body !== undefined ? JSON.stringify(body) : body);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/')) {
        if (req.headers.apikey !== apiKey) return send(401, { message: 'Invalid API key' });
        const raw = await new Promise((resolve) => {
          let d = '';
          req.on('data', (c) => { d += c; });
          req.on('end', () => resolve(d));
        });
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { message: 'JSON non valido' }); }
        const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const sess = bearer ? sessions.get(bearer) : null;
        if (bearer && !sess) return send(401, { code: 'PGRST301', message: 'JWT expired' });

        if (url.pathname === '/auth/v1/token') {
          const grant = url.searchParams.get('grant_type');
          if (grant === 'password') {
            const user = await store.findUser(body.email, body.password);
            if (!user) return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
            return send(200, issue(user));
          }
          if (grant === 'refresh_token') {
            const r = refresh.get(body.refresh_token);
            if (!r) return send(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
            refresh.delete(body.refresh_token);
            return send(200, issue({ id: r.sub, email: r.email }));
          }
          return send(400, { error: 'unsupported_grant_type' });
        }
        if (url.pathname === '/auth/v1/logout') {
          sessions.delete(bearer);
          return send(204);
        }
        const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_][a-z0-9_]*)$/);
        if (m && req.method === 'POST') {
          try {
            const result = await store.rpc(m[1], body, { sub: sess ? sess.sub : null });
            return send(200, result === undefined ? null : result);
          } catch (e) {
            const { status, body: errBody } = pgError(e);
            return send(status, errBody);
          }
        }
        return send(404, { message: 'Not found' });
      }

      // File statici del sito (config.js generato per puntare a questo server)
      if (url.pathname === '/config.js') {
        return send(200, `window.QISD_CONFIG = { supabaseUrl: ${JSON.stringify(`http://${req.headers.host}`)}, supabaseKey: ${JSON.stringify(apiKey)} };\n`, MIME['.js']);
      }
      let file = path.normalize(path.join(siteDir, decodeURIComponent(url.pathname)));
      if (!file.startsWith(siteDir)) return send(403, 'Forbidden', 'text/plain');
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        if (!url.pathname.endsWith('/')) {
          res.writeHead(301, { Location: url.pathname + '/' });
          return res.end();
        }
        file = path.join(file, 'index.html');
      }
      if (!fs.existsSync(file)) return send(404, 'Not found', 'text/plain');
      return send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    } catch (e) {
      return send(500, { message: e.message });
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    server, store, apiKey,
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { await new Promise((r) => server.close(r)); await store.close(); },
  };
}

module.exports = { createDb, createServer };

if (require.main === module) {
  (async () => {
    const port = Number(process.env.PORT) || 8787;
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    const password = process.env.ADMIN_PASSWORD || 'admin12345';
    const s = await createServer({ port });
    await s.store.addUser(email, password, { admin: true });
    console.log(`Ambiente locale (dati in memoria) su ${s.url}`);
    console.log(`  Questionario: ${s.url}/`);
    console.log(`  Area admin:   ${s.url}/admin/   (${email} / ${password})`);
  })().catch((e) => { console.error(e); process.exit(1); });
}
