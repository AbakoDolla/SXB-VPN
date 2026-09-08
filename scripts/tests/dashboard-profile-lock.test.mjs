import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(root, 'backend', 'package.json'));
const ts = require('typescript');
const { build } = require('esbuild');
const src = path.join(root, 'artifacts', 'sxb-dashboard', 'src');
const flatten = (value, prefix = '') => Object.fromEntries(Object.entries(value).flatMap(([key, child]) =>
  typeof child === 'string' ? [[`${prefix}${key}`, child]] : Object.entries(flatten(child, `${prefix}${key}.`))));
const dictionaries = Object.fromEntries(['fr', 'en'].map(language => [language,
  flatten(JSON.parse(readFileSync(path.join(src, 'locales', language, 'configurations.json'), 'utf8')))]));
const locked = {
  id: 'profile', name: 'User supplied name', status: 'active', hasLock: true, isLocked: true,
  offlineValidDays: 7, createdAt: '2026-09-08T12:00:00Z', _count: { subscriptions: 0 },
  host: 'secret-host.invalid', port: 443, username: 'secret-user', password: 'secret-password',
  protocol: 'vless', network: 'ws', hasCanonicalConfig: true, canonicalConfigHash: 'secret-hash',
};

async function fixture(role = 'ADMIN') {
  let language = 'fr';
  let now = Date.parse('2026-09-08T12:00:00Z');
  let cursor = 0;
  const states = [], calls = [], pendingEffects = [], timers = new Map(), modules = new Map();
  const overrides = {};
  const documentEvents = new Map();
  let nextTimer = 0;
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const t = (key, params = {}) => (dictionaries[language][key.replace(/^configurations\./, '')] ?? key)
    .replace(/\{\{(\w+)\}\}/g, (_, name) => String(params[name]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = { current: initial };
      return states[index];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = states[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        states[index] = { deps };
        pendingEffects.push(() => {
          previous?.cleanup?.();
          states[index].cleanup = callback();
        });
      }
    },
  };
  const api = new Proxy({}, { get: (_, name) => async (...args) => {
    calls.push({ name, args });
    if (overrides[name]) return overrides[name](...args);
    if (name === 'fetchVpnProfiles') return [{ ...locked }];
    if (name === 'fetchVpnProfileStats') return { total: 1, active: 1, byProtocol: [] };
    if (name === 'fetchResellers') return [{ id: 'reseller', name: 'Reseller name' }];
    if (name === 'fetchPayloads') return [];
    if (name === 'unlockVpnProfile') return {
      unlockToken: 'memory-only-proof', expiresAt: new Date(now + 600_000).toISOString(),
      profile: { ...locked, isLocked: false, unlockExpiresAt: new Date(now + 600_000).toISOString() },
    };
    if (name === 'testProfileConfig') return { success: true, validationStatus: 'transport_ok' };
    if (name === 'importVpnProfiles') return { profiles: [{ ...locked }], imported: 1, warnings: [] };
    return { ...locked };
  } });
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file, compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
      },
    });
    const module = { exports: {} };
    modules.set(file, module);
    runInNewContext(compiled.outputText, {
      module, exports: module.exports, TextEncoder, URLSearchParams, atob, console,
      Date: class extends Date { static now() { return now; } },
      document: {
        hidden: false, addEventListener: (name, fn) => documentEvents.set(name, fn),
        removeEventListener: name => documentEvents.delete(name),
      },
      setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
      clearTimeout: id => timers.delete(id),
      alert: value => calls.push({ name: 'alert', args: [value] }), confirm: () => true,
      require(id) {
        if (id === 'react') return react;
        if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
        if (id === 'lucide-react') return new Proxy({}, { get: (_, name) => String(name) });
        if (id.endsWith('I18nContext')) return { useTranslation: () => ({
          t, locale: language === 'fr' ? 'fr-FR' : 'en-US',
          message: (key, params) => jsx(() => t(key, params)),
          errorMessage: () => t('configurations.ui.error'),
          errorText: () => jsx(() => t('configurations.ui.error')),
        }) };
        if (id.includes('/api/')) return api;
        if (id.endsWith('/roles')) return { isAdmin: value => ['ADMIN', 'SUPER_ADMIN', 'OWNER'].includes(value) };
        if (id.endsWith('/types')) return {};
        if (id.startsWith('.')) return load(`${path.resolve(path.dirname(file), id)}.tsx`);
        throw new Error(`Unexpected import ${id}`);
      },
    });
    return module.exports;
  }
  const component = load(path.join(src, 'components', 'VpnProfilesView.tsx')).default;
  function render() { cursor = 0; return component({ currentUserRole: role }); }
  async function flush() {
    for (let i = 0; i < 5; i++) {
      render();
      for (const effect of pendingEffects.splice(0)) effect();
      await Promise.resolve();
    }
    return render();
  }
  function nodes(tree) {
    if (tree == null || typeof tree === 'boolean') return [];
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (typeof tree !== 'object') return [tree];
    if (typeof tree.type === 'function') {
      if (tree.type.name === 'ProfileLockDialog') return [tree];
      return nodes(tree.type(tree.props));
    }
    return [tree, ...nodes(tree.props.children)];
  }
  const text = () => nodes(render()).filter(n => typeof n === 'string').join(' ');
  const button = key => nodes(render()).find(n => n?.type === 'button' &&
    (n.props['aria-label'] === t(key) || nodes(n).includes(t(key))));
  const dialog = () => nodes(render()).find(n => n?.type?.name === 'ProfileLockDialog');
  await flush();
  return {
    states, calls, overrides, render, nodes, flush, t, text, button, dialog, load,
    setLanguage: value => { language = value; },
    advance: async ms => {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      await flush();
    },
  };
}

