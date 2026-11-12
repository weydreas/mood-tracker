import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const file = (path) => new URL('../' + path, import.meta.url);

test('PWA manifest declares a standalone Mood Atlas app and two install icons', async () => {
  const manifest = JSON.parse(await readFile(file('public/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.short_name, 'Mood Atlas');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');

  for (const size of [192, 512]) {
    const path = `/icons/icon-${size}.png`;
    const icon = manifest.icons.find((item) => item.src === path);
    assert.ok(icon, `missing manifest icon ${path}`);
    assert.equal(icon.sizes, `${size}x${size}`);
    assert.equal(icon.type, 'image/png');

    const bytes = await readFile(file('public' + path));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
});

test('HTML declares manifest, iOS home-screen icon and matching theme color', async () => {
  const html = await readFile(file('public/index.html'), 'utf8');
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/icons\/icon-192\.png"/);
  assert.match(html, /name="theme-color" content="#0c2421"/);
});
