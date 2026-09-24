#!/usr/bin/env node
/*
 * سرور NET NELI
 * -------------------------------------------------------------------------
 * یک سرور تک‌فایلی با Node.js خالص (بدون هیچ پکیج npm) که دقیقاً همان API
 * را پیاده می‌کند که فایل net-neli.html از طریق CONFIG.serverURL انتظارش
 * را دارد: احراز هویت، چت خصوصی/گروهی، تماس صوتی (سیگنالینگ)، چت عمومی،
 * اتاق صوتی، ویدیوهای کوتاه، موزیک، بازی‌ها، استیکر و پنل مدیریت.
 *
 * اجرا:
 *   node server.js
 * یا با پورت دلخواه:
 *   PORT=3000 node server.js
 *
 * همین فایل خودِ net-neli.html را هم سرو می‌کند (در ریشه‌ی همین پوشه با
 * همان اسم قرار بده)، بنابراین کافی است آدرس سرور را در مرورگر باز کنی؛
 * صفحه به‌طور خودکار همین آدرس را به‌عنوان سرور تشخیص می‌دهد.
 *
 * داده‌ها در یک فایل JSON (db.json) و فایل‌های آپلودی در پوشه‌ی uploads/
 * نگه‌داری می‌شوند. برای استفاده‌ی واقعی، این پوشه را جایی دائمی (نه یک
 * فایل‌سیستم موقت) نگه دار.
 * ------------------------------------------------------------------------- */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ============================== تنظیمات ============================== */

const PORT = parseInt(process.env.PORT, 10) || 8787;
const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'db.json');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const HTML_CANDIDATES = ['net-neli.html', 'index.html'];

/* حداکثر حجم مجاز آپلود بر حسب نوع (بایت) — با KIND_MAX سمت کلاینت هماهنگ
   است؛ برای «فایل» به‌جای ۵ گیگ، یک سقف معقول برای میزبانی‌های معمولی
   گذاشته شده؛ اگر هاست بزرگ‌تری داری، این عدد را زیاد کن. */
const MAX_UPLOAD = {
  photo: 10 * 1024 * 1024,
  voice: 100 * 1024 * 1024,
  file: 300 * 1024 * 1024,
  default: 50 * 1024 * 1024
};
const MAX_JSON_BODY = 2 * 1024 * 1024;        /* بدنه‌ی JSON معمولی */
const MAX_B64_BODY = 400 * 1024 * 1024;       /* برای رله‌ی base64 */

const HANDLE_RE = /^[a-z0-9_]{4,10}$/;
const STICKER_CODE_RE = /^[a-z0-9]{2,10}$/;
const ROOM_STALE_MS = 15000;                  /* بعد این‌قدر بی‌خبری، عضو اتاق حذف می‌شود */
const ROOM_MAX_MEMBERS = 12;

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav',
  'audio/ogg': 'ogg', 'audio/webm': 'weba', 'video/mp4': 'mp4', 'video/webm': 'webm',
  'application/pdf': 'pdf', 'application/zip': 'zip'
};

/* ============================== دیتابیس (JSON) ============================== */

function emptyDb() {
  return {
    users: {},        /* handle -> user doc (شامل salt/hash که هرگز به کلاینت فرستاده نمی‌شود) */
    tokens: {},        /* token  -> handle */
    chats: {},         /* chatId -> {members,title,owner,names,messages,updated} */
    calls: {},         /* handle -> [{from,data,t}] صندوق پیام سیگنالینگ تماس */
    pub: [],           /* [{f,n,x,t}] چت عمومی */
    rooms: {},         /* roomId -> { handle: lastSeenTs } */
    videos: [],        /* [{id,url,caption,by,views,likes:[],comments:[],created}] */
    music: [],         /* [{id,url,title,by,created}] */
    musicPlayed: {},   /* handle -> [id,...] */
    games: [],         /* [{id,name,platform,note,by,created}] */
    stickers: []       /* [{id,code,url,title,by}] */
  };
}

let db = loadDb();
let saveTimer = null;

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Object.assign(emptyDb(), parsed);
  } catch (e) {
    return emptyDb();
  }
}

function save() {
  /* نوشتن را کمی جمع می‌کنیم تا زیر بار زیاد، فایل را مدام روی دیسک ننویسیم */
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('db save failed:', e);
    }
  }, 150);
}

/* حفظ فوری هنگام خاموش شدن سرور */
function saveSync() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {}
}
process.on('SIGINT', function () { saveSync(); process.exit(0); });
process.on('SIGTERM', function () { saveSync(); process.exit(0); });

/* ============================== ابزارهای کمکی ============================== */

function rnd(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function makeCredential(password) {
  const salt = rnd(32);
  return { salt: salt, hash: hashPassword(password, salt) };
}

function checkPassword(user, password) {
  if (!user || !user.salt || !user.hash) return false;
  const h = hashPassword(password, user.salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(user.hash, 'hex'));
  } catch (e) { return false; }
}

function newToken(handle) {
  const token = rnd(48);
  db.tokens[token] = handle;
  return token;
}

