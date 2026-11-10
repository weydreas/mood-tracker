import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = new URL('../', import.meta.url);
const text = (p) => readFileSync(new URL(p, root), 'utf8');

test('production guidance matches current Kailash KB r2 ingress', () => {
  const runbook = text('deploy/README.md');
  assert.match(runbook, /mood\.biodata\.health/);
  assert.match(runbook, /62\.152\.38\.223/);
  assert.match(runbook, /192\.168\.31\.23/);
  assert.match(runbook, /192\.168\.31\.20:3001/);
  assert.match(runbook, /REG\.RU/);
  assert.doesNotMatch(runbook, /mood\s+CNAME\s+app\.biodata\.health/i);
});

test('bootstrap requires existing private IP and does not configure public ingress', () => {
  const script = text('deploy/bootstrap.sh');
  assert.match(script, /MOOD_BIND_IP=192\.168\.31\.20/);
  assert.match(script, /TRUST_PROXY=0/);
  assert.match(script, /ip -4 -o addr show/);
  assert.match(script, /docker compose up --build --detach mood-tracker/);
  assert.doesNotMatch(script, /ufw allow|iptables -A|certbot|nginx -s reload/);
});

test('no mistaken same-host Nginx installer remains', () => {
  assert.equal(existsSync(new URL('deploy/publish-samehost-nginx.sh', root)), false);
  assert.equal(existsSync(new URL('deploy/nginx.samehost.conf', root)), false);
  assert.equal(existsSync(new URL('deploy/nginx.samehost.tls.conf', root)), false);
});

test('shared gateway snippet and support request route only the private backend', () => {
  const snippet = text('deploy/nginx.remote-gateway.conf.example');
  const request = text('deploy/SUPPORT_REQUEST.md');
  const compose = text('compose.yaml');
  assert.match(snippet, /proxy_pass http:\/\/192\.168\.31\.20:3001/);
  assert.match(request, /62\.152\.38\.223/);
  assert.match(request, /192\.168\.31\.23/);
  assert.match(request, /192\.168\.31\.20:3001/);
  assert.match(compose, /MOOD_BIND_IP:-127\.0\.0\.1/);
});
