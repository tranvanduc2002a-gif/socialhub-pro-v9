import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'socialhub-v9.sqlite');
const PORT = process.env.PORT || 5004;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS accounts(
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  followers INTEGER DEFAULT 0,
  avatar TEXT DEFAULT '🏪',
  status TEXT DEFAULT 'connected',
  tokenStatus TEXT DEFAULT 'mock',
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaigns(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  mediaUrl TEXT,
  mediaType TEXT,
  scheduledAt TEXT,
  status TEXT NOT NULL,
  retryCount INTEGER DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS targets(
  id TEXT PRIMARY KEY,
  campaignId TEXT NOT NULL,
  accountId TEXT NOT NULL,
  platform TEXT,
  status TEXT NOT NULL,
  errorMessage TEXT,
  publishedUrl TEXT,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS logs(
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  campaignId TEXT,
  accountId TEXT,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timeline(
  id TEXT PRIMARY KEY,
  campaignId TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_drafts(
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  angle TEXT NOT NULL,
  caption TEXT NOT NULL,
  hashtags TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
`);

function now() { return new Date().toISOString(); }
function all(sql, ...p) { return db.prepare(sql).all(...p); }
function get(sql, ...p) { return db.prepare(sql).get(...p); }
function run(sql, ...p) { return db.prepare(sql).run(...p); }
function log(level, message, campaignId = null, accountId = null) {
  run('INSERT INTO logs(id,level,message,campaignId,accountId,createdAt) VALUES(?,?,?,?,?,?)', nanoid(), level, message, campaignId, accountId, now());
  console.log(`[${level}] ${message}`);
}
function step(campaignId, stepName, status, message) {
  run('INSERT INTO timeline(id,campaignId,step,status,message,createdAt) VALUES(?,?,?,?,?,?)', nanoid(), campaignId, stepName, status, message, now());
  log(status === 'failed' ? 'error' : status === 'success' ? 'success' : 'info', message, campaignId);
}

function seed() {
  if (get('SELECT COUNT(*) c FROM accounts').c > 0) return;
  const sample = [
    ['facebook', 'Shop Thời Trang ABC', 12400, '👗'],
    ['instagram', 'ABC Fashion Official', 8900, '👗'],
    ['tiktok', 'ABC TikTok Store', 45200, '👗'],
    ['facebook', 'Mỹ Phẩm XYZ', 6700, '💄'],
    ['instagram', 'XYZ Beauty', 15300, '💄'],
    ['tiktok', 'Tech123 Store', 3200, '📱']
  ];
  for (const [platform, name, followers, avatar] of sample) {
    run('INSERT INTO accounts(id,platform,name,followers,avatar,status,tokenStatus,createdAt) VALUES(?,?,?,?,?,?,?,?)', nanoid(), platform, name, followers, avatar, 'connected', 'mock', now());
  }
  log('success', 'Seeded demo accounts');
}
seed();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${nanoid()}${path.extname(file.originalname || '')}`)
});
const upload = multer({ storage, limits: { fileSize: 250 * 1024 * 1024 } });

const publishers = {
  facebook: async (campaign, account) => mockPublisher('Facebook Page API', campaign, account),
  instagram: async (campaign, account) => mockPublisher('Instagram Graph API', campaign, account),
  tiktok: async (campaign, account) => mockPublisher('TikTok Content Posting API', campaign, account)
};

function mockPublisher(name, campaign, account) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const fail = Math.random() < 0.06;
      if (fail) reject(new Error(`${name} mock rate limit / temporary error`));
      else resolve({ url: `https://socialhub.local/${account.platform}/${campaign.id}/${account.id}` });
    }, 1800 + Math.floor(Math.random() * 2200));
  });
}

