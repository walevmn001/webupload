'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const { URL } = require('url');

const { publicList, getService } = require('./services');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// Tran an toan cua may chu: ap dung cho dich vu khong gioi han (vd Gofile)
// va luon la gioi han toi da du dich vu cho phep lon hon.
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD || 2 * 1024 * 1024 * 1024); // 2GB mac dinh

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');

/* ------------------------------- Tien ich --------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('FILE_TOO_LARGE'), { code: 'FILE_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Ghi luong upload ra file tam tren dia (tranh nap toan bo vao RAM)
function streamToTempFile(req, limit) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(
      os.tmpdir(),
      'fu-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    );
    const ws = fs.createWriteStream(tmpPath);
    let size = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      ws.destroy();
      fs.promises.unlink(tmpPath).catch(() => {});
      reject(err);
    };

    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        req.pause(); // ngung doc them, van gui duoc phan hoi loi
        fail(Object.assign(new Error('FILE_TOO_LARGE'), { code: 'FILE_TOO_LARGE' }));
        return;
      }
      if (!ws.write(c)) {
        req.pause();
        ws.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      if (settled) return;
      ws.end(() => {
        if (settled) return;
        settled = true;
        resolve({ tmpPath, size });
      });
    });
    req.on('error', fail);
    ws.on('error', fail);
  });
}

function readJsonBody(req, limit = 1024 * 1024) {
  return readRawBody(req, limit).then((buf) => {
    if (!buf.length) return {};
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch (_) {
      throw Object.assign(new Error('JSON khong hop le'), { code: 'BAD_JSON' });
    }
  });
}

function humanSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 2 : 1) + ' ' + u[i];
}

// Chan SSRF co ban cho chuc nang tai ho link
async function assertPublicUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_) {
    throw new Error('URL khong hop le');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Chi ho tro http/https');
  }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) throw new Error('Host khong duoc phep');
  const addrs = await dns.lookup(host, { all: true }).catch(() => []);
  for (const a of addrs) {
    const ip = a.address;
    if (
      ip === '::1' ||
      ip.startsWith('127.') ||
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      ip.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
      ip.startsWith('fc') ||
      ip.startsWith('fd') ||
      ip.startsWith('0.')
    ) {
      throw new Error('Dia chi noi bo khong duoc phep');
    }
  }
  return u;
}

/* --------------------------- Luu tru bao loi ------------------------------ */

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(REPORTS_FILE)) fs.writeFileSync(REPORTS_FILE, '[]');
}

function appendReport(entry) {
  ensureData();
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'));
  } catch (_) {
    list = [];
  }
  list.push(entry);
  if (list.length > 500) list = list.slice(-500);
  fs.writeFileSync(REPORTS_FILE, JSON.stringify(list, null, 2));
}

/* -------------------------------- Routes ---------------------------------- */

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleUpload(req, res, query) {
  const serviceId = query.get('service');
  const svc = getService(serviceId);
  if (!svc) return sendJson(res, 400, { ok: false, error: 'Dich vu khong ton tai: ' + serviceId });

  const filename = decodeURIComponent(req.headers['x-filename'] || 'file.bin');
  const started = Date.now();

  // Gioi han thuc te = nho nhat giua gioi han cua dich vu va tran cua may chu
  const serviceLimit = svc.limitBytes == null ? Infinity : svc.limitBytes;
  const effective = Math.min(serviceLimit, MAX_UPLOAD);
  const limitNote =
    serviceLimit <= MAX_UPLOAD ? `giới hạn của ${svc.name}` : 'giới hạn máy chủ';

  let tmpPath;
  let size;
  try {
    ({ tmpPath, size } = await streamToTempFile(req, effective));
  } catch (e) {
    if (e.code === 'FILE_TOO_LARGE') {
      const msg = `File vượt quá ${humanSize(effective)} (${limitNote})`;
      appendReport({ type: 'upload_error', service: serviceId, filename, error: msg, at: new Date().toISOString() });
      // Tra loi som roi dong ket noi (client co the dang gui tiep du lieu)
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
      res.end(JSON.stringify({ ok: false, error: msg, service: svc.id, serviceName: svc.name }));
      return;
    }
    return sendJson(res, 500, { ok: false, error: 'Khong ghi duoc du lieu upload' });
  }

  if (!size) {
    fs.promises.unlink(tmpPath).catch(() => {});
    return sendJson(res, 400, { ok: false, error: 'File rong' });
  }

  try {
    const blob = await fs.openAsBlob(tmpPath);
    const out = await svc.upload(blob, filename, { tmpPath });
    return sendJson(res, 200, {
      ok: true,
      service: svc.id,
      serviceName: svc.name,
      url: out.url,
      directUrl: out.directUrl || null,
      note: out.note || null,
      filename,
      size,
      sizeText: humanSize(size),
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    const msg = e.message || String(e);
    appendReport({ type: 'upload_error', service: serviceId, filename, error: msg, at: new Date().toISOString() });
    return sendJson(res, 502, {
      ok: false,
      error: msg,
      service: svc.id,
      serviceName: svc.name,
    });
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

async function handleDownload(req, res, query) {
  const raw = query.get('url');
  if (!raw) return sendJson(res, 400, { ok: false, error: 'Thieu tham so url' });
  let target;
  try {
    target = await assertPublicUrl(raw);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message });
  }

  const name = query.get('name') || path.basename(target.pathname) || 'download';

  try {
    const upstream = await fetch(target.href, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!upstream.ok) {
      return sendJson(res, 502, { ok: false, error: 'Nguon tra ve HTTP ' + upstream.status });
    }
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
      'Cache-Control': 'no-store',
    });
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) return sendJson(res, 502, { ok: false, error: 'Tai that bai: ' + e.message });
    res.end();
  }
}

