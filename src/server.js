import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

process.umask(0o077);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ORIGIN = process.env.APP_ORIGIN || 'http://127.0.0.1:' + PORT;
const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'mood.sqlite');
const KEY_HEX = process.env.DATA_ENCRYPTION_KEY || '';
if (!/^[a-f0-9]{64}$/i.test(KEY_HEX)) {
  throw new Error('DATA_ENCRYPTION_KEY must be a 64-character hex key. See .env.example.');
}
if (PROD && (!ORIGIN.startsWith('https://') || !process.env.DATA_CONTROLLER || !process.env.PRIVACY_CONTACT)) {
  throw new Error('Production requires HTTPS APP_ORIGIN, DATA_CONTROLLER and PRIVACY_CONTACT.');
}
const KEY = Buffer.from(KEY_HEX, 'hex');
mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
db.exec([
  'CREATE TABLE IF NOT EXISTS users (',
  'id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,',
  'recovery_hash TEXT NOT NULL, consented_at TEXT NOT NULL, policy_version TEXT NOT NULL, created_at TEXT NOT NULL)',
  ';CREATE TABLE IF NOT EXISTS sessions (',
  'token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL)',
  ';CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
  ';CREATE TABLE IF NOT EXISTS entries (',
  'id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,',
  'occurred_at TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  ';CREATE INDEX IF NOT EXISTS idx_entries_user_time ON entries(user_id, occurred_at DESC)'
].join(' '));
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

