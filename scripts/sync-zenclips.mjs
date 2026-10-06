#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'zenclips.json');
const THEME_FILE = path.join(ROOT, 'aniclips-blogger-theme.xml');
const HOSTS = ['https://zenclips.in', 'https://zenclips.vercel.app'];
const USER_AGENT = 'AniClipsSync/1.0 (+https://aniclips.net)';
const CONCURRENCY = 3;
const REQUEST_GAP_MS = 100;
const MAX_FAILED_SHARE = 0.25; 

const args = new Set(process.argv.slice(2));
const FULL = args.has('--full');
const EMBED = args.has('--embed');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xml;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return await res.text();
      const err = new Error('HTTP ' + res.status);
      err.permanent = res.status === 404 || res.status === 410;
      throw err;
    } catch (e) {
      if (e.permanent || attempt >= tries) throw e;
      await sleep(800 * attempt);
    }
  }
}

async function loadSitemap() {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const xml = await get(host + '/sitemap.xml');
      const entries = [];
      for (const m of xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)) {
        let pathname;
        try { pathname = new URL(m[1].trim()).pathname; } catch { continue; }
        if (!pathname.startsWith('/clip/')) continue;
        const id = pathname.split('-').pop();
        if (!/^[A-Za-z0-9_]{6,64}$/.test(id)) continue;
        entries.push({ id, pathname, lastmod: (m[2] || '').trim() });
      }
      if (entries.length) return { host, entries };
      lastErr = new Error('sitemap on ' + host + ' had no clip entries');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no ZenClips host reachable');
}

function extractClip(html) {
  const at = html.indexOf('window.__INITIAL_CLIP__');
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const text = v => (typeof v === 'string' ? v.trim() : '');
const httpUrl = v => {
  const s = text(v);
  try { return /^https?:$/.test(new URL(s).protocol) ? s : ''; } catch { return ''; }
};
const INLINE_IMAGE = /^data:image\/(?:webp|jpeg|png|gif);base64,[A-Za-z0-9+/=]+$/;
const MAX_INLINE_IMAGE_CHARS = 64 * 1024;
const thumbUrl = v => {
  const s = text(v);
  return s.length <= MAX_INLINE_IMAGE_CHARS && INLINE_IMAGE.test(s) ? s : httpUrl(s);
};

function toRecord(raw, entry) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.visibility && raw.visibility !== 'public') return null;
  const id = text(raw.id) || entry.id;
  const title = text(raw.title).replace(/\s+/g, ' ');
  const link = httpUrl(raw.linkNoCC);
  const linkCC = httpUrl(raw.linkCC);
  if (!id || !title || (!link && !linkCC)) return null;
  const date = (text(raw.uploadedAt) || text(raw.uploadDateNormalized) || entry.lastmod).slice(0, 10);
  return {
    id,
    title,
    cat: text(raw.category).toLowerCase(),
    ratio: text(raw.aspectRatio) || '16:9',
    res: text(raw.resolution),
    thumb: thumbUrl(raw.thumbnail),
    views: Number(raw.views) || 0,
    dl: Number(raw.downloads) || 0,
    link: link || linkCC,
    linkCC,
    tags: Array.isArray(raw.tags) ? raw.tags.map(text).filter(Boolean) : [],
    date,
    lm: entry.lastmod,
  };
}

async function readPrevious() {
  try {
    const list = JSON.parse(await readFile(OUT_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

async function mapPool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
      await sleep(REQUEST_GAP_MS);
    }
  }));
  return results;
}

const byNewest = (a, b) => (b.date.localeCompare(a.date)) || (b.lm || '').localeCompare(a.lm || '') || a.title.localeCompare(b.title);

const toFileText = clips => '[\n' + clips.map(c => JSON.stringify(c)).join(',\n') + '\n]\n';

function toEmbedJson(clips) {
  const json = JSON.stringify(clips);
  const escapeLead = String.fromCharCode(92) + 'u'; 
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    const unsafe = code > 126 || code === 60 || code === 62 || code === 38;
    out += unsafe ? escapeLead + code.toString(16).padStart(4, '0') : json[i];
  }
  return out;
}

async function embedIntoTheme(clips) {
  const xml = await readFile(THEME_FILE, 'utf8');
  const lines = xml.split('\n');
  const idx = lines.findIndex(l => /^\s*(?:const|let) ZT_CLIPS_DB = \[/.test(l));
  if (idx < 0) throw new Error('ZT_CLIPS_DB declaration not found in ' + THEME_FILE);
  const eol = lines[idx].endsWith('\r') ? '\r' : '';
  const indent = lines[idx].match(/^\s*/)[0];
  const snapshot = clips.map(({ lm, ...rest }) => rest);
  const json = toEmbedJson(snapshot);
  JSON.parse(json); 
  lines[idx] = indent + 'let ZT_CLIPS_DB = ' + json + ';' + eol;
  await writeFile(THEME_FILE, lines.join('\n'));
  return Buffer.byteLength(json);
}

async function main() {
  const previous = await readPrevious();
  const prevById = new Map(previous.map(c => [c.id, c]));

  const { host, entries } = await loadSitemap();
  console.log(`sitemap: ${entries.length} clips on ${host} (previous feed: ${previous.length})`);
  if (previous.length && entries.length < previous.length * 0.5) {
    throw new Error(`sitemap shrank from ${previous.length} to ${entries.length}; refusing to overwrite the feed`);
  }

  const todo = entries.filter(e => FULL || !prevById.has(e.id) || prevById.get(e.id).lm !== e.lastmod);
  console.log(`fetching ${todo.length} clip page(s)${FULL ? ' (--full)' : ''}`);

  let failed = 0;
  const fetched = new Map();
  await mapPool(todo, async entry => {
    try {
      const raw = extractClip(await get(host + entry.pathname));
      if (!raw) throw new Error('no __INITIAL_CLIP__ data on page');
      const rec = toRecord(raw, entry);
      if (rec) fetched.set(entry.id, rec);
      else console.log('  skipped (not public / incomplete): ' + entry.id);
    } catch (e) {
      failed++;
      console.warn(`  failed ${entry.id}: ${e.message}`);
    }
  });
  if (todo.length && failed / todo.length > MAX_FAILED_SHARE) {
    throw new Error(`${failed}/${todo.length} clip fetches failed; leaving the feed untouched`);
  }

  const next = [];
  let added = 0, updated = 0, kept = 0;
  for (const e of entries) {
    const fresh = fetched.get(e.id);
    const old = prevById.get(e.id);
    if (fresh) { next.push(fresh); old ? updated++ : added++; }
    else if (old) { next.push(old); kept++; } 
  }
  next.sort(byNewest);
  const removed = previous.filter(c => !entries.some(e => e.id === c.id)).length;

  const fileText = toFileText(next);
  let before = '';
  try { before = await readFile(OUT_FILE, 'utf8'); } catch {}
  if (before !== fileText) await writeFile(OUT_FILE, fileText);
  console.log(`zenclips.json: ${next.length} clips (${added} new, ${updated} refreshed, ${kept} unchanged, ${removed} removed, ${failed} failed) -> ${before === fileText ? 'no changes' : 'written'}`);

  if (EMBED) {
    const bytes = await embedIntoTheme(next);
    console.log(`theme snapshot refreshed (${Math.round(bytes / 1024)} KB of clip data)`);
  }
}

main().catch(e => { console.error('sync failed: ' + e.message); process.exit(1); });