async function handleReport(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message });
  }
  const message = String(body.message || '').trim().slice(0, 4000);
  if (!message) return sendJson(res, 400, { ok: false, error: 'Noi dung bao loi khong duoc de trong' });

  appendReport({
    type: 'user_report',
    message,
    email: String(body.email || '').slice(0, 200),
    service: String(body.service || '').slice(0, 64),
    context: body.context ? String(body.context).slice(0, 2000) : '',
    at: new Date().toISOString(),
    ua: req.headers['user-agent'] || '',
  });
  return sendJson(res, 200, { ok: true, message: 'Cam on ban, bao loi da duoc ghi nhan!' });
}

/* ------------------- Kiem tra tinh trang cac dich vu ---------------------- */

let checkCache = { at: 0, result: null };
const CHECK_TTL = 5 * 60 * 1000;

async function checkServices() {
  if (checkCache.result && Date.now() - checkCache.at < CHECK_TTL) return checkCache.result;
  const tiny = Buffer.from('freeupload-hub-check');
  const results = await Promise.all(
    publicList().map(async (meta) => {
      const svc = getService(meta.id);
      const t0 = Date.now();
      let checkTmp;
      try {
        // Mot so dich vu (vd file.kiwi) can duong dan file tren dia
        checkTmp = path.join(
          os.tmpdir(),
          'fu-check-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.txt'
        );
        await fs.promises.writeFile(checkTmp, tiny);
        const out = await svc.upload(new Blob([tiny]), '.check.txt', { tmpPath: checkTmp });
        return { id: meta.id, ok: true, ms: Date.now() - t0, url: out.url };
      } catch (e) {
        return { id: meta.id, ok: false, ms: Date.now() - t0, error: (e.message || String(e)).slice(0, 160) };
      } finally {
        if (checkTmp) fs.promises.unlink(checkTmp).catch(() => {});
      }
    })
  );
  const result = { checkedAt: new Date().toISOString(), results };
  checkCache = { at: Date.now(), result };
  return result;
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = parsed;

  // CORS cho phep nhung tu noi khac neu can
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, uptime: process.uptime(), maxUpload: MAX_UPLOAD, maxUploadText: humanSize(MAX_UPLOAD) });
    }
    if (pathname === '/api/services' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, services: publicList(), maxUpload: MAX_UPLOAD, maxUploadText: humanSize(MAX_UPLOAD) });
    }
    if (pathname === '/api/services/check' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...(await checkServices()) });
    }
    if (pathname === '/api/upload' && req.method === 'POST') {
      return await handleUpload(req, res, searchParams);
    }
    if (pathname === '/api/download' && req.method === 'GET') {
      return await handleDownload(req, res, searchParams);
    }
    if (pathname === '/api/report' && req.method === 'POST') {
      return await handleReport(req, res);
    }
    if (pathname === '/api/reports' && req.method === 'GET') {
      ensureData();
      let list = [];
      try {
        list = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'));
      } catch (_) {}
      return sendJson(res, 200, { ok: true, count: list.length, reports: list.slice(-50).reverse() });
    }
    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message || 'Loi server' });
  }
});

ensureData();
server.listen(PORT, HOST, () => {
  console.log(`Server dang chay tai http://${HOST}:${PORT} (gioi han upload ${humanSize(MAX_UPLOAD)})`);
});
