'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const endpoint = '/api/mobile/ssh-relay';

// Keep original bytes outside the selected server; quoted braces and comments
// must not change the scope of an inserted location.
function blocks(source) {
  const tokens = [];
  const pattern = /#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{};]|(?:\\.|[^{}\s;#"'])+/gy;
  let position = 0;
  while (position < source.length) {
    if (/\s/.test(source[position])) { position++; continue; }
    pattern.lastIndex = position;
    const match = pattern.exec(source);
    if (!match) throw new Error('Unsupported Nginx syntax');
    position = pattern.lastIndex;
    if (!match[0].startsWith('#')) tokens.push({ value: match[0], start: match.index, end: position });
  }
  const root = { children: [] }, stack = [root];
  let words = [];
  for (const token of tokens) {
    if (token.value === '{' || token.value === ';') {
      if (!words.length) throw new Error('Invalid Nginx directive');
      const node = { words: words.map(word => word.value.replace(/^(['"])(.*)\1$/, '$2')),
        start: words[0].start, end: token.end, children: [] };
      stack.at(-1).children.push(node);
      words = [];
      if (token.value === '{') stack.push(node);
    } else if (token.value === '}') {
      if (words.length || stack.length === 1) throw new Error('Invalid Nginx block');
      const node = stack.pop();
      node.close = token.start;
      node.end = token.end;
    } else words.push(token);
  }
  if (words.length || stack.length !== 1) throw new Error('Incomplete Nginx configuration');
  return root;
}

function withRelayLocation(source, domain, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid backend port');
  const servers = [];
  function visit(node) {
    if (node.words?.[0] === 'server' &&
        node.children.some(child => child.words[0] === 'server_name' && child.words.slice(1).includes(domain)) &&
        node.children.some(child => child.words[0] === 'listen' && child.words.includes('ssl'))) servers.push(node);
    node.children.forEach(visit);
  }
  visit(blocks(source));
  if (servers.length !== 1) throw new Error('Exactly one TLS server for the SXB domain is required');
  const server = servers[0];
  const location = `location = ${endpoint} {
        # SXB_SSH_RELAY_V1
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass_request_headers on;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        access_log off;
    }`;
  const existing = server.children.filter(child => child.words[0] === 'location' && child.words.includes(endpoint));
  if (existing.length) {
    if (existing.length !== 1 || source.slice(existing[0].start, existing[0].end) !== location) {
      throw new Error('Conflicting relay location; review it before changing Nginx');
    }
    return source;
  }
  return source.slice(0, server.close) + `\n    ${location}\n` + source.slice(server.close);
}

module.exports = { withRelayLocation, blocks };
if (require.main === module) {
  const [config, output] = process.argv.slice(2);
  if (!config || !output || path.resolve(config) === path.resolve(output)) throw new Error('Input and candidate paths required');
  const backend = createRequire(path.join(__dirname, '..', 'backend', 'package.json'));
  const env = backend('dotenv').parse(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8'));
  const candidate = withRelayLocation(fs.readFileSync(config, 'utf8'), 'vpnsxb.afrihall.com', Number(env.PORT || 3000));
  fs.writeFileSync(output, candidate, { mode: 0o600 });
}
