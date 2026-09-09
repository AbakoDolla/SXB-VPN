import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const src = path.join(root, "artifacts", "sxb-dashboard", "src");
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const compiled = new Map();
export const OLD_CODE = "SXB-USER-DEMO-OLD0-0001";
export const NEW_CODE = "SXB-USER-DEMO-NEW0-0002";
const future = "2028-01-15T12:00:00.000Z";
const activatedAt = "2026-09-01T12:00:00.000Z";
export const client = {
  id: "client-1", userId: "user-1", deviceId: "SXBDEVICE-DEMO", token: OLD_CODE,
  user: { name: "Fixture client", email: "client@example.test" },
  status: "active", expireAt: future, activatedAt, quotaTotal: "0", quotaUsed: "0",
  resellerId: "reseller-1", resellerName: "Fixture reseller",
};
export const subscription = {
  id: "plan-1", clientId: client.id, client, name: "Fixture plan", profileId: "profile-1",
  profile: { name: "Fixture profile", protocol: "vless" }, status: "active",
  dataToken: "DATA-DEMO-ONLY", durationDays: 30, deviceLimit: 1, deviceId: client.deviceId,
  quotaBytes: String(5 * 1024 ** 3), quotaUsed: String(1024 ** 3),
  expireAt: "2027-01-15T12:00:00.000Z",
};
export const device = {
  id: "device-1", deviceId: client.deviceId, token: OLD_CODE, label: "Fixture device",
  status: "active", expireAt: future, activatedAt, createdAt: activatedAt,
  resellerId: "reseller-1", resellerName: "Fixture reseller",
  hasSubscription: true, subscriptionId: subscription.id, subscriptionName: subscription.name,
  subscriptionStatus: subscription.status, subscriptionExpireAt: subscription.expireAt,
  quotaSource: "subscription", quotaUsed: subscription.quotaUsed, quotaTotal: subscription.quotaBytes,
  quotaRemaining: String(4 * 1024 ** 3), trafficDownload: "1024", trafficUpload: "512", trafficTotal: "1536",
};
export const plain = value => JSON.parse(JSON.stringify(value));
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
export const nodes = tree => (Array.isArray(tree) ? tree : [tree]).flatMap(node =>
  node && typeof node === "object" ? [node, ...nodes(node.children ?? [])] : []);
export const text = tree => (Array.isArray(tree) ? tree : [tree]).map(node =>
  node && typeof node === "object" ? text(node.children ?? []) : node ?? "").join(" ").replace(/\s+/g, " ").trim();