for (const role of ['ADMIN', 'SUPER_ADMIN', 'OWNER']) {
  test(`${role}: locked metadata stays assignable but technical data and mutations stay hidden`, async () => {
    const h = await fixture(role);
    assert.match(h.text(), /User supplied name/);
    assert.doesNotMatch(h.text(), /secret-/);
    assert.equal(h.button('configurations.ui.edit').props.disabled, true);
    assert.equal(h.button('configurations.ui.delete').props.disabled, true);
    h.button('configurations.ui.assign').props.onClick();
    assert.match(h.text(), /Reseller name/);
    assert.ok(!JSON.stringify(h.states).includes('secret-'));
    h.setLanguage('en');
    assert.match(h.text(), /VPN profiles/);
    assert.match(h.text(), /User supplied name/);
    assert.doesNotMatch(h.text(), /configurations\./);
  });
}

test('unlock proofs are temporary; relocking clears detail, forms and in-flight probe results', async () => {
  const h = await fixture();
  h.button('configurations.lock.open').props.onClick();
  await h.dialog().props.onSubmit('configuration-password');
  await h.flush();
  assert.match(h.text(), /secret-host/);
  assert.equal(h.button('configurations.ui.edit').props.disabled, false);
  h.button('configurations.ui.edit').props.onClick();
  let finishProbe;
  h.overrides.testProfileConfig = () => new Promise(resolve => { finishProbe = resolve; });
  const request = h.button('configurations.ui.testImported').props.onClick();
  assert.equal(h.calls.find(c => c.name === 'testProfileConfig').args[1], 'memory-only-proof');
  await h.advance(600_001);
  finishProbe({ validationStatus: 'invalid', probe: { hint: 'secret-late-result' } });
  await request;
  await h.flush();
  assert.doesNotMatch(h.text(), /secret-/);
  assert.ok(!JSON.stringify(h.states).includes('secret-'));
  assert.ok(!JSON.stringify(h.states).includes('memory-only-proof'));
  assert.equal(h.button('configurations.ui.edit').props.disabled, true);
});

test('a cancelled unlock cannot reveal late data; rotation immediately relocks', async () => {
  const h = await fixture();
  let finish;
  h.overrides.unlockVpnProfile = () => new Promise(resolve => { finish = resolve; });
  h.button('configurations.lock.open').props.onClick();
  const dialog = h.dialog();
  const request = dialog.props.onSubmit('configuration-password');
  dialog.props.onClose();
  finish({ unlockToken: 'late-proof', expiresAt: '2026-09-08T12:10:00Z', profile: { ...locked, isLocked: false } });
  await request; await h.flush();
  assert.doesNotMatch(h.text(), /secret-/);
  delete h.overrides.unlockVpnProfile;
  h.button('configurations.lock.open').props.onClick();
  await h.dialog().props.onSubmit('configuration-password'); await h.flush();
  h.button('configurations.lock.rotate').props.onClick();
  await h.dialog().props.onSubmit('replacement-password'); await h.flush();
  assert.equal(h.calls.find(c => c.name === 'setVpnProfileLock').args[2], 'memory-only-proof');
  assert.doesNotMatch(h.text(), /secret-/);
});

