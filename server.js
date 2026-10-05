require('dotenv').config();

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
// 生产环境建议 127.0.0.1 + Nginx 反代；局域网调试可设 LISTEN_HOST=0.0.0.0
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';

// 统一 Nginx 子路径（如 /home）时由 deploy 写入；与 location /home/ 对应
const rawBase = (process.env.HOMEPORTAL_BASE_PATH || '').trim();
const BASE_PATH = rawBase.replace(/\/+$/, '') || '';

const DATA_FILE      = path.join(__dirname, 'data', 'services.json');
const JWT_SECRET     = String(process.env.JWT_SECRET ?? '').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD ?? '').trim();
const PORTAL_TITLE   = String(process.env.PORTAL_TITLE   ?? '指引页').trim() || '指引页';

// 登录限流：全局计数（Node 在 Cloudflare + Nginx 之后拿不到可信的客户端 IP），窗口内失败这么多次就整体锁住
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;

// 密钥 / 密码没配或还是仓库里出现过的示例值：直接拒绝启动，不带着可被猜到的凭据上线
const KNOWN_WEAK = new Set(['', 'rainy', 'homeportal-secret-change-me', 'change-me-to-a-random-secret-string']);
if (KNOWN_WEAK.has(JWT_SECRET) || JWT_SECRET.length < 32) {
  console.error('✖ JWT_SECRET 未设置或太弱：在 .env 里写一个 ≥32 位的随机串（openssl rand -hex 32）');
  process.exit(1);
}
if (KNOWN_WEAK.has(ADMIN_PASSWORD) || ADMIN_PASSWORD.length < 8) {
  console.error('✖ ADMIN_PASSWORD 未设置或太弱：在 .env 里写一个 ≥8 位、不是示例值的密码');
  process.exit(1);
}

const r = express.Router();
const publicDir = path.join(__dirname, 'public');

// 直接打开 /admin.html 时重定向到 /#admin（地址栏显示哈希路由）；?embed=1 供首页 iframe 嵌入，避免重定向死循环
r.get('/admin.html', (req, res) => {
  if (req.query.embed === '1' || req.query.embed === 'true') {
    return res.sendFile(path.join(publicDir, 'admin.html'));
  }
  const prefix = BASE_PATH || '';
  res.redirect(302, prefix ? `${prefix}/#admin` : '/#admin');
});

r.use(express.static(publicDir));

// 封面意象（首页 shader 的形态）；空 = 按名称 / 简介自动判断
const MOTIF_IDS = new Set(['flow', 'exchange', 'strata', 'ripple', 'steps']);

// ── Data helpers ──────────────────────────────────────────────────────────────

function ensureData() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf-8');
}

function load() {
  ensureData();
  // 解析失败直接抛：吞掉返回 [] 的话，下一次保存会把整份数据覆盖成空
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function save(services) {
  ensureData();
  fs.writeFileSync(DATA_FILE, JSON.stringify(services, null, 2), 'utf-8');
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: '未授权' });
  try {
    jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'Token 无效或已过期' });
  }
}

// ── Input ─────────────────────────────────────────────────────────────────────

class BadInput extends Error {}
const str = (v, field, max = 500) => {
  if (v == null) return '';
  if (typeof v !== 'string') throw new BadInput(`${field} 必须是字符串`);
  const t = v.trim();
  if (t.length > max) throw new BadInput(`${field} 太长`);
  return t;
};

