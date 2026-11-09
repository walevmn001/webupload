'use strict';

/*
 * Danh sach cac dich vu luu tru file mien phi ho tro API khong can dang nhap.
 * Moi dich vu co 1 ham upload(blob, filename, ctx) tra ve { url, directUrl?, note? }.
 *   - `blob` la doi tuong Blob (duoc ho tro boi file tren dia qua fs.openAsBlob),
 *     nho do backend khong phai nap toan bo file vao RAM.
 *   - `ctx.tmpPath` la duong dan file tam tren dia (dung cho SDK can filepath).
 * Backend dong vai tro proxy de vuot qua gioi han CORS cua trinh duyet.
 *
 * limitBytes: gioi han dung luong cua CHINH dich vu (null = khong gioi han).
 */

const fs = require('fs');
const path = require('path');

/*
 * Tuong thich Node 24 (undici): fetch ban loi "invalid content-length header"
 * khi vua truyen body dang Uint8Array/Buffer vua tu set header Content-Length.
 * SDK @file-kiwi/node lam dung nhu vay -> ta bo header do de undici tu tinh lai
 * (Content-Length khong nam trong SignedHeaders cua R2 nen van hop le).
 */
const _origFetch = globalThis.fetch;
globalThis.fetch = function patchedFetch(input, init) {
  const body = init && init.body;
  if (init && init.headers && (body instanceof Uint8Array || Buffer.isBuffer(body))) {
    const h = init.headers;
    if (h instanceof Headers) {
      if (h.has('content-length')) h.delete('content-length');
    } else if (Array.isArray(h)) {
      init = { ...init, headers: h.filter((p) => String(p[0]).toLowerCase() !== 'content-length') };
    } else {
      const nh = {};
      for (const k of Object.keys(h)) if (k.toLowerCase() !== 'content-length') nh[k] = h[k];
      init = { ...init, headers: nh };
    }
  }
  return _origFetch.call(this, input, init);
};

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Thoi gian cho toi da cho moi request len server dich vu (ms)
const UPSTREAM_TIMEOUT = 15 * 60 * 1000;

const MB = (n) => n * 1024 * 1024;

function timeout(ms = UPSTREAM_TIMEOUT) {
  return AbortSignal.timeout(ms);
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('Phan hoi khong phai JSON: ' + text.slice(0, 120));
  }
}

async function assertOk(res, label) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} tra ve HTTP ${res.status}: ${body.slice(0, 120)}`);
  }
}

/* --------------------------- Cac adapter dich vu --------------------------- */

const services = [
  {
    id: 'gofile',
    name: 'Gofile',
    desc: 'Khong gioi han dung luong, link song lau',
    site: 'https://gofile.io',
    limit: 'Khong gioi han',
    limitBytes: null,
    expiry: 'Lau dai (phu thuoc luot truy cap)',
    async upload(blob, filename) {
      const sres = await fetch('https://api.gofile.io/servers', {
        headers: { 'User-Agent': UA },
        signal: timeout(15000),
      });
      await assertOk(sres, 'Gofile (servers)');
      const sjson = await readJson(sres);
      const servers = sjson?.data?.servers || [];
      if (!servers.length) throw new Error('Gofile khong tra ve server kha dung');
      const server = servers[0].name;

      const fd = new FormData();
      fd.append('file', blob, filename);
      const res = await fetch(`https://${server}.gofile.io/contents/uploadfile`, {
        method: 'POST',
        body: fd,
        headers: { 'User-Agent': UA },
        signal: timeout(),
      });
      await assertOk(res, 'Gofile');
      const j = await readJson(res);
      if (j.status && j.status !== 'ok') throw new Error('Gofile: ' + j.status);
      const page = j?.data?.downloadPage || j?.data?.directLink;
      if (!page) throw new Error('Gofile khong tra ve link tai');
      return { url: page, directUrl: j?.data?.directLink || page };
    },
  },
  {
    id: 'filekiwi',
    name: 'file.kiwi',
    desc: 'Ma hoa dau-cuoi (E2E), chia se link co khoa rieng',
    site: 'https://file.kiwi',
    limit: '999 GB',
    limitBytes: MB(999 * 1024), // 999 GiB moi file
    expiry: 'Giu tren server 90 gio',
    // Dung SDK @file-kiwi/node: can duong dan file tren dia (ctx.tmpPath)
    async upload(blob, filename, ctx) {
      if (!ctx || !ctx.tmpPath) throw new Error('file.kiwi can duong dan file tam');
      const { createWebFolder, startUpload } = await import('@file-kiwi/node');

      // SDK lay ten file tu basename(filepath) -> tao hardlink voi ten goc
      const safeName = path.basename(filename).replace(/[^\w.\-]+/g, '_') || 'file.bin';
      const localPath = path.join(path.dirname(ctx.tmpPath), `fk-${Date.now()}-${safeName}`);
      try {
        await fs.promises.link(ctx.tmpPath, localPath);
      } catch (_) {
        await fs.promises.copyFile(ctx.tmpPath, localPath);
      }

      try {
        const webfolder = await createWebFolder({
          title: safeName,
          files: [{ filepath: localPath }],
        });
        await startUpload(webfolder);
        return {
          // URL co kem #secretKey o phan fragment -> bat buoc de giai ma
          url: webfolder.webfolderUrl,
          directUrl: null,
          note: 'File duoc ma hoa dau-cuoi (E2E). Mo link roi bam tai tren trang file.kiwi — khong ho tro tai truc tiep qua proxy.',
        };
      } finally {
        fs.promises.unlink(localPath).catch(() => {});
      }
    },
  },
];

// Thu tu hien thi
const DISPLAY_ORDER = ['gofile', 'filekiwi'];

function publicList() {
  return services
    .slice()
    .sort((a, b) => {
      const ia = DISPLAY_ORDER.indexOf(a.id);
      const ib = DISPLAY_ORDER.indexOf(b.id);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .map((s) => ({
      id: s.id,
      name: s.name,
      desc: s.desc,
      site: s.site,
      limit: s.limit,
      limitBytes: s.limitBytes,
      expiry: s.expiry,
    }));
}

function getService(id) {
  return services.find((s) => s.id === id);
}

module.exports = { services, publicList, getService, UA };
