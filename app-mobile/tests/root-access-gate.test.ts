import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import path from 'node:path';

const requireMobile = createRequire(path.resolve(__dirname, '..', 'package.json'));
const { build } = createRequire(requireMobile.resolve('tsx'))('esbuild');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function harness(check?: () => Promise<string>, present = true) {
  const slots: unknown[] = [], effects: Array<() => (() => void) | void> = [], exits: string[] = [], toasts: string[] = [];
  let cursor = 0, initialized = false, exitFallback = 0;
  const events = new Map<string, (event: { state: string }) => void>();
  const foreground = new Set<(next: string) => void>();
  const useState = (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [slots[index], (value: unknown) => { slots[index] = value; }];
  };
  const useRef = (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  };
  const react = { useState, useRef, useEffect: (effect: () => (() => void) | void) => {
    if (!initialized) effects.push(effect);
  }, Fragment: 'fragment', createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) };
  const native = { Platform: { OS: 'android' }, NativeModules: { SxbVpnNative: present
    ? { checkRootAppAccess: check, exitForRootAccess: (message: string) => exits.push(message) } : undefined },
    AppState: { addEventListener: (_event: string, listener: (next: string) => void) => {
      foreground.add(listener); return { remove: () => foreground.delete(listener) };
    } },
    NativeEventEmitter: class {
      addListener(name: string, listener: (event: { state: string }) => void) {
        events.set(name, listener); return { remove: () => events.delete(name) };
      }
    },
    ToastAndroid: { LONG: 1, show: (message: string) => toasts.push(message) },
    BackHandler: { exitApp: () => { exitFallback++; } },
  };
  const output = await build({
    stdin: { contents: `export { default as Gate } from './components/RootAccessGate';`,
      resolveDir: path.resolve(__dirname, '..'), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{
      name: 'root-gate-localization',
      setup(plugin: { onResolve: (option: object, callback: () => object) => void;
        onLoad: (option: object, callback: () => object) => void }) {
        plugin.onResolve({ filter: /^@\/localization$/ }, () => ({ path: 'locale', namespace: 'fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: `export const useTranslation=()=>({t:()=>'Root approval required {{reference}}'});`, loader: 'js',
        }));
      },
    }],
  });
  const module = { exports: {} as { Gate: (props: { children: string }) => unknown } };
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, console: { warn() {} },
    require: (name: string) => name === 'react' ? react : name === 'react-native' ? native : requireMobile(name) });
  const render = () => {
    cursor = 0;
    const tree = module.exports.Gate({ children: 'protected-app-provider' });
    if (!initialized) { initialized = true; effects.forEach(effect => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }); }
    return tree;
  };
  const cleanups: Array<() => void> = [];
  return { render, exits, toasts, fallbackExits: () => exitFallback, unmount: () => cleanups.forEach(cleanup => cleanup()),
    change: (state: object) => events.get('onRootAppAccessChange')?.({ state: JSON.stringify(state) }),
    foreground: () => foreground.forEach(callback => callback('active')),
  };
}

describe('root startup UI boundary', () => {
  it('mounts no protected app provider until native non-root access is confirmed', async () => {
    const reply = deferred<string>(), h = await harness(() => reply.promise);
    assert.equal(h.render(), null);
    reply.resolve(JSON.stringify({ allowed: true, rooted: false }));
    await nextTurn();
    assert.notEqual(h.render(), null);
    assert.equal(h.exits.length, 0);
    h.unmount();
  });

  it('ejects denied root immediately, with a dashboard reference and no account deletion', async () => {
    const h = await harness(async () => JSON.stringify({ allowed: false, rooted: true, keyId: 'a'.repeat(64) }));
    assert.equal(h.render(), null);
    await nextTurn();
    assert.equal(h.render(), null);
    assert.equal(h.exits.length, 1);
    assert.ok(h.exits[0].includes('a'.repeat(12)));
    h.unmount();
  });

  it('fails closed and exits if the native root check is missing or rejects', async () => {
    for (const present of [false, true]) {
      const h = await harness(async () => { throw new Error('synthetic check unavailable'); }, present);
      assert.equal(h.render(), null);
      await nextTurn();
      assert.equal(h.render(), null);
      assert.equal(present ? h.exits.length : h.fallbackExits(), 1);
      h.unmount();
    }
  });

  it('a late startup approval cannot reopen the app after a root denial broadcast', async () => {
    const reply = deferred<string>(), h = await harness(() => reply.promise);
    h.render();
    h.change({ allowed: false, rooted: true, keyId: 'b'.repeat(64) });
    reply.resolve(JSON.stringify({ allowed: true, rooted: true }));
    await nextTurn();
    assert.equal(h.render(), null);
    assert.equal(h.exits.length, 1);
    h.unmount();
  });

  it('foreground and withdrawal both enforce the gate, while unmounted callbacks cannot update it', async () => {
    let allowed = true;
    const h = await harness(async () => JSON.stringify({ allowed, rooted: true }));
    h.render(); await nextTurn(); assert.notEqual(h.render(), null);
    allowed = false;
    h.foreground(); await nextTurn(); assert.equal(h.render(), null);
    h.unmount();
    h.change({ allowed: true, rooted: true });
    assert.equal(h.render(), null);
  });
});