// 只收白名单字段并校验类型；url 只认 http(s)，挡住 javascript: 之类会在首页「打开」按钮上执行的地址
function normalize(body) {
  const b = body || {};
  const out = {
    name:        str(b.name, 'name', 100),
    url:         str(b.url, 'url', 2000),
    displayUrl:  str(b.displayUrl, 'displayUrl', 200),
    description: str(b.description, 'description', 1000),
    icon:        str(b.icon, 'icon', 200),
    color:       str(b.color, 'color', 7),   // 空 = 自动：首页封面高光走类型色
    tags:        b.tags == null ? [] : b.tags,
    status:      b.status == null ? 'active' : b.status,
    motif:       MOTIF_IDS.has(b.motif) ? b.motif : '',
  };
  if (!out.name || !out.url) throw new BadInput('name 和 url 为必填项');
  let u;
  try { u = new URL(out.url); } catch { throw new BadInput('url 不是合法地址'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BadInput('url 只支持 http / https');
  if (out.color && !/^#[0-9a-f]{6}$/i.test(out.color)) throw new BadInput('color 必须是 #rrggbb');
  if (!Array.isArray(out.tags) || out.tags.length > 20) throw new BadInput('tags 必须是数组（最多 20 个）');
  out.tags = out.tags.map(t => str(t, 'tags', 40)).filter(Boolean);
  if (out.status !== 'active' && out.status !== 'inactive') throw new BadInput('status 只能是 active / inactive');
  return out;
}

// sha256 后再比，长度恒等，timingSafeEqual 才能用
const sameSecret = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
let loginFails = [];

// ── Routes ────────────────────────────────────────────────────────────────────

// Portal config (public)
r.get('/api/config', (_req, res) => {
  res.json({ title: PORTAL_TITLE });
});

// Login
r.post('/api/auth', (req, res) => {
  const now = Date.now();
  loginFails = loginFails.filter(t => now - t < LOGIN_WINDOW_MS);
  if (loginFails.length >= LOGIN_MAX_FAILS) {
    return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' });
  }
  const { password } = req.body || {};
  const pwd = String(password ?? '').trim();
  if (!pwd || !sameSecret(pwd, ADMIN_PASSWORD)) {
    loginFails.push(now);
    return res.status(401).json({ error: '密码错误' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d' });
  res.json({ token });
});

// 会话是否还有效（管理页启动时用：列表接口是公开的，不能拿它判断登录态）
r.get('/api/auth/check', auth, (_req, res) => res.json({ ok: true }));

// List services (public)
r.get('/api/services', (_req, res) => {
  const services = load().sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
  res.json(services);
});

// Add service
r.post('/api/services', auth, (req, res) => {
  const fields = normalize(req.body);
  const services = load();
  const service = {
    id:        Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    ...fields,
    order:     services.length,
    createdAt: new Date().toISOString(),
  };

  services.push(service);
  save(services);
  res.status(201).json(service);
});

// Update service
r.put('/api/services/:id', auth, (req, res) => {
  const services = load();
  const idx = services.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '服务不存在' });

  // 先把旧值和新值合起来再整体校验：只改一个字段时其余字段沿用旧值，id / order / createdAt 不让客户端改
  const old = services[idx];
  services[idx] = { ...old, ...normalize({ ...old, ...req.body }), id: old.id, order: old.order, createdAt: old.createdAt };
  save(services);
  res.json(services[idx]);
});

// Delete service
r.delete('/api/services/:id', auth, (req, res) => {
  let services = load();
  const before = services.length;
  services = services.filter(s => s.id !== req.params.id);
  if (services.length === before) return res.status(404).json({ error: '服务不存在' });

  services.forEach((s, i) => { s.order = i; });
  save(services);
  res.json({ ok: true });
});

// Reorder services
r.put('/api/reorder', auth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) return res.status(400).json({ error: 'ids 必须为字符串数组' });

  const services = load();
  const map = Object.fromEntries(services.map(s => [s.id, s]));
  const reordered = ids.map((id, i) => {
    if (!map[id]) return null;
    map[id].order = i;
    return map[id];
  }).filter(Boolean);

  // Append any services not in the id list at the end
  services.forEach(s => {
    if (!ids.includes(s.id)) reordered.push(s);
  });

  save(reordered);
  res.json(reordered);
});

app.disable('x-powered-by');
// 页面与脚本都是内联写的，script / style 只能放 'unsafe-inline'；其余一律只认本站。管理页被首页同源 iframe 嵌入，所以 frame-ancestors 是 'self'
const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "connect-src 'self'", "frame-ancestors 'self'",
  "base-uri 'none'", "object-src 'none'", "form-action 'self'",
].join('; ');
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
});
app.use(express.json({ limit: '64kb' }));

if (BASE_PATH) {
  app.use(BASE_PATH, r);
} else {
  app.use(r);
}

// 统一回 JSON（管理页对每个响应都 r.json()）；校验失败 400，其余 500 并打日志，不把堆栈吐给客户端
app.use((err, _req, res, _next) => {
  if (err instanceof BadInput) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(err.status).json({ error: '请求体不合法' });
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const baseLabel = BASE_PATH || '(根路径)';
app.listen(PORT, LISTEN_HOST, () => {
  console.log(`\n  🌐 HomePortal  →  http://${LISTEN_HOST}:${PORT}${BASE_PATH || ''}/`);
  console.log(`  🔧 Admin Panel →  http://${LISTEN_HOST}:${PORT}${BASE_PATH || ''}/#admin`);
  console.log(`  📁 Data file   →  ${DATA_FILE}`);
  console.log(`  📍 BASE_PATH   →  ${baseLabel}\n`);
});