export function fixture(view = "DevicesView", options = {}) {
  const states = new Map(), modules = new Map(), effects = [], timers = new Map();
  const calls = [], toasts = [], copies = [], confirmations = [], logs = [], overrides = {};
  let role = options.role ?? "SUPER_ADMIN";
  let permissions = new Set(options.permissions ?? ["clients.view", "clients.create", "clients.manage", "clients.delete", "subscription.manage", "reseller.manage"]);
  let access = options.access ?? { accessState: "active", quotaState: "available", quotaBytes: "100000000000", quotaAllocatedBytes: "0" };
  let now = Date.parse("2026-09-09T06:00:00Z");
  let slots, cursor = 0, visited;
  let clipboard = async value => { copies.push(value); };
  let confirm = () => true;
  const data = {
    devices: [plain(device)], clients: [plain(client)], subscriptions: [plain(subscription)],
    resellers: [{ id: "reseller-1", name: "Fixture reseller", email: "reseller@example.test" }],
    profiles: [{ id: "profile-1", name: "Fixture profile", status: "active", protocol: "vless" }],
    ...options.data,
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const hooks = {
    useState(initial) {
      const owner = slots, index = cursor++;
      if (!(index in owner)) owner[index] = { value: typeof initial === "function" ? initial() : initial };
      return [owner[index].value, value => { owner[index].value = typeof value === "function" ? value(owner[index].value) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo: compute => compute(),
    useEffect(effect, deps) {
      const owner = slots, index = cursor++, previous = owner[index];
      if (!previous || deps?.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        owner[index] = { deps };
        effects.push(() => { previous?.cleanup?.(); owner[index].cleanup = effect(); });
      }
    },
  };
  function replace(kind, id, changes) {
    const row = data[kind].find(item => item.id === id);
    if (!row) throw new Error("Missing fixture row");
    Object.assign(row, changes);
    return plain(row);
  }
  const api = new Proxy({}, { get: (_, method) => async (...args) => {
    calls.push([method, ...plain(args)]);
    if (overrides[method]) return overrides[method](...args);
    if (method === "fetchDevices") return plain(data.devices);
    if (method === "fetchClients") return plain(data.clients);
    if (method === "fetchSubscriptions") return plain(data.subscriptions);
    if (method === "fetchResellers") return plain(data.resellers);
    if (method === "fetchVpnProfiles" || method === "fetchAssignedVpnProfiles") return plain(data.profiles);
    if (method === "fetchSubStats") return { total: data.subscriptions.length, active: 1, expired: 0 };
    if (method === "suspendDevice" || method === "resumeDevice" || method === "revokeDevice") {
      return replace("devices", args[0], { status: method === "suspendDevice" ? "suspended" : method === "resumeDevice" ? "active" : "disabled" });
    }
    if (method === "suspendClient" || method === "activateClient") return replace("clients", args[0], { status: method === "suspendClient" ? "suspended" : "active" });
    if (method === "renewDevice" || method === "renewClient") {
      const kind = method === "renewDevice" ? "devices" : "clients";
      const row = data[kind].find(item => item.id === args[0]);
      return replace(kind, args[0], { token: NEW_CODE, status: "active", expireAt: new Date(Math.max(now, Date.parse(row.expireAt)) + (args[1] ?? 30) * 86400000).toISOString() });
    }
    if (method === "resetClientAccess") return replace("clients", args[0], { token: NEW_CODE });
    if (method === "updateSubscription") return replace("subscriptions", args[0], args[1]);
    if (method === "revokeSubscription") return replace("subscriptions", args[0], { status: "revoked" });
    if (method === "deleteClient" || method === "deleteSubscription") {
      const kind = method === "deleteClient" ? "clients" : "subscriptions";
      data[kind] = data[kind].filter(row => row.id !== args[0]);
      return;
    }
    if (method === "createClient") return { ...plain(client), id: "new-client" };
    if (method === "generateDeviceToken") return { ...plain(device), id: "new-device", token: NEW_CODE };
    if (method === "createSubscription") return plain(subscription);
    if (method === "bulkSubscriptions") return {
      action: args[0].action, selected: 1, succeeded: 1, skipped: 0, failed: 0,
      details: [{ id: "plan-1", status: "succeeded" }],
    };
    throw new Error(`Unexpected fixture API method: ${String(method)}`);
  } });
  let i18n, errors, accessHelpers;
  function load(file) {
    file = path.resolve(file);
    if (modules.has(file)) return modules.get(file).exports;
    if (file.endsWith("I18nContext.tsx")) return { useTranslation: () => ({
      t: (key, params) => i18n.translate(i18n.getLanguage(), key, params),
      language: i18n.getLanguage(), locale: i18n.getLocale(),
      formatNumber: (value, opts) => i18n.formatNumber(value, i18n.getLanguage(), opts),
      formatDate: (value, opts) => i18n.formatDate(value, i18n.getLanguage(), opts),
      formatBytes: value => i18n.formatBytes(value, i18n.getLanguage()),
      message: (key, params) => jsx(() => i18n.translate(i18n.getLanguage(), key, params)),
      errorMessage: (error, fallback) => errors.errorMessage(error, i18n.getLanguage(), fallback),
      errorText: (error, fallback) => jsx(() => errors.errorMessage(error, i18n.getLanguage(), fallback)),
    }) };
    if (file.endsWith("PermissionsContext.tsx")) return { usePermissions: () => permission => role === "OWNER" || permissions.has(permission) };
    if (file.endsWith("ResellerAccessContext.tsx")) return { useResellerAccess: () => ({
      access, allows: opts => role !== "RESELLER" || !!access && accessHelpers.canPerform(access, opts),
      refresh: async () => {}, blocked: false, quotaReached: access?.quotaState === "reached",
    }) };
    if (file.endsWith("ResellerAccessBanner.tsx")) return { ResellerAccessSummaryCard: () => null, ResellerActionNotice: () => null };
    if (file.includes(`${path.sep}api${path.sep}`) && !file.endsWith(`${path.sep}client.ts`)) return api;
    if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"));
    const module = { exports: {} };
    modules.set(file, module);
    if (!compiled.has(file)) compiled.set(file, ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText);
    runInNewContext(compiled.get(file), {
      module, exports: module.exports, Intl,
      Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
      console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
      window: { confirm: value => { confirmations.push(value); return confirm(value); } },
      navigator: { language: "fr-FR", clipboard: { writeText: value => clipboard(value) } },
      setTimeout: callback => { const id = Symbol(); timers.set(id, callback); return id; },
      clearTimeout: id => timers.delete(id),
      require(specifier) {
        if (specifier === "react") return hooks;
        if (specifier === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
        if (specifier === "lucide-react") return new Proxy({}, { get: (_, name) => String(name) });
        if (specifier === "sonner") return { toast: new Proxy({}, { get: (_, kind) => value => toasts.push({ kind, value }) }) };
        if (!specifier.startsWith(".")) throw new Error(`Unexpected dependency: ${specifier}`);
        const target = path.resolve(path.dirname(file), specifier);
        const resolved = [target, `${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")].find(candidate => existsSync(candidate) && /\.(?:tsx?|json)$/.test(candidate));
        if (!resolved) throw new Error(`Cannot resolve ${specifier}`);
        return load(resolved);
      },
    }, { filename: file });
    return module.exports;
  }
  i18n = { ...load(path.join(src, "lib", "i18n.ts")), ...load(path.join(src, "lib", "language.ts")) };
  errors = load(path.join(src, "lib", "errors.ts"));
  accessHelpers = load(path.join(src, "lib", "resellerAccess.ts"));
  const component = load(path.join(src, "components", `${view}.tsx`)).default;
  function invoke(fn, props, id) {
    const previous = [slots, cursor];
    visited?.add(id);
    if (!states.has(id)) states.set(id, []);
    slots = states.get(id); cursor = 0;
    const result = fn(props);
    [slots, cursor] = previous;
    return result;
  }
  function expand(node, id = "tree") {
    if (Array.isArray(node)) return node.flatMap((value, i) => expand(value, `${id}.${value?.key ?? i}`));
    if (node == null || typeof node === "boolean") return [];
    if (typeof node !== "object") return [String(node)];
    if (typeof node.type === "function") return expand(invoke(node.type, node.props, `${id}:${node.type.name}:${node.key ?? ""}`), `${id}.child`);
    return [{ ...node, children: expand(node.props.children, `${id}.children`) }];
  }
  function render() {
    visited = new Set();
    const tree = expand(invoke(component, { currentUserRole: role, actorName: "Fixture operator" }, view));
    for (const [id, owned] of states) if (!visited.has(id)) {
      for (const state of owned) state?.cleanup?.();
      states.delete(id);
    }
    visited = undefined;
    return tree;
  }
  const t = (key, params) => i18n.translate(i18n.getLanguage(), key, params);
  return {
    calls, toasts, copies, confirmations, logs, overrides, data, render, expand, load, t, states,
    setLanguage: i18n.setLanguage,
    setRole: value => { role = value; },
    setPermissions: value => { permissions = new Set(value); },
    setAccess: value => { access = value; },
    setClipboard: value => { clipboard = value; },
    setConfirm: value => { confirm = value; },
    advance: ms => { now += ms; for (const fn of timers.values()) fn(); timers.clear(); },
    button: (key, tree = render(), params) => nodes(tree).find(node => node.type === "button" &&
      (node.props.title === t(key, params) || node.props["aria-label"] === t(key, params) || text(node.children) === t(key, params))),
    async flush() {
      let tree;
      for (let i = 0; i < 3; i++) {
        tree = render();
        for (const effect of effects.splice(0)) effect();
        await new Promise(resolve => setImmediate(resolve));
      }
      return render();
    },
  };
}