const statements = {
  user: db.prepare('SELECT * FROM users WHERE username=?'),
  session: db.prepare('SELECT users.id,users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?'),
  all: db.prepare('SELECT * FROM entries WHERE user_id=? ORDER BY occurred_at DESC LIMIT 5000'),
  export: db.prepare('SELECT * FROM entries WHERE user_id=? ORDER BY occurred_at ASC'),
  one: db.prepare('SELECT * FROM entries WHERE id=? AND user_id=?')
};
const ipAttempts = new Map();
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex');
}
function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
const DUMMY_PASSWORD = passwordHash('not-an-existing-user-password');
function encrypted(userId, id, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  cipher.setAAD(Buffer.from(userId + ':' + id));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function decrypted(row) {
  const bytes = Buffer.from(row.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', KEY, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(row.user_id + ':' + row.id));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return {
    id: row.id, ...JSON.parse(Buffer.concat([
      decipher.update(bytes.subarray(28)), decipher.final()
    ]).toString('utf8')),
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function headers(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
function json(res, status, value, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(value));
}
function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function rate(key, maximum, windowMs) {
  const now = Date.now();
  if (ipAttempts.size > 10000) {
    for (const [k, v] of ipAttempts) if (now > v.until) ipAttempts.delete(k);
  }
  const record = ipAttempts.get(key);
  if (!record || now > record.until) {
    ipAttempts.set(key, { count: 1, until: now + windowMs });
  } else if (++record.count > maximum) {
    throw new HttpError(429, 'Слишком много попыток. Повторите позже.');
  }
}
function clientIp(req) {
  // X-Real-IP may only be trusted when a configured reverse proxy overwrites it.
  return process.env.TRUST_PROXY === '1' ? (req.headers['x-real-ip'] || req.socket.remoteAddress) : req.socket.remoteAddress;
}
function requireWrite(req) {
  if (req.headers.origin !== ORIGIN || req.headers['x-mood-client'] !== '1') {
    throw new HttpError(403, 'Запрос отклонён.');
  }
}
async function body(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Требуется JSON.');
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 24_000) throw new HttpError(413, 'Слишком длинная запись.');
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch { throw new HttpError(400, 'Некорректные данные.'); }
}
function cookie(req) {
  const match = /(?:^|;\s*)mood_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  return match?.[1] || '';
}
function loggedIn(req) {
  const token = cookie(req);
  if (!token) return null;
  return statements.session.get(hash(token), Date.now()) || null;
}
function auth(req) {
  const user = loggedIn(req);
  if (!user) throw new HttpError(401, 'Войдите в аккаунт.');
  return user;
}
function setSession(res, userId) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), userId, Date.now() + 7 * 86_400_000);
  res.setHeader('Set-Cookie', 'mood_session=' + token +
    '; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800' + (PROD ? '; Secure' : ''));
}
function clearSession(req, res) {
  const token = cookie(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
  res.setHeader('Set-Cookie', 'mood_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (PROD ? '; Secure' : ''));
}
function usernameValue(raw) {
  if (typeof raw !== 'string') throw new HttpError(400, 'Укажите псевдоним.');
  const value = raw.trim().normalize('NFKC').toLowerCase();
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(value)) {
    throw new HttpError(400, 'Псевдоним: 3–32 буквы, цифры, точка, дефис или подчёркивание.');
  }
  return value;
}
function newPassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw new HttpError(400, 'Пароль должен содержать от 12 до 128 символов.');
  }
  return value;
}
function numberScore(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    throw new HttpError(400, 'Неверное значение: ' + name);
  }
  return value;
}
function normalizeEntry(value) {
  const mood = value.mood;
  if (!Number.isInteger(mood) || mood < 1 || mood > 5) throw new HttpError(400, 'Выберите настроение.');
  const date = new Date(value.occurredAt);
  if (!value.occurredAt || !Number.isFinite(date.getTime()) ||
    date.getTime() > Date.now() + 86_400_000 || date.getTime() < Date.UTC(2000, 0, 1)) {
    throw new HttpError(400, 'Некорректная дата записи.');
  }
  const sleep = value.sleepHours === null || value.sleepHours === '' || value.sleepHours === undefined ?
    null : Number(value.sleepHours);
  if (sleep !== null && (!Number.isFinite(sleep) || sleep < 0 || sleep > 18 ||
    Math.round(sleep * 10) !== sleep * 10)) throw new HttpError(400, 'Проверьте часы сна.');
  if (!Array.isArray(value.tags) || value.tags.length > 12) throw new HttpError(400, 'Слишком много тегов.');
  const tags = [...new Set(value.tags.map(t => {
    if (typeof t !== 'string') throw new HttpError(400, 'Неверный тег.');
    const s = t.trim().replace(/\s+/g, ' ');
    if (!s || s.length > 32) throw new HttpError(400, 'Тег должен быть короче 33 символов.');
    return s;
  }))];
  const note = value.note ?? '';
  const medicationNote = value.medicationNote ?? '';
  if (typeof note !== 'string' || note.length > 2000 ||
      typeof medicationNote !== 'string' || medicationNote.length > 300) {
    throw new HttpError(400, 'Заметка слишком длинная.');
  }
  if (!['na', 'taken', 'missed'].includes(value.medication)) {
    throw new HttpError(400, 'Некорректная отметка о лекарствах.');
  }
  return {
    occurredAt: date.toISOString(), mood,
    anxiety: numberScore(value.anxiety, 'тревога', 0),
    lowMood: numberScore(value.lowMood, 'подавленность', 0),
    elevated: numberScore(value.elevated, 'возбуждение', 0),
    irritability: numberScore(value.irritability, 'раздражительность', 0),
    energy: numberScore(value.energy, 'энергия', 2),
    sleepHours: sleep, medication: value.medication, medicationNote: medicationNote.trim(),
    tags, note: note.trim()
  };
}
function exportRows(res, userId, format) {
  const rows = statements.export.all(userId).map(decrypted);
  if (format === 'json') {
    res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8',
      'Content-Disposition':'attachment; filename="mood-diary.json"' });
    return res.end(JSON.stringify({ exportedAt: new Date().toISOString(), formatVersion: 1, entries: rows }, null, 2));
  }
  if (format === 'csv') {
    const columns = ['occurredAt','mood','anxiety','lowMood','elevated','irritability','energy',
      'sleepHours','medication','medicationNote','tags','note'];
    const safe = v => {
      let s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
      if (/^[\s]*[=+@\-\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const csv = '\uFEFF' + columns.join(',') + '\r\n' +
      rows.map(row => columns.map(k => safe(row[k])).join(',')).join('\r\n');
    res.writeHead(200, { 'Content-Type':'text/csv; charset=utf-8',
      'Content-Disposition':'attachment; filename="mood-diary.csv"' });
    return res.end(csv);
  }
  throw new HttpError(400, 'Неизвестный формат.');
}
async function route(req, res) {
  headers(res);
  const url = new URL(req.url || '/', 'http://local');
  const pathname = url.pathname;
  if (pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, { ok: true });
  }
  if (pathname.startsWith('/api/')) {
    rate('api:' + clientIp(req), 240, 60_000);
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) throw new HttpError(405, 'Метод не поддерживается.');
    if (req.method !== 'GET') requireWrite(req);

    if (pathname === '/api/me' && req.method === 'GET') {
      return json(res, 200, { user: loggedIn(req) });
    }
    if (pathname === '/api/register' && req.method === 'POST') {
      rate('signup:' + clientIp(req), 10, 900_000);
      const input = await body(req);
      const username = usernameValue(input.username);
      const password = newPassword(input.password);
      if (input.consent !== true || input.adult !== true) {
        throw new HttpError(400, 'Необходимо подтвердить согласие и возраст 18+.');
      }
      if (statements.user.get(username)) throw new HttpError(409, 'Псевдоним уже занят.');
      const id = randomUUID();
      const recoveryCode = randomBytes(32).toString('base64url');
      const now = new Date().toISOString();
      try {
        db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(
          id, username, passwordHash(password), hash(recoveryCode), now, 'v1', now);
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) throw new HttpError(409, 'Псевдоним уже занят.');
        throw error;
      }
      setSession(res, id);
      return json(res, 201, { user: { id, username }, recoveryCode });
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const input = await body(req);
      const username = usernameValue(input.username);
      rate('login-ip:' + clientIp(req), 30, 900_000);
      rate('login-user:' + username, 15, 900_000);
      const user = statements.user.get(username);
      const valid = verifyPassword(String(input.password || ''), user?.password_hash || DUMMY_PASSWORD);
      if (!user || !valid) throw new HttpError(401, 'Неверный псевдоним или пароль.');
      setSession(res, user.id);
      return json(res, 200, { user: { id: user.id, username } });
    }
    if (pathname === '/api/recover' && req.method === 'POST') {
      const input = await body(req);
      const username = usernameValue(input.username);
      rate('recover-ip:' + clientIp(req), 10, 900_000);
      rate('recover-user:' + username, 6, 900_000);
      const password = newPassword(input.password);
      const user = statements.user.get(username);
      if (!user || typeof input.recoveryCode !== 'string' ||
        input.recoveryCode.length !== 43 ||
        !timingSafeEqual(Buffer.from(hash(input.recoveryCode)), Buffer.from(user.recovery_hash))) {
        throw new HttpError(401, 'Неверные данные восстановления.');
      }
      const replacementCode = randomBytes(32).toString('base64url');
      db.prepare('UPDATE users SET password_hash=?, recovery_hash=? WHERE id=?').run(
        passwordHash(password), hash(replacementCode), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      setSession(res, user.id);
      return json(res, 200, { user: { id: user.id, username }, recoveryCode: replacementCode });
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      clearSession(req, res);
      return json(res, 200, { ok: true });
    }
    const user = auth(req);
    if (pathname === '/api/entries' && req.method === 'GET') {
      return json(res, 200, { entries: statements.all.all(user.id).map(decrypted) });
    }
    if (pathname === '/api/entries' && req.method === 'POST') {
      const entry = normalizeEntry(await body(req));
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare('INSERT INTO entries VALUES (?,?,?,?,?,?)').run(
        id, user.id, entry.occurredAt, encrypted(user.id, id, entry), now, now);
      return json(res, 201, { entry: { id, ...entry, createdAt: now, updatedAt: now } });
    }
    const match = /^\/api\/entries\/([a-f0-9-]{36})$/.exec(pathname);
    if (match && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = match[1];
      if (!statements.one.get(id, user.id)) throw new HttpError(404, 'Запись не найдена.');
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM entries WHERE id=? AND user_id=?').run(id, user.id);
        return json(res, 200, { ok: true });
      }
      const entry = normalizeEntry(await body(req));
      const now = new Date().toISOString();
      db.prepare('UPDATE entries SET occurred_at=?,ciphertext=?,updated_at=? WHERE id=? AND user_id=?').run(
        entry.occurredAt, encrypted(user.id, id, entry), now, id, user.id);
      return json(res, 200, { entry: decrypted(statements.one.get(id, user.id)) });
    }
    if (pathname === '/api/export' && req.method === 'GET') {
      return exportRows(res, user.id, url.searchParams.get('format'));
    }
    if (pathname === '/api/account' && req.method === 'DELETE') {
      const input = await body(req);
      const account = statements.user.get(user.username);
      if (typeof input.password !== 'string' || !verifyPassword(input.password, account.password_hash)) {
        throw new HttpError(403, 'Неверный пароль.');
      }
      db.prepare('DELETE FROM users WHERE id=?').run(user.id);
      clearSession(req, res);
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Адрес не найден.');
  }
  if (req.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается.');
  if (pathname === '/privacy') {
    const controller = htmlEscape(process.env.DATA_CONTROLLER || 'Оператор сервиса (указывается при публикации)');
    const contact = htmlEscape(process.env.PRIVACY_CONTACT || 'Контакт будет указан до публичного запуска');
    const page = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>Приватность — Mood Atlas</title><main class="legal"><a href="/">← К дневнику</a><h1>О данных и приватности</h1>' +
      '<p><b>Оператор:</b> ' + controller + '. <b>Контакт:</b> ' + contact + '.</p>' +
      '<p>Сервис предназначен для добровольного самоотслеживания настроения совершеннолетними пользователями. Он не ставит диагнозы и не заменяет медицинскую помощь.</p>' +
      '<p>Мы храним псевдоним, хеш пароля, согласие, сессии, отметки настроения, сна, симптомов, факторов и заметки. Адрес электронной почты не требуется. Данные доступны через личный аккаунт, не публикуются и не продаются.</p>' +
      '<p>Записи шифруются на сервере AES-256-GCM; оператор серверной инфраструктуры технически может иметь доступ к ключу. Это не сквозное шифрование. Передача в публичной версии защищается HTTPS. Не вводите сведения третьих лиц.</p>' +
      '<p>Основание обработки чувствительных данных — ваше явное согласие при регистрации. Вы вправе выгрузить записи в JSON/CSV и удалить аккаунт с текущими записями в любой момент. Копии резервных данных удаляются в соответствии с отдельно опубликованным регламентом оператора.</p>' +
      '<p>Мы не используем рекламу, стороннюю аналитику и автоматическую передачу записей врачу. Если обработка осуществляется за пределами вашей страны, применимость местных требований должен определить оператор до запуска.</p>' +
      '<p><b>Важно:</b> До обработки реальных данных оператор должен дополнить эту информацию юридическим адресом, сроками хранения и резервного копирования, процедурами реализации прав субъекта данных и прочими обязательными сведениями.</p>' +
      '</main></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  const files = { '/':'index.html', '/index.html':'index.html', '/app.js':'app.js',
    '/styles.css':'styles.css', '/favicon.svg':'favicon.svg',
    '/manifest.webmanifest':'manifest.webmanifest',
    '/icons/icon-192.png':'icons/icon-192.png', '/icons/icon-512.png':'icons/icon-512.png' };
  if (!files[pathname]) throw new HttpError(404, 'Страница не найдена.');
  const file = join(ROOT, 'public', files[pathname]);
  const content = await readFile(file);
  const type = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' :
    pathname.endsWith('.svg') ? 'image/svg+xml' : pathname.endsWith('.png') ? 'image/png' :
    pathname.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html';
  res.writeHead(200, { 'Content-Type': type + (type === 'image/png' ? '' : '; charset=utf-8') });
  res.end(content);
}
const server = createServer((req, res) => {
  route(req, res).catch(error => {
    if (res.headersSent) return res.end();
    if (!(error instanceof HttpError)) {
      console.error('Request failed:', error?.message || 'unknown');
    }
    headers(res);
    json(res, error.status || 500, { error: error.status ? error.message : 'Внутренняя ошибка сервера.' });
  });
});
server.listen(PORT, HOST, () => {
  console.log('Mood Atlas listening on ' + HOST + ':' + PORT);
});
process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));