async function publishTarget(campaign, target, account) {
  run('UPDATE targets SET status=?, updatedAt=? WHERE id=?', 'uploading', now(), target.id);
  step(campaign.id, 'uploading', 'running', `Chuẩn bị media cho ${account.name}`);

  await new Promise(r => setTimeout(r, 800));

  run('UPDATE targets SET status=?, updatedAt=? WHERE id=?', 'publishing', now(), target.id);
  step(campaign.id, 'publishing', 'running', `Publisher layer gọi ${account.platform} cho ${account.name}`);

  try {
    const result = await (publishers[account.platform] || publishers.facebook)(campaign, account);
    run('UPDATE targets SET status=?, publishedUrl=?, errorMessage=NULL, updatedAt=? WHERE id=?', 'published', result.url, now(), target.id);
    step(campaign.id, 'verify', 'success', `Xác minh thành công bài đăng trên ${account.name}`);
  } catch (e) {
    run('UPDATE targets SET status=?, errorMessage=?, updatedAt=? WHERE id=?', 'failed', e.message, now(), target.id);
    step(campaign.id, 'publishing', 'failed', `Lỗi đăng ${account.name}: ${e.message}`);
  }
  finalizeCampaign(campaign.id);
}

function finalizeCampaign(campaignId) {
  const targets = all('SELECT * FROM targets WHERE campaignId=?', campaignId);
  if (targets.some(t => ['queued', 'scheduled', 'uploading', 'publishing'].includes(t.status))) return;
  const failed = targets.some(t => t.status === 'failed');
  run('UPDATE campaigns SET status=?, updatedAt=? WHERE id=?', failed ? 'failed' : 'published', now(), campaignId);
  step(campaignId, 'report', failed ? 'failed' : 'success', failed ? 'Campaign kết thúc nhưng có target lỗi' : 'Campaign publish toàn bộ thành công');
}

function processQueue() {
  const due = all("SELECT * FROM campaigns WHERE status IN ('queued','scheduled') AND scheduledAt <= ?", now());
  for (const campaign of due) {
    run('UPDATE campaigns SET status=?, updatedAt=? WHERE id=?', 'publishing', now(), campaign.id);
    step(campaign.id, 'queue', 'running', `Worker nhận campaign: ${campaign.title}`);
    const targets = all("SELECT * FROM targets WHERE campaignId=? AND status IN ('queued','scheduled')", campaign.id);
    for (const target of targets) {
      const account = get('SELECT * FROM accounts WHERE id=?', target.accountId);
      if (!account) continue;
      publishTarget(campaign, target, account);
    }
  }
}
setInterval(processQueue, 10000);

function buildState() {
  const accounts = all('SELECT * FROM accounts ORDER BY createdAt DESC');
  const campaigns = all('SELECT * FROM campaigns ORDER BY createdAt DESC');
  const targets = all('SELECT * FROM targets ORDER BY updatedAt DESC');
  const logs = all('SELECT * FROM logs ORDER BY createdAt DESC LIMIT 300');
  const timeline = all('SELECT * FROM timeline ORDER BY createdAt DESC LIMIT 500');
  const drafts = all('SELECT * FROM ai_drafts ORDER BY createdAt DESC LIMIT 50');
  const enriched = campaigns.map(c => ({
    ...c,
    targets: targets.filter(t => t.campaignId === c.id),
    timeline: timeline.filter(t => t.campaignId === c.id).reverse()
  }));
  return { accounts, campaigns: enriched, logs, timeline, drafts, analytics: analytics(enriched, accounts) };
}

function analytics(campaigns, accounts) {
  const total = campaigns.length;
  const published = campaigns.filter(c => c.status === 'published').length;
  const failed = campaigns.filter(c => c.status === 'failed').length;
  const publishing = campaigns.filter(c => c.status === 'publishing').length;
  const queued = campaigns.filter(c => ['queued', 'scheduled'].includes(c.status)).length;
  const targets = campaigns.flatMap(c => c.targets || []);
  const successTargets = targets.filter(t => t.status === 'published').length;
  const failedTargets = targets.filter(t => t.status === 'failed').length;
  const byPlatform = ['facebook', 'instagram', 'tiktok'].map(platform => {
    const accountIds = accounts.filter(a => a.platform === platform).map(a => a.id);
    const platformTargets = targets.filter(t => accountIds.includes(t.accountId));
    return {
      platform,
      total: platformTargets.length,
      published: platformTargets.filter(t => t.status === 'published').length,
      failed: platformTargets.filter(t => t.status === 'failed').length
    };
  });
  return { total, published, failed, publishing, queued, successTargets, failedTargets, successRate: total ? Math.round((published / total) * 100) : 0, byPlatform };
}

