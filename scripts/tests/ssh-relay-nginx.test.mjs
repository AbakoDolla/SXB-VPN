import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const { withRelayLocation } = createRequire(import.meta.url)('../configure-ssh-relay-nginx.cjs');
const domain = 'vpnsxb.afrihall.com';
const other = 'server { listen 443 ssl; server_name panel.example; location / { return 200; } }\n';
const redirect = `server { listen 80; server_name ${domain}; return 301 https://$host$request_uri; }\n`;
const tls = `server {
    listen 443 ssl;
    server_name "${domain}";
    # } misleading comment {
    location / { add_header X-Test "} {"; try_files $uri /index.html; }
    location /api/ { proxy_pass http://127.0.0.1:4000; }
}\n`;

test('relay ingress edits only the exact TLS vhost, preserves APIs and is idempotent', () => {
  const original = other + redirect + tls;
  const result = withRelayLocation(original, domain, 4000);
  assert.ok(result.startsWith(other + redirect));
  assert.ok(result.includes('location /api/ { proxy_pass http://127.0.0.1:4000; }'));
  assert.equal(result.match(/SXB_SSH_RELAY_V1/g).length, 1);
  assert.match(result, /location = \/api\/mobile\/ssh-relay/);
  assert.match(result, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(result, /proxy_pass http:\/\/127\.0\.0\.1:4000;/);
  assert.equal(withRelayLocation(result, domain, 4000), result);
});

test('ambiguous, missing, conflicting or malformed ingress fails without a candidate', () => {
  for (const value of [other, redirect, tls + tls, tls.slice(0, -3),
    tls.replace('location / {', 'location = /api/mobile/ssh-relay {')]) {
    assert.throws(() => withRelayLocation(value, domain, 4000));
  }
  for (const port of [0, 65536, NaN, 1.5]) assert.throws(() => withRelayLocation(tls, domain, port));
});