test('creation requires an independent password and clears passwords and import text after success', async () => {
  const h = await fixture();
  const { validProfilePassword } = h.load(path.join(src, 'components', 'ProfileLockDialog.tsx'));
  for (const value of ['12345678', 'é'.repeat(36), '🔐'.repeat(18)]) assert.equal(validProfilePassword(value), true);
  for (const value of ['1234567', 'é'.repeat(37), '🔐'.repeat(7), 'abcdefgh\0']) assert.equal(validProfilePassword(value), false);
  h.button('configurations.ui.import').props.onClick();
  const input = name => h.nodes(h.render()).find(n => n?.type === 'input' && n.props.name === name);
  input('lockPassword').props.onChange({ target: { value: 'configuration-password' } });
  input('lockConfirmation').props.onChange({ target: { value: 'configuration-password' } });
  const formIndex = h.states.findIndex(value => value && typeof value === 'object' && 'offlineValidDays' in value && 'dns' in value);
  h.states[formIndex] = { ...h.states[formIndex], name: 'User name unchanged' };
  h.nodes(h.render()).find(n => n?.type === 'textarea').props.onChange({ target: { value: 'vless://secret-user@host.test:443' } });
  await h.nodes(h.render()).find(n => n?.type === 'form').props.onSubmit({ preventDefault() {} });
  await h.flush();
  const created = h.calls.find(c => c.name === 'createVpnProfile');
  assert.equal(created.args[0].lockPassword, 'configuration-password');
  assert.equal(created.args[0].name, 'User name unchanged');
  assert.ok(!JSON.stringify(h.states).includes('configuration-password'));
  assert.ok(!JSON.stringify(h.states).includes('vless://secret-user'));
  assert.equal(h.calls.some(c => c.name === 'testProfileConfig'), false);
});

test('profile screen has no untranslated application prose and both dictionaries resolve every literal key', () => {
  for (const filename of ['VpnProfilesView.tsx', 'ProfileLockDialog.tsx']) {
    const file = path.join(src, 'components', filename);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    assert.equal(source.parseDiagnostics.length, 0);
    const technical = new Set(['sha256:', 'badvpn-udpgw', 'SNI', 'UUID', 'TLS/SSL']);
    const walk = node => {
      if (ts.isJsxText(node) && /[A-Za-zÀ-ÿ]/.test(node.text)) assert.ok(technical.has(node.text.trim()), node.text);
      if (ts.isStringLiteral(node) && node.text.startsWith('configurations.')) {
        for (const language of ['fr', 'en']) assert.ok(dictionaries[language][node.text.slice(15)], node.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
});

test('actual API client sends proofs only on explicitly requested profile operations and never persists passwords', async () => {
  const bundle = await build({
    entryPoints: [path.join(src, 'api', 'vpn-profiles.ts')], bundle: true,
    platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  });
  const calls = [], writes = [];
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    localStorage: { getItem: key => key === 'sxb_access_token' ? 'access-token' : null, setItem: (...args) => writes.push(args) },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return { ok: true, status: 200, text: async () => '{"profile":{"id":"profile"},"profiles":[]}' };
    },
  });
  await module.exports.unlockVpnProfile('profile', 'configuration-password');
  await module.exports.updateVpnProfile('profile', { name: 'New name' }, 'proof');
  await module.exports.testProfileConfig('profile', 'proof');
  await module.exports.setProfileResellers('profile', ['reseller']);
  await module.exports.fetchSubscriptions();
  assert.equal(JSON.parse(calls[0].body).password, 'configuration-password');
  assert.equal(calls[0].headers['X-VPN-Profile-Unlock'], undefined);
  assert.equal(calls[1].headers['X-VPN-Profile-Unlock'], 'proof');
  assert.equal(calls[2].headers['X-VPN-Profile-Unlock'], 'proof');
  assert.equal(calls[3].headers['X-VPN-Profile-Unlock'], undefined);
  assert.equal(calls[4].headers['X-VPN-Profile-Unlock'], undefined);
  assert.ok(calls.every(c => !c.url.includes('proof') && !c.url.includes('password')));
  assert.equal(writes.length, 0);
});
