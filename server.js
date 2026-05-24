// Локальный/облачный сервер для финансового трекера.
// Хранилище: libSQL (SQLite-совместимое).
//   • Локально — файл data.sqlite рядом с server.js (если TURSO_DATABASE_URL не задан).
//   • В облаке — Turso (https://turso.tech), через переменные окружения:
//       TURSO_DATABASE_URL=libsql://<db>.turso.io
//       TURSO_AUTH_TOKEN=<токен>
// Запуск:   node server.js   →   http://localhost:<PORT|3030>

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const PORT = Number(process.env.PORT) || 3030;
const ROOT = __dirname;
const INDEX_PATH = path.join(ROOT, 'index.html');
const LOCAL_DB_URL = 'file:' + path.join(ROOT, 'data.sqlite').replace(/\\/g, '/');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || LOCAL_DB_URL,
  authToken: process.env.TURSO_AUTH_TOKEN, // игнорируется для file:
});

const newId = () => crypto.randomUUID();
const currentMonth = () => new Date().toISOString().slice(0, 7);
const todayISO = () => new Date().toISOString().slice(0, 10);

async function init() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS income_sources (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      amount      REAL NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS expenses (
      id            TEXT PRIMARY KEY,
      amount        REAL NOT NULL,
      category      TEXT NOT NULL,
      date          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      is_recurring  INTEGER NOT NULL DEFAULT 0,
      billing_day   INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await seedIfEmpty();
}

async function seedIfEmpty() {
  const r = await db.execute('SELECT COUNT(*) AS cnt FROM income_sources');
  if (Number(r.rows[0].cnt) > 0) return;

  const incomeSeed = [
    ['Основная работа', 15000000],
    ['Фриланс',          4500000],
    ['Дивиденды',         800000],
  ];
  for (const [name, amount] of incomeSeed) {
    await db.execute({
      sql: 'INSERT INTO income_sources (id, name, amount) VALUES (?, ?, ?)',
      args: [newId(), name, amount],
    });
  }

  const m = currentMonth();
  const expSeed = [
    [5000000, 'rent',          `${m}-05`, 'Квартира',            1, 5   ],
    [ 750000, 'utilities',     `${m}-10`, 'Свет и вода',         0, null],
    [ 199000, 'subscriptions', `${m}-15`, 'Стриминг',            1, 15  ],
    [1850000, 'groceries',     `${m}-12`, 'Продукты на неделю',  0, null],
  ];
  for (const row of expSeed) {
    await db.execute({
      sql: 'INSERT INTO expenses (id, amount, category, date, description, is_recurring, billing_day) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [newId(), ...row],
    });
  }
}

async function listIncome() {
  const r = await db.execute('SELECT id, name, amount FROM income_sources ORDER BY created_at ASC');
  return r.rows.map((row) => ({ id: row.id, name: row.name, amount: Number(row.amount) }));
}

async function listExpenses() {
  const r = await db.execute(
    'SELECT id, amount, category, date, description, is_recurring, billing_day FROM expenses ORDER BY date DESC, created_at DESC'
  );
  return r.rows.map((row) => ({
    id: row.id,
    amount: Number(row.amount),
    category: row.category,
    date: row.date,
    description: row.description,
    isRecurring: !!Number(row.is_recurring),
    billingDay: row.billing_day == null ? undefined : Number(row.billing_day),
  }));
}

const getState = async () => ({ income: await listIncome(), expenses: await listExpenses() });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  if (body == null) return res.end();
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // ---- static ----
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return send(res, 200, fs.readFileSync(INDEX_PATH), 'text/html; charset=utf-8');
  }

  // ---- health check (for Render) ----
  if (method === 'GET' && pathname === '/healthz') {
    return send(res, 200, { ok: true });
  }

  // ---- api: full state ----
  if (pathname === '/api/state' && method === 'GET') {
    return send(res, 200, await getState());
  }

  // ---- api: income ----
  if (pathname === '/api/income' && method === 'POST') {
    const body = await readBody(req);
    await db.execute({
      sql: 'INSERT INTO income_sources (id, name, amount) VALUES (?, ?, ?)',
      args: [newId(), body.name || 'Новый источник', Number(body.amount) || 0],
    });
    return send(res, 200, await getState());
  }

  const incMatch = pathname.match(/^\/api\/income\/([^/]+)$/);
  if (incMatch) {
    const id = incMatch[1];
    if (method === 'PATCH') {
      const body = await readBody(req);
      if ('name' in body) {
        await db.execute({
          sql: 'UPDATE income_sources SET name = ? WHERE id = ?',
          args: [String(body.name ?? ''), id],
        });
      }
      if ('amount' in body) {
        await db.execute({
          sql: 'UPDATE income_sources SET amount = ? WHERE id = ?',
          args: [Number(body.amount) || 0, id],
        });
      }
      return send(res, 200, await getState());
    }
    if (method === 'DELETE') {
      await db.execute({ sql: 'DELETE FROM income_sources WHERE id = ?', args: [id] });
      return send(res, 200, await getState());
    }
  }

  // ---- api: expenses ----
  if (pathname === '/api/expenses' && method === 'POST') {
    const body = await readBody(req);
    await db.execute({
      sql: 'INSERT INTO expenses (id, amount, category, date, description, is_recurring, billing_day) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [
        newId(),
        Number(body.amount) || 0,
        String(body.category || 'other'),
        String(body.date || todayISO()),
        String(body.description || ''),
        body.isRecurring ? 1 : 0,
        body.isRecurring ? (Number(body.billingDay) || 1) : null,
      ],
    });
    return send(res, 200, await getState());
  }

  const expMatch = pathname.match(/^\/api\/expenses\/([^/]+)$/);
  if (expMatch && method === 'DELETE') {
    await db.execute({ sql: 'DELETE FROM expenses WHERE id = ?', args: [expMatch[1]] });
    return send(res, 200, await getState());
  }

  send(res, 404, { error: 'Not found' });
}

init()
  .then(() => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        console.error(err);
        send(res, 500, { error: String(err.message || err) });
      });
    });
    server.listen(PORT, () => {
      const mode = process.env.TURSO_DATABASE_URL ? 'Turso (cloud)' : 'локальный файл data.sqlite';
      console.log(`✓ Финансовый трекер запущен:  http://localhost:${PORT}`);
      console.log(`✓ Хранилище:                  ${mode}`);
    });
  })
  .catch((err) => {
    console.error('✗ Не удалось запустить сервер:', err);
    process.exit(1);
  });