/* نسخه‌ی «عمومی» کاربر که به کلاینت فرستاده می‌شود (بدون رمز/سالت) */
function publicUser(u) {
  if (!u) return null;
  return {
    handle: u.handle, name: u.name || u.handle, photo: u.photo || '', color: u.color || '',
    bio: u.bio || '', orientation: u.orientation || '', sticker: u.sticker || '',
    gender: u.gender || '', rank: u.rank || '', banned: !!u.banned,
    friends: Array.isArray(u.friends) ? u.friends.slice() : [],
    warnCount: Array.isArray(u.warnings) ? u.warnings.length : 0
  };
}

function isMember(chat, handle) {
  return !!(chat && Array.isArray(chat.members) && chat.members.indexOf(handle) >= 0);
}

/* احراز هویت actor/token که کلاینت در هر درخواست نویسنده اضافه می‌کند */
function authFromBody(body) {
  const actor = body && body.actor;
  const token = body && body.token;
  if (!actor || !token) return null;
  if (db.tokens[token] !== actor) return null;
  if (!db.users[actor]) return null;
  return actor;
}

function isAdmin(handle) {
  const u = db.users[handle];
  return !!(u && (u.rank === 'admin' || u.rank === 'owner'));
}
function isOwner(handle) {
  const u = db.users[handle];
  return !!(u && u.rank === 'owner');
}

/* ============================== HTTP: ابزار پاسخ ============================== */

function sendJSON(res, status, obj) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}
function sendOk(res, extra) { sendJSON(res, 200, Object.assign({ ok: true }, extra || {})); }
function sendFail(res, status, reason, extra) {
  sendJSON(res, status, Object.assign({ ok: false, reason: reason }, extra || {}));
}
function sendNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end('null');
}

function readJsonBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) { reject(new Error('too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}

/* ============================== سرو فایل استاتیک ============================== */

function findHtmlFile() {
  for (let i = 0; i < HTML_CANDIDATES.length; i++) {
    const p = path.join(ROOT, HTML_CANDIDATES[i]);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function serveStaticFile(res, filePath, mime) {
  fs.readFile(filePath, function (err, data) {
    if (err) { sendNotFound(res); return; }
    res.writeHead(200, { 'Content-Type': mime || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  });
}

function serveUpload(res, pathname) {
  /* pathname مثل /uploads/photo/abc123.jpg */
  const rel = pathname.replace(/^\/+/, '');
  const full = path.join(ROOT, rel);
  if (full.indexOf(UPLOAD_DIR) !== 0) { sendNotFound(res); return; }
  const ext = path.extname(full).slice(1).toLowerCase();
  const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', weba: 'audio/webm',
    mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', zip: 'application/zip' };
  fs.stat(full, function (err, st) {
    if (err || !st.isFile()) { sendNotFound(res); return; }
    res.writeHead(200, {
      'Content-Type': mimeMap[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(full).pipe(res);
  });
}

/* ============================== آپلود فایل ============================== */

function safeKindDir(kind) {
  const k = String(kind || 'file').toLowerCase().replace(/[^a-z]/g, '');
  return ['photo', 'voice', 'file'].indexOf(k) >= 0 ? k : 'file';
}
function extFromNameOrMime(filename, mime) {
  const fromName = filename ? path.extname(String(filename)).replace('.', '').toLowerCase() : '';
  if (fromName && /^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  return MIME_EXT[mime] || 'bin';
}
function ensureUploadDir(kindDir) {
  const dir = path.join(UPLOAD_DIR, kindDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* آپلود مستقیم (XHR): بدنه‌ی خام فایل + هدرهای X-Kind/X-Filename/X-Mime/X-Actor/X-Token */
function handleRawUpload(req, res) {
  const actor = req.headers['x-actor'] || '';
  const token = req.headers['x-token'] || '';
  if (!actor || !token || db.tokens[token] !== actor || !db.users[actor]) {
    sendJSON(res, 403, { ok: false, error: 'auth' }); req.resume(); return;
  }
  if (db.users[actor].banned) { sendJSON(res, 403, { ok: false, error: 'banned' }); req.resume(); return; }
  const kindDir = safeKindDir(req.headers['x-kind']);
  const mime = String(req.headers['x-mime'] || 'application/octet-stream');
  let filename = '';
  try { filename = decodeURIComponent(req.headers['x-filename'] || ''); } catch (e) {}
  const limit = MAX_UPLOAD[kindDir] || MAX_UPLOAD.default;
  const ext = extFromNameOrMime(filename, mime);
  const id = Date.now().toString(36) + '_' + rnd(12);
  const dir = ensureUploadDir(kindDir);
  const full = path.join(dir, id + '.' + ext);
  const ws = fs.createWriteStream(full);
  let size = 0, failed = false;

  req.on('data', function (chunk) {
    size += chunk.length;
    if (size > limit) {
      failed = true;
      req.unpipe(ws); ws.destroy(); req.destroy();
      fs.unlink(full, function () {});
      sendJSON(res, 413, { ok: false, error: 'too-large' });
    }
  });
  req.on('error', function () { if (!failed) { failed = true; ws.destroy(); fs.unlink(full, function () {}); } });
  ws.on('error', function () { if (!failed) { failed = true; sendJSON(res, 500, { ok: false, error: 'write-failed' }); } });
  ws.on('finish', function () {
    if (failed) return;
    const url = '/uploads/' + kindDir + '/' + id + '.' + ext;
    sendJSON(res, 200, { ok: true, url: url, mime: mime, size: size });
  });
  req.pipe(ws);
}

/* آپلود از طریق رله‌ی JSON (base64) — برای وقتی مسیر مستقیم فیلتر است */
function handleB64Upload(body, res) {
  const actor = authFromBody(body);
  if (!actor) return sendJSON(res, 403, { ok: false, error: 'auth' });
  if (db.users[actor].banned) return sendJSON(res, 403, { ok: false, error: 'banned' });
  const kindDir = safeKindDir(body.kind);
  const mime = String(body.mime || 'application/octet-stream');
  const filename = String(body.filename || '');
  let buf;
  try { buf = Buffer.from(String(body.data || ''), 'base64'); }
  catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad-data' }); }
  const limit = MAX_UPLOAD[kindDir] || MAX_UPLOAD.default;
  if (buf.length > limit) return sendJSON(res, 413, { ok: false, error: 'too-large' });
  const ext = extFromNameOrMime(filename, mime);
  const id = Date.now().toString(36) + '_' + rnd(12);
  const dir = ensureUploadDir(kindDir);
  const full = path.join(dir, id + '.' + ext);
  fs.writeFile(full, buf, function (err) {
    if (err) return sendJSON(res, 500, { ok: false, error: 'write-failed' });
    const url = '/uploads/' + kindDir + '/' + id + '.' + ext;
    sendJSON(res, 200, { ok: true, url: url, mime: mime, size: buf.length });
  });
}

/* ============================== doc / collection عمومی ============================== */

function splitPath(p) {
  const parts = p.split('/').filter(Boolean).map(function (s) { try { return decodeURIComponent(s); } catch (e) { return s; } });
  const col = parts[0];
  const id = parts.slice(1).join('/');
  return { col: col, id: id };
}

function getDoc(col, id) {
  return db[col] && Object.prototype.hasOwnProperty.call(db[col], id) ? db[col][id] : undefined;
}

function handleDocGet(res, col, id) {
  const d = getDoc(col, id);
  if (d === undefined) return sendNotFound(res);
  /* هرگز رمز/سالت کاربر را در پاسخ عمومی doc نفرست؛ فقط فیلدهای عمومی */
  sendJSON(res, 200, col === 'users' ? publicUser(d) : d);
}

function handleDocPut(body, res, col, id) {
  const data = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(data);
  if (col === 'users') {
    if (!actor || actor !== id) return sendFail(res, 403, 'forbidden');
  } else if (col === 'chats') {
    if (!actor) return sendFail(res, 403, 'forbidden');
    const members = Array.isArray(data.members) ? data.members : [];
    if (members.indexOf(actor) < 0) return sendFail(res, 403, 'forbidden');
  } else {
    return sendFail(res, 400, 'bad-collection');
  }
  db[col] = db[col] || {};
  const clean = Object.assign({}, data);
  delete clean.actor; delete clean.token;
  db[col][id] = clean;
  save();
  sendOk(res);
}

function handleDocPatch(body, res, col, id) {
  const upd = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(upd);
  const cur = getDoc(col, id);
  if (cur === undefined) return sendFail(res, 404, 'not-found');
  if (col === 'users') {
    if (!actor || actor !== id) return sendFail(res, 403, 'forbidden');
  } else if (col === 'chats') {
    if (!actor || !isMember(cur, actor)) return sendFail(res, 403, 'forbidden');
  } else {
    return sendFail(res, 400, 'bad-collection');
  }
  const clean = Object.assign({}, upd);
  delete clean.actor; delete clean.token;
  Object.assign(cur, clean);
  db[col][id] = cur;
  save();
  sendOk(res);
}

function handleCreate(body, res, colId) {
  const sp = splitPath(colId);
  const data = body && typeof body === 'object' ? body : {};
  db[sp.col] = db[sp.col] || {};
  if (Object.prototype.hasOwnProperty.call(db[sp.col], sp.id)) return sendJSON(res, 200, { ok: false });
  const clean = Object.assign({}, data); delete clean.actor; delete clean.token;
  db[sp.col][sp.id] = clean;
  save();
  sendJSON(res, 200, { ok: true });
}

function matchesFilter(value, f) {
  if (f.op === '>=') return value != null && value >= f.value;
  if (f.op === '<=') return value != null && value <= f.value;
  if (f.op === '==') return value === f.value;
  if (f.op === 'array-contains') return Array.isArray(value) && value.indexOf(f.value) >= 0;
  return true;
}

function handleQuery(body, res, col) {
  const q = body && typeof body === 'object' ? body : {};
  const filters = Array.isArray(q.filters) ? q.filters : [];
  const actor = authFromBody(q);
  const store = db[col] || {};
  let rows = Object.keys(store).map(function (id) { return { id: id, data: store[id] }; });

  if (col === 'chats') {
    /* حریم خصوصی: صرف‌نظر از فیلترهای رسیده، فقط چت‌های خودِ actor برگردد */
    if (!actor) return sendJSON(res, 200, []);
    rows = rows.filter(function (r) { return isMember(r.data, actor); });
  }

  rows = rows.filter(function (r) {
    return filters.every(function (f) { return matchesFilter(r.data ? r.data[f.field] : undefined, f); });
  });
  if (q.limit) rows = rows.slice(0, q.limit);
  sendJSON(res, 200, rows);
}

/* ============================== append پیام چت (اتمیک) ============================== */

function handleAppendChat(body, res, chatId) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor || actor !== b.from) return sendFail(res, 403, 'forbidden');
  if (db.users[actor].banned) return sendFail(res, 403, 'banned');

  let chat = db.chats[chatId];
  if (!chat) {
    if (!Array.isArray(b.members) || b.members.indexOf(actor) < 0) return sendFail(res, 404, 'not-found');
    chat = { members: b.members.slice(), title: null, owner: null, names: {}, messages: [], updated: Date.now() };
    db.chats[chatId] = chat;
  } else if (!isMember(chat, actor)) {
    return sendFail(res, 403, 'forbidden');
  }

  if (b.members) {
    b.members.forEach(function (h) { if (chat.members.indexOf(h) < 0) chat.members.push(h); });
  }
  chat.names = chat.names || {};
  if (b.names) Object.assign(chat.names, b.names);
  if (b.name) chat.names[actor] = b.name;

  const msg = { f: actor, x: String(b.x || ''), t: Date.now() };
  if (b.kind) { msg.kind = b.kind; msg.url = b.url || ''; msg.fname = b.fname || ''; msg.mime = b.mime || ''; msg.size = b.size || 0; }
  chat.messages = (chat.messages || []).concat([msg]).slice(-10000);
  chat.updated = Date.now();
  save();
  sendOk(res);
}

/* ============================== rename (تغییر آیدی) ============================== */

function handleRename(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  const from = b.from, to = String(b.to || '').toLowerCase();
  if (!actor || actor !== from) return sendFail(res, 403, 'forbidden');
  if (!HANDLE_RE.test(to)) return sendFail(res, 400, 'bad-handle');
  if (db.users[to]) return sendFail(res, 200, 'taken');
  if (!db.users[from]) return sendFail(res, 404, 'not-found');

  const user = db.users[from];
  user.handle = to;
  db.users[to] = user;
  delete db.users[from];

  Object.keys(db.tokens).forEach(function (tok) { if (db.tokens[tok] === from) db.tokens[tok] = to; });

  Object.keys(db.chats).forEach(function (cid) {
    const c = db.chats[cid];
    if (Array.isArray(c.members)) c.members = c.members.map(function (h) { return h === from ? to : h; });
    if (c.names && Object.prototype.hasOwnProperty.call(c.names, from)) { c.names[to] = c.names[from]; delete c.names[from]; }
    if (Array.isArray(c.messages)) c.messages.forEach(function (m) { if (m.f === from) m.f = to; });
    if (c.owner === from) c.owner = to;
  });

  if (db.calls[from]) { db.calls[to] = db.calls[from]; delete db.calls[from]; }
  if (db.musicPlayed[from]) { db.musicPlayed[to] = db.musicPlayed[from]; delete db.musicPlayed[from]; }
  db.pub.forEach(function (m) { if (m.f === from) m.f = to; });
  db.videos.forEach(function (v) {
    if (v.by === from) v.by = to;
    if (Array.isArray(v.likes)) v.likes = v.likes.map(function (h) { return h === from ? to : h; });
    if (Array.isArray(v.comments)) v.comments.forEach(function (c) { if (c.by === from) c.by = to; });
  });
  db.music.forEach(function (m) { if (m.by === from) m.by = to; });
  db.games.forEach(function (g) { if (g.by === from) g.by = to; });
  db.stickers.forEach(function (s) { if (s.by === from) s.by = to; });
  Object.keys(db.users).forEach(function (h) {
    const u = db.users[h];
    if (Array.isArray(u.friends)) u.friends = u.friends.map(function (x) { return x === from ? to : x; });
    if (Array.isArray(u.following)) u.following = u.following.map(function (x) { return x === from ? to : x; });
  });

  save();
  sendOk(res);
}

/* ============================== احراز هویت ============================== */

function handleSignup(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const handle = String(b.handle || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 24);
  const password = String(b.password || '');
  const gender = b.gender === 'male' || b.gender === 'female' ? b.gender : '';
  if (!HANDLE_RE.test(handle)) return sendFail(res, 200, 'bad-handle');
  if (!name) return sendFail(res, 200, 'bad-name');
  if (password.length < 6) return sendFail(res, 200, 'bad-password');
  if (db.users[handle]) return sendFail(res, 200, 'taken');

  const cred = makeCredential(password);
  const isFirstUser = Object.keys(db.users).length === 0;
  const user = {
    handle: handle, name: name, photo: '', color: '', bio: '', orientation: '', sticker: '',
    gender: gender, rank: isFirstUser ? 'owner' : '', banned: false, friends: [], following: [],
    warnings: [], salt: cred.salt, hash: cred.hash, created: Date.now()
  };
  db.users[handle] = user;
  const token = newToken(handle);
  save();
  sendJSON(res, 200, { ok: true, token: token, user: publicUser(user) });
}

function handleLogin(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const handle = String(b.handle || '').trim().toLowerCase();
  const password = String(b.password || '');
  const user = db.users[handle];
  if (!user) return sendFail(res, 200, 'not-found');
  if (!checkPassword(user, password)) return sendFail(res, 200, 'bad-cred');
  if (user.banned) return sendFail(res, 200, 'banned');
  const token = newToken(handle);
  save();
  sendJSON(res, 200, { ok: true, token: token, user: publicUser(user) });
}

function handleChangePassword(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const password = String(b.password || '');
  if (password.length < 6) return sendFail(res, 200, 'bad-password');
  const cred = makeCredential(password);
  db.users[actor].salt = cred.salt;
  db.users[actor].hash = cred.hash;
  const token = newToken(actor);
  save();
  sendJSON(res, 200, { ok: true, token: token });
}

/* ============================== تماس صوتی (سیگنالینگ) ============================== */

function handleCallSend(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const to = String(b.to || '');
  if (!db.users[to]) return sendFail(res, 404, 'not-found');
  db.calls[to] = db.calls[to] || [];
  db.calls[to].push({ from: actor, data: b.data || {}, t: Date.now() });
  if (db.calls[to].length > 50) db.calls[to] = db.calls[to].slice(-50);
  save();
  sendOk(res);
}

function handleCallPoll(body, res) {
  const actor = authFromBody(body || {});
  if (!actor) return sendJSON(res, 200, []);
  const items = db.calls[actor] || [];
  db.calls[actor] = [];
  /* حذف پیام‌های خیلی قدیمی (بیش از ۴۰ ثانیه) که دیگر معنایی ندارند */
  const fresh = items.filter(function (it) { return Date.now() - it.t < 40000; });
  save();
  sendJSON(res, 200, fresh);
}

/* ============================== چت عمومی ============================== */

function handlePubList(body, res) {
  sendJSON(res, 200, db.pub.slice(-200));
}
function handlePubSend(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  if (db.users[actor].banned) return sendFail(res, 403, 'banned');
  const x = String(b.x || '').trim().slice(0, 500);
  if (!x) return sendFail(res, 400, 'empty');
  db.pub.push({ f: actor, n: db.users[actor].name || actor, x: x, t: Date.now() });
  if (db.pub.length > 2000) db.pub = db.pub.slice(-2000);
  save();
  sendOk(res);
}

/* ============================== اتاق صوتی ============================== */

function pruneRoom(room) {
  const now = Date.now();
  Object.keys(room).forEach(function (h) { if (now - room[h] > ROOM_STALE_MS) delete room[h]; });
}

function handleRoomJoin(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const roomId = String(b.room || '');
  if (!roomId) return sendFail(res, 400, 'bad-room');
  db.rooms[roomId] = db.rooms[roomId] || {};
  const room = db.rooms[roomId];
  pruneRoom(room);
  const already = Object.prototype.hasOwnProperty.call(room, actor);
  if (!already && Object.keys(room).length >= ROOM_MAX_MEMBERS) return sendFail(res, 200, 'full');
  room[actor] = Date.now();
  const members = Object.keys(room).filter(function (h) { return h !== actor; });
  save();
  sendJSON(res, 200, { ok: true, members: members });
}
function handleRoomLeave(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const roomId = String(b.room || '');
  if (db.rooms[roomId]) {
    delete db.rooms[roomId][actor];
    if (!Object.keys(db.rooms[roomId]).length) delete db.rooms[roomId];
  }
  save();
  sendOk(res);
}

/* ============================== ویدیوهای کوتاه ============================== */

function videoView(v, actor) {
  const author = db.users[v.by];
  return {
    id: v.id, url: v.url, caption: v.caption || '', by: v.by,
    n: (author && author.name) || v.by,
    views: v.views || 0,
    likes: Array.isArray(v.likes) ? v.likes.length : 0,
    mine: !!(actor && Array.isArray(v.likes) && v.likes.indexOf(actor) >= 0),
    fol: !!(actor && db.users[actor] && Array.isArray(db.users[actor].following) && db.users[actor].following.indexOf(v.by) >= 0),
    cc: Array.isArray(v.comments) ? v.comments.length : 0
  };
}

function handleVideoList(body, res) {
  const actor = authFromBody(body || {});
  const list = db.videos.slice().sort(function (a, b2) { return b2.created - a.created; }).map(function (v) { return videoView(v, actor); });
  sendJSON(res, 200, { videos: list });
}
function handleVideoAdd(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  if (db.users[actor].banned) return sendFail(res, 403, 'banned');
  const url = String(b.url || '');
  if (!url) return sendFail(res, 400, 'bad-url');
  const v = { id: 'v_' + rnd(14), url: url, caption: String(b.caption || '').slice(0, 300), by: actor, views: 0, likes: [], comments: [], created: Date.now() };
  db.videos.unshift(v);
  save();
  sendJSON(res, 200, { ok: true, id: v.id });
}
function handleVideoDel(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const v = db.videos.find(function (x) { return x.id === b.id; });
  if (!v) return sendFail(res, 404, 'not-found');
  if (v.by !== actor && !isAdmin(actor)) return sendFail(res, 403, 'forbidden');
  db.videos = db.videos.filter(function (x) { return x.id !== b.id; });
  save();
  sendOk(res);
}
function handleVideoLike(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const v = db.videos.find(function (x) { return x.id === b.id; });
  if (!v) return sendFail(res, 404, 'not-found');
  v.likes = v.likes || [];
  const idx = v.likes.indexOf(actor);
  let liked;
  if (idx >= 0) { v.likes.splice(idx, 1); liked = false; } else { v.likes.push(actor); liked = true; }
  save();
  sendJSON(res, 200, { ok: true, liked: liked, likes: v.likes.length });
}
function handleVideoView(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const v = db.videos.find(function (x) { return x.id === b.id; });
  if (!v) return sendFail(res, 404, 'not-found');
  v.views = (v.views || 0) + 1;
  save();
  sendOk(res);
}
function handleVideoComments(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const v = db.videos.find(function (x) { return x.id === b.id; });
  if (!v) return sendJSON(res, 200, { comments: [] });
  sendJSON(res, 200, { comments: (v.comments || []).map(function (c) { return { id: c.id, by: c.by, x: c.x }; }) });
}
function handleVideoComment(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const v = db.videos.find(function (x) { return x.id === b.id; });
  if (!v) return sendFail(res, 404, 'not-found');
  const x = String(b.x || '').trim().slice(0, 300);
  if (!x) return sendFail(res, 400, 'empty');
  const comment = { id: 'c_' + rnd(12), by: actor, x: x, t: Date.now() };
  v.comments = v.comments || [];
  v.comments.push(comment);
  save();
  sendJSON(res, 200, { ok: true, comment: { id: comment.id, by: comment.by, x: comment.x }, count: v.comments.length });
}
function handleVideoCommentDel(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const v = db.videos.find(function (x) { return x.id === b.id; });
  if (!v) return sendFail(res, 404, 'not-found');
  const c = (v.comments || []).find(function (x) { return x.id === b.cid; });
  if (!c) return sendFail(res, 404, 'not-found');
  if (c.by !== actor && v.by !== actor && !isAdmin(actor)) return sendFail(res, 403, 'forbidden');
  v.comments = v.comments.filter(function (x) { return x.id !== b.cid; });
  save();
  sendJSON(res, 200, { ok: true, count: v.comments.length });
}
function handleVideoFollow(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const target = String(b.handle || '');
  if (!db.users[target] || target === actor) return sendFail(res, 400, 'bad-target');
  const u = db.users[actor];
  u.following = u.following || [];
  const idx = u.following.indexOf(target);
  let following;
  if (idx >= 0) { u.following.splice(idx, 1); following = false; } else { u.following.push(target); following = true; }
  save();
  sendJSON(res, 200, { ok: true, following: following });
}

/* ============================== موزیک ============================== */

function handleMusicList(body, res) {
  const actor = authFromBody(body || {});
  const tracks = db.music.slice().sort(function (a, b2) { return b2.created - a.created; }).map(function (m) {
    const author = db.users[m.by];
    return { id: m.id, url: m.url, title: m.title, by: m.by, n: (author && author.name) || m.by };
  });
  const played = actor ? (db.musicPlayed[actor] || []) : [];
  sendJSON(res, 200, { tracks: tracks, played: played });
}
function handleMusicAdd(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const url = String(b.url || '');
  if (!url) return sendFail(res, 400, 'bad-url');
  db.music.unshift({ id: 'm_' + rnd(14), url: url, title: String(b.title || '').slice(0, 120) || 'بی‌نام', by: actor, created: Date.now() });
  save();
  sendOk(res);
}
function handleMusicDel(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const m = db.music.find(function (x) { return x.id === b.id; });
  if (!m) return sendFail(res, 404, 'not-found');
  if (m.by !== actor && !isAdmin(actor)) return sendFail(res, 403, 'forbidden');
  db.music = db.music.filter(function (x) { return x.id !== b.id; });
  save();
  sendOk(res);
}
function handleMusicPlayed(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const id = String(b.id || '');
  const list = [id].concat((db.musicPlayed[actor] || []).filter(function (x) { return x !== id; })).slice(0, 100);
  db.musicPlayed[actor] = list;
  save();
  sendOk(res);
}

/* ============================== بازی‌ها ============================== */

function handleGamesList(body, res) {
  const list = db.games.slice().sort(function (a, b2) { return b2.created - a.created; }).map(function (g) {
    const author = db.users[g.by];
    return { id: g.id, name: g.name, platform: g.platform, note: g.note || '', by: g.by, n: (author && author.name) || g.by };
  });
  sendJSON(res, 200, { games: list });
}
function handleGamesAdd(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const name = String(b.name || '').trim().slice(0, 80);
  const platform = b.platform === 'mobile' ? 'mobile' : 'pc';
  if (!name) return sendFail(res, 400, 'bad-name');
  db.games.unshift({ id: 'g_' + rnd(14), name: name, platform: platform, note: String(b.note || '').slice(0, 300), by: actor, created: Date.now() });
  save();
  sendOk(res);
}
function handleGamesDel(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const g = db.games.find(function (x) { return x.id === b.id; });
  if (!g) return sendFail(res, 404, 'not-found');
  if (g.by !== actor && !isAdmin(actor)) return sendFail(res, 403, 'forbidden');
  db.games = db.games.filter(function (x) { return x.id !== b.id; });
  save();
  sendOk(res);
}

/* ============================== استیکر ============================== */

function handleStickerList(body, res) {
  sendJSON(res, 200, db.stickers.map(function (s) { return { id: s.id, code: s.code, url: s.url, title: s.title || '', by: s.by }; }));
}
function handleStickerAdd(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor || !isAdmin(actor)) return sendFail(res, 403, 'forbidden');
  const code = String(b.code || '').toLowerCase().trim();
  if (!STICKER_CODE_RE.test(code)) return sendFail(res, 400, 'bad-code');
  if (db.stickers.some(function (s) { return s.code === code; })) return sendFail(res, 200, 'taken');
  const s = { id: 'st_' + rnd(12), code: code, url: String(b.url || ''), title: String(b.title || '').slice(0, 60), by: actor };
  db.stickers.push(s);
  save();
  sendJSON(res, 200, { ok: true, id: s.id });
}
function handleStickerDel(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor) return sendFail(res, 403, 'forbidden');
  const s = db.stickers.find(function (x) { return x.id === b.id; });
  if (!s) return sendFail(res, 404, 'not-found');
  if (s.by !== actor && !isAdmin(actor)) return sendFail(res, 403, 'forbidden');
  db.stickers = db.stickers.filter(function (x) { return x.id !== b.id; });
  save();
  sendOk(res);
}

/* ============================== پنل مدیریت ============================== */

function handleAdminRank(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor || !isOwner(actor)) return sendFail(res, 403, 'forbidden');
  const target = String(b.target || '');
  const rank = b.rank === 'admin' ? 'admin' : '';
  const u = db.users[target];
  if (!u) return sendFail(res, 404, 'not-found');
  if (u.rank === 'owner') return sendFail(res, 403, 'forbidden');
  u.rank = rank;
  save();
  sendOk(res);
}
function handleAdminBan(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor || !isAdmin(actor)) return sendFail(res, 403, 'forbidden');
  const target = String(b.target || '');
  const u = db.users[target];
  if (!u) return sendFail(res, 404, 'not-found');
  if (u.rank === 'owner' || (u.rank === 'admin' && !isOwner(actor))) return sendFail(res, 403, 'forbidden');
  u.banned = !!b.banned;
  u.banReason = String(b.reason || '');
  save();
  sendOk(res);
}
function handleAdminWarn(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor || !isAdmin(actor)) return sendFail(res, 403, 'forbidden');
  const target = String(b.target || '');
  const u = db.users[target];
  if (!u) return sendFail(res, 404, 'not-found');
  const text = String(b.text || '').trim().slice(0, 300);
  if (!text) return sendFail(res, 400, 'empty');
  u.warnings = u.warnings || [];
  u.warnings.push({ text: text, by: actor, t: Date.now() });
  save();
  sendOk(res);
}
function handleAdminLookup(body, res) {
  const b = body && typeof body === 'object' ? body : {};
  const actor = authFromBody(b);
  if (!actor || !isAdmin(actor)) return sendJSON(res, 200, { error: 'forbidden' });
  const target = String(b.target || '');
  const u = db.users[target];
  if (!u) return sendJSON(res, 200, null);
  sendJSON(res, 200, publicUser(u));
}

/* ============================== مسیریابی اصلی ============================== */

const server = http.createServer(function (req, res) {
  let pathname;
  try { pathname = decodeURIComponent(req.url.split('?')[0]); } catch (e) { pathname = req.url.split('?')[0]; }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Kind, X-Filename, X-Mime, X-Actor, X-Token'
    });
    return res.end();
  }

  /* ---------- صفحه‌ی اصلی و فایل‌های آپلودی ---------- */
  if (pathname === '/' && req.method === 'GET') {
    const html = findHtmlFile();
    if (!html) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('net-neli.html پیدا نشد؛ آن را کنار server.js بگذار.'); }
    return serveStaticFile(res, html, 'text/html; charset=utf-8');
  }
  if (pathname.indexOf('/uploads/') === 0 && req.method === 'GET') {
    return serveUpload(res, pathname);
  }

  if (pathname.indexOf('/api/') !== 0) { sendNotFound(res); return; }

  /* ---------- GET ---------- */
  if (req.method === 'GET' && pathname === '/api/ping') return sendOk(res, { note: 'NET NELI server is up' });
  if (req.method === 'GET' && pathname.indexOf('/api/doc/') === 0) {
    const sp = splitPath(pathname.slice('/api/doc/'.length));
    if (sp.col !== 'users' && sp.col !== 'chats') return sendNotFound(res);
    return handleDocGet(res, sp.col, sp.id);
  }

  /* ---------- سایر متدها: بدنه‌ی JSON یا آپلود خام ---------- */
  if (pathname === '/api/upload' && req.method === 'POST') return handleRawUpload(req, res);

  const isB64 = pathname === '/api/upload-b64';
  readJsonBody(req, isB64 ? MAX_B64_BODY : MAX_JSON_BODY).then(function (body) {
    if (req.method === 'PUT' && pathname.indexOf('/api/doc/') === 0) {
      const sp = splitPath(pathname.slice('/api/doc/'.length));
      if (sp.col !== 'users' && sp.col !== 'chats') return sendFail(res, 400, 'bad-collection');
      return handleDocPut(body, res, sp.col, sp.id);
    }
    if (req.method === 'PATCH' && pathname.indexOf('/api/doc/') === 0) {
      const sp = splitPath(pathname.slice('/api/doc/'.length));
      if (sp.col !== 'users' && sp.col !== 'chats') return sendFail(res, 400, 'bad-collection');
      return handleDocPatch(body, res, sp.col, sp.id);
    }
    if (req.method === 'POST' && pathname.indexOf('/api/create/') === 0) {
      return handleCreate(body, res, pathname.slice('/api/create/'.length));
    }
    if (req.method === 'POST' && pathname.indexOf('/api/query/') === 0) {
      const col = pathname.slice('/api/query/'.length);
      if (col !== 'users' && col !== 'chats') return sendJSON(res, 200, []);
      return handleQuery(body, res, col);
    }
    if (req.method === 'POST' && pathname.indexOf('/api/append/chats/') === 0) {
      return handleAppendChat(body, res, pathname.slice('/api/append/chats/'.length));
    }
    if (req.method === 'POST' && pathname === '/api/rename') return handleRename(body, res);

    if (req.method === 'POST' && pathname === '/api/auth/signup') return handleSignup(body, res);
    if (req.method === 'POST' && pathname === '/api/auth/login') return handleLogin(body, res);
    if (req.method === 'POST' && pathname === '/api/auth/change-password') return handleChangePassword(body, res);

    if (req.method === 'POST' && pathname === '/api/upload-b64') return handleB64Upload(body, res);

    if (req.method === 'POST' && pathname === '/api/call/send') return handleCallSend(body, res);
    if (req.method === 'POST' && pathname === '/api/call/poll') return handleCallPoll(body, res);

    if (req.method === 'POST' && pathname === '/api/pub/list') return handlePubList(body, res);
    if (req.method === 'POST' && pathname === '/api/pub/send') return handlePubSend(body, res);

    if (req.method === 'POST' && pathname === '/api/room/join') return handleRoomJoin(body, res);
    if (req.method === 'POST' && pathname === '/api/room/leave') return handleRoomLeave(body, res);

    if (req.method === 'POST' && pathname === '/api/video/list') return handleVideoList(body, res);
    if (req.method === 'POST' && pathname === '/api/video/add') return handleVideoAdd(body, res);
    if (req.method === 'POST' && pathname === '/api/video/del') return handleVideoDel(body, res);
    if (req.method === 'POST' && pathname === '/api/video/like') return handleVideoLike(body, res);
    if (req.method === 'POST' && pathname === '/api/video/view') return handleVideoView(body, res);
    if (req.method === 'POST' && pathname === '/api/video/comments') return handleVideoComments(body, res);
    if (req.method === 'POST' && pathname === '/api/video/comment') return handleVideoComment(body, res);
    if (req.method === 'POST' && pathname === '/api/video/comment-del') return handleVideoCommentDel(body, res);
    if (req.method === 'POST' && pathname === '/api/video/follow') return handleVideoFollow(body, res);

    if (req.method === 'POST' && pathname === '/api/music/list') return handleMusicList(body, res);
    if (req.method === 'POST' && pathname === '/api/music/add') return handleMusicAdd(body, res);
    if (req.method === 'POST' && pathname === '/api/music/del') return handleMusicDel(body, res);
    if (req.method === 'POST' && pathname === '/api/music/played') return handleMusicPlayed(body, res);

    if (req.method === 'POST' && pathname === '/api/games/list') return handleGamesList(body, res);
    if (req.method === 'POST' && pathname === '/api/games/add') return handleGamesAdd(body, res);
    if (req.method === 'POST' && pathname === '/api/games/del') return handleGamesDel(body, res);

    if (req.method === 'POST' && pathname === '/api/sticker/list') return handleStickerList(body, res);
    if (req.method === 'POST' && pathname === '/api/sticker/add') return handleStickerAdd(body, res);
    if (req.method === 'POST' && pathname === '/api/sticker/del') return handleStickerDel(body, res);

    if (req.method === 'POST' && pathname === '/api/admin/rank') return handleAdminRank(body, res);
    if (req.method === 'POST' && pathname === '/api/admin/ban') return handleAdminBan(body, res);
    if (req.method === 'POST' && pathname === '/api/admin/warn') return handleAdminWarn(body, res);
    if (req.method === 'POST' && pathname === '/api/admin/lookup') return handleAdminLookup(body, res);

    sendNotFound(res);
  }).catch(function (err) {
    if (err && err.message === 'too-large') return sendJSON(res, 413, { ok: false, error: 'too-large' });
    sendJSON(res, 400, { ok: false, error: 'bad-request' });
  });
});

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
server.listen(PORT, function () {
  console.log('NET NELI server listening on http://localhost:' + PORT);
  console.log('db file: ' + DB_FILE);
  console.log('uploads dir: ' + UPLOAD_DIR);
  if (!findHtmlFile()) {
    console.log('⚠ فایل net-neli.html کنار server.js پیدا نشد. آن را در همین پوشه کپی کن تا صفحه از خودِ سرور سرو شود.');
  }
});