app.get('/api/state', (req, res) => res.json(buildState()));

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Chưa có file' });
  const type = req.file.mimetype.startsWith('video') ? 'video' : 'image';
  const url = `http://localhost:${PORT}/uploads/${req.file.filename}`;
  log('success', `Uploaded media ${req.file.filename}`);
  res.json({ url, type, filename: req.file.filename });
});

app.post('/api/campaigns', (req, res) => {
  const { title, content, mediaUrl = '', mediaType = '', scheduledAt, accountIds = [], publishNow = false } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Thiếu title/content' });
  const accounts = accountIds.length ? accountIds : all('SELECT id FROM accounts LIMIT 1').map(a => a.id);
  const id = nanoid();
  const when = publishNow ? now() : (scheduledAt || new Date(Date.now() + 60000).toISOString());
  const status = publishNow ? 'queued' : 'scheduled';
  run('INSERT INTO campaigns(id,title,content,mediaUrl,mediaType,scheduledAt,status,retryCount,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)', id, title, content, mediaUrl, mediaType, when, status, 0, now(), now());
  step(id, 'created', 'success', `Campaign đã tạo: ${title}`);
  for (const accountId of accounts) {
    const account = get('SELECT * FROM accounts WHERE id=?', accountId);
    run('INSERT INTO targets(id,campaignId,accountId,platform,status,updatedAt) VALUES(?,?,?,?,?,?)', nanoid(), id, accountId, account?.platform || 'unknown', status, now());
  }
  step(id, 'queue', status === 'queued' ? 'running' : 'scheduled', `${publishNow ? 'Queued' : 'Scheduled'} campaign cho ${accounts.length} tài khoản`);
  res.json({ ok: true, id });
});

app.post('/api/campaigns/:id/retry', (req, res) => {
  const id = req.params.id;
  const c = get('SELECT * FROM campaigns WHERE id=?', id);
  if (!c) return res.status(404).json({ error: 'Không thấy campaign' });
  run('UPDATE campaigns SET status=?, retryCount=retryCount+1, scheduledAt=?, updatedAt=? WHERE id=?', 'queued', now(), now(), id);
  run("UPDATE targets SET status=?, errorMessage=NULL, updatedAt=? WHERE campaignId=? AND status IN ('failed','published')", 'queued', now(), id);
  step(id, 'retry', 'running', `Retry campaign ${c.title}`);
  res.json({ ok: true });
});

app.delete('/api/campaigns/:id', (req, res) => {
  const id = req.params.id;
  run('DELETE FROM timeline WHERE campaignId=?', id);
  run('DELETE FROM targets WHERE campaignId=?', id);
  run('DELETE FROM campaigns WHERE id=?', id);
  log('warning', `Deleted campaign ${id}`);
  res.json({ ok: true });
});

app.post('/api/accounts/bulk', (req, res) => {
  const lines = String(req.body.text || '').split('\n').map(x => x.trim()).filter(Boolean);
  let count = 0;
  for (const line of lines) {
    const [platform, name, followers] = line.split(',').map(x => x.trim());
    if (platform && name) {
      run('INSERT INTO accounts(id,platform,name,followers,avatar,status,tokenStatus,createdAt) VALUES(?,?,?,?,?,?,?,?)', nanoid(), platform, name, Number(followers || 0), '🏪', 'connected', 'mock', now());
      count++;
    }
  }
  log('success', `Imported ${count} accounts`);
  res.json({ ok: true, count });
});

app.post('/api/ai/generate', (req, res) => {
  const product = String(req.body.product || 'Sản phẩm ecommerce').trim();
  const angle = String(req.body.angle || 'conversion').trim();
  const caption = `🔥 ${product} đang được săn đón!\n\nGiải pháp nhanh cho khách hàng muốn đẹp hơn, tiện hơn và mua hàng dễ hơn. Ưu đãi hôm nay có giới hạn — nhắn tin ngay để nhận deal tốt nhất.`;
  const hashtags = '#ecommerce #sale #viral #tiktokshop #facebookads #skincare #beauty #dealhot';
  run('INSERT INTO ai_drafts(id,product,angle,caption,hashtags,createdAt) VALUES(?,?,?,?,?,?)', nanoid(), product, angle, caption, hashtags, now());
  log('success', `AI generated content for ${product}`);
  res.json({ caption, hashtags });
});

app.listen(PORT, () => console.log(`SocialHub Pro V9 API chạy tại http://localhost:${PORT}`));
