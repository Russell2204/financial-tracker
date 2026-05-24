// Локальный сервер для финансового трекера.
// Хранит данные в SQLite-файле data.sqlite рядом с этим файлом.
// Запуск: node server.js  →  http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const PORT = Number(process.env.PORT) || 3030;
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data.sqlite');
const INDEX_PATH = path.join(ROOT, 'index.html');

let db;

const newId = () => crypto.randomUUID();
const currentMonth = () => new Date().toISOString().slice(0, 7);
const todayISO = () => new Date().toISOString().slice(0, 10);

async function init() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS income_sources (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      amount      REAL NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id            TEXT PRIMARY KEY,
      amount        REAL NOT NULL,
      category      TEXT NOT NULL,
      date          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      is_recurring  INTEGER NOT NULL DEFAULT 0,
      billing_day   INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  seedIfEmpty();
  persist();
}

function persist() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function seedIfEmpty() {
  const r = db.exec('SELECT COUNT(*) FROM income_sources');
  const count = r[0].values[0][0];
  if (count > 0) return;

  const incomeSeed = [
    ['Основная работа', 15000000],
    ['Фриланс',          4500000],
    ['Дивиденды',         800000],
  ];
  for (const [name, amount] of incomeSeed) {
    db.run('INSERT INTO income_sources (id, name, amount) VALUES (?, ?, ?)', [newId(), name, amount]);
  }

  const m = currentMonth();
  const expSeed = [
    [5000000, 'rent',          `${m}-05`, 'Квартира',            1, 5   ],
    [ 750000, 'utilities',     `${m}-10`, 'Свет и вода',         0, null],
    [ 199000, 'subscriptions', `${m}-15`, 'Стриминг',            1, 15  ],
    [1850000, 'groceries',     `${m}-12`, 'Продукты на неделю',  0, null],
  ];
  for (const [amount, category, date, description, isRecurring, billingDay] of expSeed) {
    db.run(
      'INSERT INTO expenses (id, amount, category, date, description, is_recurring, billing_day) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), amount, category, date, description, isRecurring, billingDay]
    );
  }
}

function listIncome() {
  const r = db.exec('SELECT id, name, amount FROM income_sources ORDER BY created_at ASC');
  if (r.length === 0) return [];
  return r[0].values.map(([id, name, amount]) => ({ id, name, amount }));
}

function listExpenses() {
  const r = db.exec(
    'SELECT id, amount, category, date, description, is_recurring, billing_day FROM expenses ORDER BY date DESC, created_at DESC'
  );
  if (r.length === 0) return [];
  return r[0].values.map(([id, amount, category, date, description, is_recurring, billing_day]) => ({
    id,
    amount,
    category,
    date,
    description,
    isRecurring: !!is_recurring,
    billingDay: billing_day == null ? undefined : billing_day,
  }));
}

const getState = () => ({ income: listIncome(), expenses: listExpenses() });

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

  // ---- api: full state ----
  if (pathname === '/api/state' && method === 'GET') {
    return send(res, 200, getState());
  }

  // ---- api: income ----
  if (pathname === '/api/income' && method === 'POST') {
    const body = await readBody(req);
    db.run(
      'INSERT INTO income_sources (id, name, amount) VALUES (?, ?, ?)',
      [newId(), body.name || 'Новый источник', Number(body.amount) || 0]
    );
    persist();
    return send(res, 200, getState());
  }

  const incMatch = pathname.match(/^\/api\/income\/([^/]+)$/);
  if (incMatch) {
    const id = incMatch[1];
    if (method === 'PATCH') {
      const body = await readBody(req);
      if ('name' in body)   db.run('UPDATE income_sources SET name = ? WHERE id = ?',   [String(body.name ?? ''), id]);
      if ('amount' in body) db.run('UPDATE income_sources SET amount = ? WHERE id = ?', [Number(body.amount) || 0, id]);
      persist();
      return send(res, 200, getState());
    }
    if (method === 'DELETE') {
      db.run('DELETE FROM income_sources WHERE id = ?', [id]);
      persist();
      return send(res, 200, getState());
    }
  }

  // ---- api: expenses ----
  if (pathname === '/api/expenses' && method === 'POST') {
    const body = await readBody(req);
    db.run(
      'INSERT INTO expenses (id, amount, category, date, description, is_recurring, billing_day) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        newId(),
        Number(body.amount) || 0,
        String(body.category || 'other'),
        String(body.date || todayISO()),
        String(body.description || ''),
        body.isRecurring ? 1 : 0,
        body.isRecurring ? (Number(body.billingDay) || 1) : null,
      ]
    );
    persist();
    return send(res, 200, getState());
  }

  const expMatch = pathname.match(/^\/api\/expenses\/([^/]+)$/);
  if (expMatch && method === 'DELETE') {
    db.run('DELETE FROM expenses WHERE id = ?', [expMatch[1]]);
    persist();
    return send(res, 200, getState());
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
      console.log(`✓ Финансовый трекер запущен:  http://localhost:${PORT}`);
      console.log(`✓ База данных:                ${DB_PATH}`);
    });
  })
  .catch((err) => {
    console.error('✗ Не удалось запустить сервер:', err);
    process.exit(1);
  });
