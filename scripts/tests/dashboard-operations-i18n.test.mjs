import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const src = path.join(root, "artifacts", "sxb-dashboard", "src");
const names = [
  "DashboardView", "MonitoringView", "SessionsView", "SupportView", "SettingsView",
  "AnnouncementsView", "AppUpdatesView", "MobileHealthView", "OwnerLogView",
  "MaintenancePage", "ErrorBoundary",
];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(path.join(src, "components", `${name}.tsx`), "utf8")]));
const asts = Object.fromEntries(names.map(name => [name, ts.createSourceFile(name, sources[name], ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)]));
const locales = Object.fromEntries(["fr", "en"].map(language => [language, {
  operations: JSON.parse(readFileSync(path.join(src, "locales", language, "operations.json"), "utf8")),
  core: JSON.parse(readFileSync(path.join(src, "locales", language, "core.json"), "utf8")),
}]));
const flatten = (value, prefix = "") => Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
  const full = prefix ? `${prefix}.${key}` : key;
  return typeof child === "string" ? [[full, child]] : Object.entries(flatten(child, full));
}));
const flat = { fr: flatten(locales.fr), en: flatten(locales.en) };
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
const callName = node => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : "";
const parameters = text => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort();

test("operations dictionaries have identical nonempty keys and interpolation contracts", () => {
  assert.deepEqual(Object.keys(flat.fr).sort(), Object.keys(flat.en).sort());
  const keys = Object.keys(flat.fr).filter(key => key.startsWith("operations."));
  assert.ok(keys.length > 300, "The full operations surface is covered, not only menus");
  for (const key of keys) {
    assert.ok(flat.fr[key].trim() && flat.en[key].trim(), key);
    assert.deepEqual(parameters(flat.fr[key]), parameters(flat.en[key]), key);
    assert.doesNotMatch(flat.fr[key] + flat.en[key], /Ã|Â|â€|�/, key);
  }
});

test("all literal keys and finite metadata key maps exist, with required placeholders supplied", () => {
  for (const [name, ast] of Object.entries(asts)) {
    assert.deepEqual(ast.parseDiagnostics, [], name);
    walk(ast, node => {
      if (ts.isStringLiteral(node) && node.text.startsWith("operations.")) {
        assert.ok(flat.fr[node.text] && flat.en[node.text], `${name}: ${node.text}`);
      }
      if (!ts.isCallExpression(node) || !["t", "message"].includes(callName(node.expression))) return;
      const [key, params] = node.arguments;
      if (!key || !ts.isStringLiteral(key) || !key.text.startsWith("operations.")) return;
      const required = parameters(flat.fr[key.text]);
      if (!required.length) return;
      assert.ok(params && ts.isObjectLiteralExpression(params), `${name}: parameters for ${key.text}`);
      const supplied = params.properties.map(property => property.name?.text).sort();
      assert.deepEqual(supplied, required, `${name}: ${key.text}`);
    });
  }
});

