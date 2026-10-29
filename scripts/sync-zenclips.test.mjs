import test from 'node:test';
import assert from 'node:assert/strict';
import { extractClip, needsRefresh, toRecord } from './sync-zenclips.mjs';

const BANNER = 'https://i.ibb.co/PzGKSHJ6/discord-embed-banner.png';
const ORIGINAL = 'https://i.ibb.co/example/samara-weaving.jpg';
const INLINE = 'data:image/webp;base64,UklGRg==';
const entry = { id: 'exampleClip123', lastmod: '2026-10-29T17:59:56.349Z' };
const rawClip = overrides => ({
  id: entry.id,
  title: 'Example clip',
  visibility: 'public',
  thumbnail: ORIGINAL,
  linkNoCC: 'https://drive.google.com/file/d/example/view',
  ...overrides,
});
const cachedClip = overrides => ({ id: entry.id, thumb: ORIGINAL, lm: entry.lastmod, ...overrides });

test('uses the embedded clip thumbnail instead of the page sharing banner', () => {
  const raw = rawClip({ title: 'A "quoted" clip {with braces}' });
  const html = `<meta property="og:image" content="${BANNER}">
    <script>window.__INITIAL_CLIP__ = ${JSON.stringify(raw)};</script>`;

  const record = toRecord(extractClip(html), entry);

  assert.equal(record.thumb, ORIGINAL);
  assert.equal(record.title, raw.title);
});

test('keeps original HTTP and inline thumbnails', () => {
  for (const thumbnail of [ORIGINAL, 'http://example.com/clip.png', INLINE]) {
    assert.equal(toRecord(rawClip({ thumbnail }), entry).thumb, thumbnail);
    assert.equal(needsRefresh(entry, cachedClip({ thumb: thumbnail }), false), false);
  }
});

test('repairs cached banner and missing thumbnails even when lastmod is unchanged', () => {
  for (const thumb of [BANNER, BANNER + '?v=2', '', undefined, 'not a URL']) {
    assert.equal(needsRefresh(entry, cachedClip({ thumb }), false), true);
  }

  const old = cachedClip({ thumb: BANNER });
  const repaired = toRecord(rawClip(), entry, old);
  assert.equal(repaired.thumb, ORIGINAL);
  assert.equal(needsRefresh(entry, repaired, false), false);
});

test('refreshes new and changed clips and honors full refresh', () => {
  assert.equal(needsRefresh(entry, undefined, false), true);
  assert.equal(needsRefresh(entry, cachedClip({ lm: '2026-10-28' }), false), true);
  assert.equal(needsRefresh(entry, cachedClip(), false), false);
  assert.equal(needsRefresh(entry, cachedClip(), true), true);
});

test('never stores the sharing banner or invalid thumbnail values', () => {
  for (const thumbnail of [
    BANNER,
    BANNER + '?v=2#preview',
    'javascript:alert(1)',
    'file:///tmp/clip.png',
    'not a URL',
    'data:text/html;base64,PHNjcmlwdD4=',
    '',
    undefined,
  ]) {
    assert.equal(toRecord(rawClip({ thumbnail }), entry).thumb, '');
  }
});

test('retains a previous original thumbnail while upstream has a banner or missing image', () => {
  for (const thumb of [ORIGINAL, INLINE]) {
    for (const thumbnail of [BANNER, '', undefined, 'not a URL']) {
      const record = toRecord(rawClip({ thumbnail }), entry, cachedClip({ thumb }));
      assert.equal(record.thumb, thumb);
    }
  }
});

test('prefers a fresh original thumbnail and rejects invalid cached fallbacks', () => {
  const fresh = 'https://example.com/new-thumbnail.jpg';
  assert.equal(toRecord(rawClip({ thumbnail: fresh }), entry, cachedClip()).thumb, fresh);

  for (const thumb of [BANNER, 'javascript:alert(1)', '']) {
    assert.equal(toRecord(rawClip({ thumbnail: BANNER }), entry, cachedClip({ thumb })).thumb, '');
  }
});