// Exact technical exceptions, not a blanket exemption for string literals.
const technical = new Set([
  "SettingsView:jsx:https://vpnsxb.afrihall.com",
  "SettingsView:placeholder:+225 07 XX XX XX",
  "SettingsView:label:Français",
  "SettingsView:label:English",
  "AppUpdatesView:jsx:SUPER_ADMIN",
  "AppUpdatesView:placeholder:19",
  "AppUpdatesView:placeholder:1.9.0",
  "AppUpdatesView:placeholder:https://vpnsxb.afrihall.com/download/sxbvpn-latest.apk",
]);
test("visible text, labels, accessible names and messages are not hardcoded", () => {
  const failures = [];
  for (const [name, ast] of Object.entries(asts)) {
    walk(ast, node => {
      let text;
      let sink;
      if (ts.isJsxText(node)) { text = node.text; sink = "jsx"; }
      if (ts.isStringLiteral(node)) {
        if (ts.isJsxAttribute(node.parent) && ["placeholder", "title", "alt", "aria-label", "label", "sub"].includes(node.parent.name.text)) {
          text = node.text; sink = node.parent.name.text;
        }
        if (ts.isPropertyAssignment(node.parent) && node.parent.initializer === node &&
            ["label", "desc", "description", "hint", "title"].includes(node.parent.name.getText(ast))) {
          text = node.text; sink = node.parent.name.getText(ast);
        }
        if (ts.isCallExpression(node.parent) && ["alert", "confirm", "prompt", "success", "error", "setError", "setProfileError"].includes(callName(node.parent.expression)) &&
            !(ts.isPropertyAccessExpression(node.parent.expression) && node.parent.expression.expression.getText(ast) === "console")) {
          text = node.text; sink = "message";
        }
      }
      if (text !== undefined) {
        const normalized = text.replace(/\s+/g, " ").trim();
        if (/\p{L}/u.test(normalized) && !normalized.startsWith("operations.") &&
            !technical.has(`${name}:${sink}:${normalized}`)) failures.push(`${name}:${sink}: ${normalized}`);
      }
    });
    assert.doesNotMatch(sources[name], /(?:toLocale(?:Date|Time)?String)\(\s*(?:["']|undefined|\))|new Intl\.\w+\(\s*["']|\.toFixed\(/, name);
    assert.doesNotMatch(sources[name], /MutationObserver|querySelectorAll|innerHTML/, name);
  }
  assert.deepEqual(failures, []);
});

function compiled(source, dependency, extras = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(source.replaceAll("import.meta.env.DEV", "false"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  runInNewContext(js, { module, exports: module.exports, require: dependency, console, Date, Intl, ...extras });
  return module.exports;
}

// The existing TypeScript runtime is enough for focused rendering tests. Effects
// and API transport are isolated so switching locale cannot create network I/O.
function renderer(initial = {}) {
  let language = "fr";
  let frame;
  const state = new Map();
  const nodes = [];
  const messages = [];
  const effects = [];
  const stateNames = {};
  for (const ast of Object.values(asts)) walk(ast, node => {
    if (!ts.isVariableDeclaration(node) || !ts.isArrayBindingPattern(node.name) ||
        !node.initializer || !ts.isCallExpression(node.initializer) || callName(node.initializer.expression) !== "useState") return;
    let fn = node.parent;
    while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
    const name = fn?.name?.text;
    if (name) (stateNames[name] ??= []).push(node.name.elements[0].name.text);
  });
  const i18n = compiled(readFileSync(path.join(src, "lib", "i18n.ts"), "utf8"), id => {
    if (id === "../locales") return { dictionaries: locales };
    if (id === "./language") return { getLanguage: () => language, getLocale: lang => (lang ?? language) === "fr" ? "fr-FR" : "en-US" };
    throw new Error(`Unexpected i18n dependency ${id}`);
  });
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const context = () => ({
    language, locale: language === "fr" ? "fr-FR" : "en-US", setLanguage: next => { language = next; },
    t: (key, params) => i18n.translate(language, key, params),
    formatNumber: (value, options) => i18n.formatNumber(value, language, options),
    formatDate: (value, options) => i18n.formatDate(value, language, options),
    formatBytes: (value, decimals) => i18n.formatBytes(value, language, decimals),
    errorMessage: (_error, key) => i18n.translate(language, key),
    message: (key, params) => jsx(() => context().t(key, params), {}),
    errorText: (_error, key) => jsx(() => context().t(key), {}),
  });
  const react = {
    useState(value) {
      const key = `${frame.name}.${stateNames[frame.name]?.[frame.index++]}`;
      if (!state.has(key)) state.set(key, Object.hasOwn(initial, key) ? initial[key] : typeof value === "function" ? value() : value);
      return [state.get(key), next => state.set(key, typeof next === "function" ? next(state.get(key)) : next)];
    },
    useEffect(callback, deps) { effects.push({ callback, deps }); },
    useMemo: callback => callback(),
    useCallback: callback => callback,
    useRef: value => ({ current: value }),
    Component: class {
      constructor(props) { this.props = props; }
      setState(next) { this.state = { ...this.state, ...next }; }
    },
  };
  const modules = {};
  const noopComponent = props => jsx("stub", props);
  const api = new Proxy({}, { get: (_target, key) => key === "APP_ROLES"
    ? ["OWNER", "SUPER_ADMIN", "ADMIN", "SUPPORT", "RESELLER"]
    : async () => { throw new Error(`Unexpected API call: ${key}`); } });
  const getComponent = name => {
    if (!modules[name]) modules[name] = compiled(sources[name], id => {
      if (id === "react") return react;
      if (id === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (id === "../contexts/I18nContext") return { useTranslation: context };
      if (id === "sonner") return { toast: { success: value => messages.push(value), error: value => messages.push(value) } };
      if (id === "../types") return { UserRole: { OWNER: "OWNER", SUPER_ADMIN: "SUPER_ADMIN", ADMIN: "ADMIN", SUPPORT: "SUPPORT", RESELLER: "RESELLER" } };
      if (id === "../lib/roles") return { isSuperAdmin: role => role === "SUPER_ADMIN" || role === "OWNER" };
      if (id.startsWith("../api/")) return api;
      if (id.startsWith("./") && names.includes(id.slice(2))) return getComponent(id.slice(2));
      return new Proxy({ default: noopComponent }, { get: (_target, key) => key === "__esModule" ? true : noopComponent });
    }, {
      window: { confirm: () => true, location: { hash: "" } },
      localStorage: { getItem: () => null },
      navigator: { clipboard: { writeText: async () => {} } },
      setTimeout: () => 0, clearTimeout() {},
      document: { hidden: false },
    });
    return modules[name];
  };
  const visit = element => {
    if (element === null || element === undefined || typeof element === "boolean") return "";
    if (Array.isArray(element)) return element.map(visit).join("");
    if (typeof element !== "object") return String(element);
    if (typeof element.type === "function") {
      const previous = frame;
      frame = { name: element.type.name, index: 0 };
      const result = element.type.prototype?.render
        ? (() => {
          const instance = new element.type(element.props);
          if (initial[`${element.type.name}.hasError`]) instance.state = { hasError: true, error: new Error("test") };
          return instance.render();
        })()
        : element.type(element.props);
      frame = previous;
      return visit(result);
    }
    nodes.push(element);
    return visit(element.props.children);
  };
  return {
    state, nodes, messages, effects, i18n, context,
    language: next => { language = next; },
    render(name, props = {}) { nodes.length = 0; return visit(jsx(getComponent(name).default, props)); },
    text: visit,
  };
}

const log = { id: "l", type: "warning", action: "Historique serveur inchangé", user: "Élodie", timestamp: "2026-09-08T10:30:00Z", ipAddress: "192.0.2.1" };
const mobileDevice = {
  pseudonym: "device-123", appVersion: "1.9.0", versionCode: 19, needsUpdate: true,
  deviceModel: "Pixel", androidApi: 34, tunnelState: "connected", protocol: "vless",
  lastOutcome: "failure", lastErrorCode: "TUNNEL_TIMEOUT", sessionDurationSeconds: 3665,
  reconnectCount: 1200, activeDurationSeconds: 900, backgroundDurationSeconds: 100,
  wakeCount: 1500, reportCount: 2300, batteryOptimization: "unrestricted", lastSeenAt: log.timestamp,
};
const summary = {
  generatedAt: log.timestamp, activeWindowHours: 24, retentionDays: 7, deviceRetentionDays: 30,
  latestVersionCode: 20, detailsTruncated: true, detailsLimit: 100,
  totals: { devices: 2300, active: 2200, inactive: 100, successes: 2300, failures: 200, successRate: 92.123, updatesNeeded: 700, reports: 12345 },
  versions: [{ appVersion: "1.9.0", versionCode: 19, devices: 2300, updatesNeeded: 700 }],
  devices: [mobileDevice],
};

test("all eleven screens render in both languages, including dialogs, failures and loaded data", () => {
  const fixtures = [
    ["DashboardView", { currentUserRole: "OWNER" }, {
      loading: false, stats: { activeUsers: 1234, expiredAccounts: 1, resellerQuota: { assignedBytes: "9007199254740993", committedBytes: "1024", remainingBytes: "9007199254739969", resellerCount: 2 } },
      logs: [log], servers: [{ id: "s", name: "Serveur client", ip: "192.0.2.1", status: "online", cpuLoad: 10.5, ramLoad: 11.5, activeUsers: 1234 }],
      trafficData: [{ time: "lun.", download: 1.23, upload: 0.1 }],
    }, "Exploitation", "Operations"],
    ["MonitoringView", { currentUserRole: "SUPPORT", defaultTab: "logs" }, {}, "Surveillance", "monitoring"],
    ["SessionsView", {}, { loading: false, sessions: [{ id: "s", clientName: "Élodie", status: "active", deviceId: "device-123", clientToken: "TOKEN", activationDate: log.timestamp }] }, "Sessions utilisateurs", "User sessions"],
    ["SupportView", {}, { loading: false, showAddTicket: true, tickets: [{ id: "t", title: "Titre utilisateur", clientName: "Élodie", priority: "high", status: "open", createdAt: log.timestamp }], error: { key: "operations.support.createError" } }, "Créer le Ticket", "Create ticket"],
    ["SettingsView", { currentUser: { name: "Élodie", email: "user@example.test" } }, {}, "Informations personnelles", "Personal information"],
    ["AnnouncementsView", {}, { loading: false, formOpen: true, announcements: [{ id: "a", title: "Titre utilisateur", message: "Texte utilisateur", level: "warning", active: true, createdAt: log.timestamp, expiresAt: "2099-01-01" }] }, "Nouvelle annonce", "New announcement"],
    ["AppUpdatesView", { currentUserRole: "SUPER_ADMIN" }, { loading: false }, "Publier et distribuer", "Publish and distribute"],
    ["MobileHealthView", {}, { loading: false, summary }, "Sans restriction", "Unrestricted"],
    ["OwnerLogView", {}, { loading: false, logs: [log], maintenance: { enabled: true, loading: false } }, "Journal propriétaire", "Owner log"],
    ["MaintenancePage", {}, { showOwnerAccess: true }, "Maintenance en cours", "Maintenance in progress"],
    ["ErrorBoundary", {}, { hasError: true }, "Une erreur est survenue", "An error occurred"],
  ];
  for (const [name, props, seed, frText, enText] of fixtures) {
    const f = renderer(Object.fromEntries(Object.entries(seed).map(([key, value]) => [`${name}.${key}`, value])));
    assert.ok(f.render(name, props).includes(frText), `${name}: French text`);
    const stateBefore = [...f.state];
    f.language("en");
    const english = f.render(name, props);
    assert.ok(english.includes(enText), `${name}: English text`);
    assert.doesNotMatch(english, /\boperations\.[a-z]/, `${name}: unresolved key`);
    assert.deepEqual([...f.state], stateBefore, `${name}: locale must preserve state`);
    if (["DashboardView", "OwnerLogView"].includes(name)) assert.ok(english.includes(log.action), `${name}: historical log remains verbatim`);
  }
});

test("open forms and errors rerender without clearing user values; all settings tabs are translated", () => {
  const props = { currentUser: { name: "Élodie", email: "user@example.test" } };
  const f = renderer({ "SettingsView.profileError": { cause: new Error("failure") } });
  f.render("SettingsView", props);
  const input = f.nodes.find(node => node.type === "input" && node.props.placeholder === "Votre nom");
  input.props.onChange({ target: { value: "Nom saisi par l'utilisateur" } });
  f.language("en");
  assert.match(f.render("SettingsView", props), /Failed to save profile/);
  assert.equal(f.nodes.find(node => node.type === "input" && node.props.placeholder === "Your name").props.value, "Nom saisi par l'utilisateur");
  for (const [tab, expected] of [["team", "Open account management"], ["security", "Signed tokens"], ["api", "Generate token"], ["language", "Language & region"]]) {
    f.state.set("SettingsView.activeTab", tab);
    assert.ok(f.render("SettingsView", props).includes(expected), tab);
  }
});

test("core formatting remains locale-aware and exact; duration, percentage and counters follow language", () => {
  const f = renderer({ "MobileHealthView.loading": false, "MobileHealthView.summary": summary });
  const french = f.render("MobileHealthView");
  assert.ok(french.includes("1 h 01 min"));
  assert.ok(french.includes(new Intl.NumberFormat("fr-FR").format(12345)));
  f.language("en");
  const english = f.render("MobileHealthView");
  assert.ok(english.includes("1 hr 01 min"));
  assert.ok(english.includes("92.1%"));
  assert.ok(english.includes("12,345"));
  assert.ok(english.includes("TUNNEL_TIMEOUT") && english.includes("vless"));
  const huge = 9007199254740993n * 1024n ** 6n;
  assert.equal(f.i18n.formatBytes(huge.toString(), "en"), "9,007,199,254,740,993 EB");
  assert.equal(f.i18n.formatBytes("1536", "fr"), "1,5 Ko");
  assert.equal(f.i18n.formatBytes("1536", "en"), "1.5 KB");
});

test("server weekday tokens and traffic tooltips are localized without modifying traffic data", () => {
  const traffic = [{ time: "lun.", download: 1.2345, upload: 0.1 }];
  const f = renderer({ "DashboardView.loading": false, "DashboardView.trafficData": traffic });
  f.render("DashboardView", { currentUserRole: "RESELLER" });
  const frenchAxis = f.nodes.find(node => node.props.dataKey === "time");
  assert.equal(frenchAxis.props.tickFormatter("lun."), "lun.");
  f.language("en");
  f.render("DashboardView", { currentUserRole: "RESELLER" });
  const englishAxis = f.nodes.find(node => node.props.dataKey === "time");
  assert.equal(englishAxis.props.tickFormatter("lun."), "Mon");
  assert.equal(englishAxis.props.tickFormatter("server-opaque-time"), "server-opaque-time");
  const tooltip = f.nodes.find(node => node.props.content)?.props.content;
  assert.ok(tooltip);
  const props = { active: true, label: "lun.", payload: [{ name: "Download", value: 1.2345, color: "blue" }] };
  assert.match(f.text({ ...tooltip, props }), /Mon.*1\.235 GB/);
  f.language("fr");
  assert.match(f.text({ ...tooltip, props }), /lun\..*1,235 Go/);
  assert.deepEqual(f.state.get("DashboardView.trafficData"), traffic);
});

test("async error notifications stay reactive without adding language to fetch effect dependencies", async () => {
  const f = renderer();
  f.render("AppUpdatesView", { currentUserRole: "SUPER_ADMIN" });
  await f.effects[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.messages.length, 1);
  assert.equal(f.text(f.messages[0]), "Impossible de charger la version publiée");
  f.language("en");
  assert.equal(f.text(f.messages[0]), "Unable to load the published version");
  for (const name of ["DashboardView", "AppUpdatesView", "SupportView", "MobileHealthView"]) {
    assert.doesNotMatch(sources[name], /},\s*\[(?:[^\]]*,\s*)?(?:language|locale|t)(?:,|\])/);
  }
  assert.match(sources.DashboardView, /POLL_INTERVAL_MS = 30_000/);
  assert.match(sources.DashboardView, /document\.hidden \|\| pollInFlightRef\.current/);
  assert.match(sources.DashboardView, /formatBytes\(resellerQuota\?\.assignedBytes\)/);
  assert.doesNotMatch(sources.DashboardView, /\bNumber\(resellerQuota/);
});
