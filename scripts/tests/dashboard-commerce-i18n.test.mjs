import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = path.join(root, "artifacts", "sxb-dashboard", "src");
const require = createRequire(path.join(root, "package.json"));
const dashboardRequire = createRequire(path.join(src, "..", "package.json"));
const ts = require("typescript");
const React = dashboardRequire("react");
const names = ["AccountsView", "ClientsView", "DevicesView", "SubscriptionsView", "TokensView", "VouchersView", "ResellersView", "RBACView", "ResellerServicesView", "ResellerAccessBanner"];
const flatten = (object, prefix = "") => Object.fromEntries(Object.entries(object).flatMap(([key, value]) =>
  typeof value === "string" ? [[prefix + key, value]] : Object.entries(flatten(value, `${prefix}${key}.`))));
const dictionaries = Object.fromEntries(["fr", "en"].map(language => [language,
  Object.fromEntries(readdirSync(path.join(src, "locales", language)).filter(file => file.endsWith(".json")).map(file =>
    [file.slice(0, -5), JSON.parse(readFileSync(path.join(src, "locales", language, file), "utf8"))]))]));
const flat = Object.fromEntries(["fr", "en"].map(language => [language, flatten(dictionaries[language])]));
const source = name => readFileSync(path.join(src, "components", `${name}.tsx`), "utf8");

test("commerce dictionaries have matching keys and interpolation parameters", () => {
  const fr = flatten(dictionaries.fr.commerce);
  const en = flatten(dictionaries.en.commerce);
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  assert.ok(Object.keys(fr).length > 400);
  for (const key of Object.keys(fr)) {
    assert.ok(fr[key].trim() && en[key].trim(), key);
    const params = value => [...value.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort();
    assert.deepEqual(params(fr[key]), params(en[key]), key);
  }
});

// These are data formats, not interface messages. Do not translate identifiers.
const technical = new Set(["SXB-XXXX-XXXX-XXXX", "VCH-XXXXX-XXXXX", "+225 07 XX XX XX", "+225 07 XX XX XX XX", "awa@example.com"]);
test("commerce JSX, accessible attributes and static translation calls are localized", () => {
  const failures = [];
  for (const name of names) {
    const ast = ts.createSourceFile(`${name}.tsx`, source(name), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const reportLiteral = (text, kind) => {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (/\p{L}/u.test(normalized) && !technical.has(normalized)) failures.push(`${name} ${kind}: ${normalized}`);
    };
    const visit = node => {
      if (ts.isJsxText(node)) reportLiteral(node.text, "JSX");
      if (ts.isJsxAttribute(node) && ["title", "placeholder", "alt", "aria-label"].includes(node.name.text) && node.initializer && ts.isStringLiteral(node.initializer)) reportLiteral(node.initializer.text, node.name.text);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["t", "message"].includes(node.expression.text) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const key = node.arguments[0].text;
        for (const language of ["fr", "en"]) {
          const value = flat[language][key];
          if (!value) { failures.push(`${name}: missing ${language}:${key}`); continue; }
          const parameters = [...value.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]);
          const supplied = node.arguments[1];
          for (const parameter of parameters) {
            if (!supplied || ts.isObjectLiteralExpression(supplied) && !supplied.properties.some(property => property.name?.text === parameter)) failures.push(`${name}: missing ${key} {{${parameter}}}`);
          }
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^toLocale(Date|Time)?String$/.test(node.expression.name.text)) {
        if (!node.arguments[0] || ts.isStringLiteral(node.arguments[0])) failures.push(`${name}: browser-default or fixed locale`);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  assert.deepEqual(failures, []);
});

test("system RBAC permission codes retain localized descriptions and categories", () => {
  const seed = ["seed.ts", "seed-rbac.ts"].map(file => readFileSync(path.join(root, "prisma", file), "utf8")).join("\n");
  const database = readFileSync(path.join(root, "server", "database.ts"), "utf8");
  const codes = new Set([...`${seed}\n${database}`.matchAll(/name:\s*['"]([a-z_]+\.[a-z_]+)['"]/g)].map(match => match[1]));
  for (const code of codes) for (const language of ["fr", "en"]) {
    assert.ok(flat[language][`commerce.rbac.permissions.${code}`], `${language}:${code}`);
    assert.ok(flat[language][`commerce.rbac.categories.${code.split(".")[0]}`], `${language}:${code} category`);
  }
});

// Execute the real component functions with a deterministic hook scheduler.
// Only effects/API/UI infrastructure are stubbed; the translation, error and
// BigInt formatters are real. Register every on-disk namespace in this fixture,
// as the integration owner wires commerce into locales/index.ts separately.
function fixture() {
  const cache = new Map();
  const states = new Map();
  const effects = [];
  const calls = [];
  const toasts = [];
  const downloads = [];
  let slots;
  let cursor = 0;
  const client = { id: "client-1", name: "Nom utilisateur", user: { name: "Nom utilisateur", email: "user@example.com" }, token: "SXB-OPAQUE", status: "active", quotaTotal: "-1", quotaUsed: "1536", resellerName: "Entreprise FR", expireAt: "2027-01-02T00:00:00Z" };
  const reseller = { id: "reseller-1", name: "Entreprise FR", email: "reseller@example.com", status: "active", accessState: "active", quotaState: "unlimited", quotaUnlimited: true, clientsCount: 1234, accessExpiresAt: "2027-01-02T00:00:00Z" };
  const subscription = { id: "sub-1", name: "Forfait utilisateur", clientId: client.id, client, profileId: "profile-1", profile: { name: "Profil utilisateur", protocol: "vless" }, status: "active", quotaBytes: "-1", quotaUsed: "9007199254740993", dataToken: "DATA-OPAQUE", durationDays: 30, deviceLimit: 1, expireAt: "2027-01-02T00:00:00Z" };
  const roles = ["OWNER", "SUPER_ADMIN", "ADMIN", "SUPPORT", "RESELLER"].map(name => ({ id: name, name, description: "Description serveur", permissions: [] }));
  const responses = {
    fetchAccounts: [{ id: "account-1", name: "Compte utilisateur", email: "account@example.com", role: { name: "ADMIN" }, status: "active" }],
    fetchRolesForCreation: roles, listAdminTokens: [], fetchResellerReconciliation: { totals: { orphanRoleUsers: 0 } },
    fetchClients: [client], fetchResellers: [reseller], fetchResellerQuotaHistory: [],
    fetchDevices: [{ id: "device-1", deviceId: "SXBDEVICE", label: "Appareil utilisateur", token: "DEVICE-OPAQUE", status: "active", quotaUsed: "1536", quotaTotal: "-1", quotaRemaining: "-1", trafficDownload: "1536", trafficUpload: "0", trafficTotal: "1536", expireAt: "2027-01-02T00:00:00Z" }],
    fetchSubscriptions: [subscription], fetchSubStats: { total: 1234, active: 1234, expired: 0 },
    fetchVpnProfiles: [{ id: "profile-1", name: "Profil utilisateur", status: "active", protocol: "vless" }],
    fetchAssignedVpnProfiles: [{ id: "profile-1", name: "Profil utilisateur", displayProtocol: "vless" }],
    fetchTokens: [{ id: "token-1", clientId: client.id, token: "TOKEN-OPAQUE", quota: "-1", status: "active", expiration: "2027-01-02T00:00:00Z" }],
    fetchVouchers: [{ id: "voucher-1", code: "VCH-OPAQUE", quota: "-1", status: "active", durationDays: 30 }],
    fetchRoles: roles, fetchPermissions: [{ id: "permission-1", code: "clients.manage", description: "Suspendre et réactiver clients", category: "clients" }],
    apiRequest: { profiles: [{ id: "service-1", name: "Service utilisateur", displayProtocol: "vless" }] },
  };
  const api = new Proxy({}, { get: (_, name) => async (...args) => {
    calls.push([name, ...args]);
    return typeof responses[name] === "function" ? responses[name](...args) : responses[name] ?? {};
  } });
  let access = null;
  let core;
  const hooks = {
    ...React,
    useState(initial) {
      const owned = slots;
      const index = cursor++;
      if (!(index in owned)) owned[index] = { value: typeof initial === "function" ? initial() : initial };
      return [owned[index].value, next => { owned[index].value = typeof next === "function" ? next(owned[index].value) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo: compute => compute(),
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies?.some((dependency, i) => !Object.is(dependency, previous.dependencies[i]))) {
        slots[index] = { dependencies };
        effects.push(effect);
      }
    },
  };
  const i18n = () => ({
    t: (key, params) => core.translate(core.getLanguage(), key, params),
    language: core.getLanguage(), locale: core.getLocale(), setLanguage: core.setLanguage,
    formatNumber: (value, options) => core.formatNumber(value, core.getLanguage(), options),
    formatDate: (value, options) => core.formatDate(value, core.getLanguage(), options),
    formatBytes: (value, decimals) => core.formatBytes(value, core.getLanguage(), decimals),
    errorMessage: (error, fallback) => errors.errorMessage(error, core.getLanguage(), fallback),
    message: (key, params) => React.createElement(() => core.translate(core.getLanguage(), key, params)),
    errorText: (error, fallback) => React.createElement(() => errors.errorMessage(error, core.getLanguage(), fallback)),
  });
  const document = { createElement: () => ({ click() { downloads.at(-1).filename = this.download; } }) };
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    if (file.endsWith(`${path.sep}locales${path.sep}index.ts`)) return { dictionaries };
    if (file.endsWith("I18nContext.tsx")) return { useTranslation: i18n };
    if (file.endsWith("PermissionsContext.tsx")) return { usePermissions: () => () => true };
    if (file.endsWith("ResellerAccessContext.tsx")) return { useResellerAccess: () => ({
      access, blocked: access?.accessState === "expired" || access?.accessState === "suspended",
      quotaReached: access?.quotaState === "reached", error: null,
      allows: options => accessHelpers.canPerform(access, options), refresh: async () => {},
    }) };
    if (file.includes(`${path.sep}api${path.sep}`)) return api;
    if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"));
    const module = { exports: {} };
    cache.set(file, module);
    const localRequire = specifier => {
      if (specifier === "react") return hooks;
      if (specifier === "sonner") return { toast: new Proxy({}, { get: (_, kind) => value => toasts.push({ kind, value }) }) };
      if (specifier === "lucide-react") return new Proxy({}, { get: () => () => null });
      if (!specifier.startsWith(".")) return dashboardRequire(specifier);
      const target = path.resolve(path.dirname(file), specifier);
      const resolved = [target, `${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")].find(candidate => existsSync(candidate) && /\.[jt]sx?$|\.json$/.test(candidate));
      if (!resolved) throw new Error(`Cannot resolve ${specifier} from ${file}`);
      return load(resolved);
    };
    const js = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    runInNewContext(js, {
      module, exports: module.exports, require: localRequire, console, Intl, Date, Blob,
      window: { confirm: () => true, prompt: () => null, alert: value => toasts.push({ kind: "alert", value }) },
      document, navigator: { language: "fr-FR", clipboard: { writeText: async () => {} } },
      URL: { createObjectURL: blob => { downloads.push({ blob }); return "blob:commerce"; }, revokeObjectURL: () => {} },
      setTimeout: () => 0, clearTimeout: () => {},
    }, { filename: file });
    return module.exports;
  }
  core = { ...load(path.join(src, "lib", "i18n.ts")), ...load(path.join(src, "lib", "language.ts")) };
  const errors = load(path.join(src, "lib", "errors.ts"));
  const accessHelpers = load(path.join(src, "lib", "resellerAccess.ts"));
  function invoke(component, props, id) {
    const previous = [slots, cursor];
    if (!states.has(id)) states.set(id, []);
    slots = states.get(id);
    cursor = 0;
    const node = component(props);
    [slots, cursor] = previous;
    return node;
  }
  function expand(node, id = "tree") {
    if (Array.isArray(node)) return node.flatMap((child, i) => expand(child, `${id}.${i}`));
    if (node === null || node === undefined || typeof node === "boolean") return [];
    if (typeof node !== "object") return [String(node)];
    if (typeof node.type === "function") return expand(invoke(node.type, node.props, `${id}:${node.type.name}`), `${id}.child`);
    return [{ ...node, children: expand(node.props?.children, `${id}.children`) }];
  }
  function render(name, props = {}, exported = "default") {
    const component = load(path.join(src, "components", `${name}.tsx`))[exported];
    return expand(invoke(component, { currentUserRole: "SUPER_ADMIN", actorName: "Operator", permissions: ["vouchers.create", "vouchers.redeem", "vouchers.revoke", "clients.view", "reseller.manage"], onRolePermissionsUpdated() {}, ...props }, name));
  }
  return {
    render, setLanguage: core.setLanguage, core, responses, calls, downloads, toasts, expand,
    setAccess: next => { access = next; },
    async flush() { for (const effect of effects.splice(0)) effect(); await new Promise(resolve => setImmediate(resolve)); },
  };
}
const nodes = tree => tree.flatMap(node => typeof node === "object" ? [node, ...nodes(node.children)] : []);
const text = tree => tree.map(node => typeof node === "object" ? text(node.children) : node).join(" ").replace(/\s+/g, " ").trim();
const button = (tree, label) => nodes(tree).find(node => node.type === "button" && text(node.children).includes(label));
const formValues = tree => nodes(tree).filter(node => ["input", "select"].includes(node.type) && node.props.value !== undefined).map(node => node.props.value);

for (const [name, title, create] of [
  ["AccountsView", "accounts.title", "accounts.create"],
  ["ClientsView", "clients.title", "clients.add"],
  ["DevicesView", "devices.title", "devices.generate"],
  ["SubscriptionsView", "subscriptions.title", "subscriptions.assign"],
  ["TokensView", "tokens.title", "tokens.generate"],
  ["VouchersView", "vouchers.title", "vouchers.create"],
  ["ResellersView", "resellers.title", "resellers.create"],
]) test(`${name}: changing FR/EN updates the open form without clearing entered values`, async () => {
  const f = fixture();
  f.render(name);
  await f.flush();
  let tree = f.render(name);
  assert.ok(text(tree).includes(flat.fr[`commerce.${title}`]));
  const createButton = button(tree, flat.fr[`commerce.${create}`]);
  assert.ok(createButton, `${name}: create button`);
  createButton.props.onClick();
  tree = f.render(name);
  const form = nodes(tree).filter(node => node.type === "form").at(-1);
  assert.ok(form, `${name}: opened form`);
  const editable = nodes(form.children).find(node => node.type === "input" && node.props.onChange && !["checkbox", "date", "datetime-local"].includes(node.props.type));
  assert.ok(editable, `${name}: editable field`);
  const entered = editable.props.type === "number" ? "73" : "Saisie utilisateur conservée";
  editable.props.onChange({ target: { value: entered } });
  tree = f.render(name);
  const values = formValues(tree);
  f.setLanguage("en");
  tree = f.render(name);
  assert.ok(text(tree).includes(flat.en[`commerce.${title}`]));
  assert.deepEqual(formValues(tree), values);
  assert.ok(formValues(tree).includes(editable.props.type === "number" ? 73 : entered));
  assert.doesNotMatch(text(tree), /commerce\.[a-z]/);
  f.setLanguage("fr");
  assert.deepEqual(formValues(f.render(name)), values);
});

test("local validation errors follow language changes while the device form stays open", async () => {
  const f = fixture();
  f.render("DevicesView"); await f.flush();
  button(f.render("DevicesView"), flat.fr["commerce.devices.generate"]).props.onClick();
  const form = nodes(f.render("DevicesView")).find(node => node.type === "form");
  await form.props.onSubmit({ preventDefault() {} });
  assert.ok(text(f.render("DevicesView")).includes(flat.fr["commerce.devices.idRequired"]));
  f.setLanguage("en");
  assert.ok(text(f.render("DevicesView")).includes(flat.en["commerce.devices.idRequired"]));
  assert.equal(f.calls.filter(([name]) => name === "generateDeviceToken").length, 0);
});

test("stored HTTP 400 validation errors retain diagnostics and translate on language change", async () => {
  const f = fixture();
  f.responses.createToken = () => { throw { status: 400, responseData: { error: "errors.validation", details: [{ path: ["quotaGb"], code: "too_small", type: "number", minimum: 1, inclusive: true }] } }; };
  f.render("TokensView"); await f.flush();
  button(f.render("TokensView"), flat.fr["commerce.tokens.generate"]).props.onClick();
  let tree = f.render("TokensView");
  nodes(tree).find(node => node.type === "select").props.onChange({ target: { value: "client-1" } });
  tree = f.render("TokensView");
  await nodes(tree).find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  const french = text(f.render("TokensView"));
  assert.match(french, /quotaGb/);
  f.setLanguage("en");
  const english = text(f.render("TokensView"));
  assert.match(english, /quotaGb/);
  assert.notEqual(french, english);
  assert.ok(formValues(f.render("TokensView")).includes("client-1"));
});

test("RBAC sensitive confirmation rerenders its permission description without changing the code", async () => {
  const f = fixture();
  f.render("RBACView"); await f.flush();
  const tree = f.render("RBACView");
  nodes(tree).find(node => node.type === "input" && node.props["aria-label"] === "clients.manage pour SUPPORT").props.onChange();
  assert.ok(text(f.render("RBACView")).includes(flat.fr["commerce.rbac.confirmSensitive"]));
  f.setLanguage("en");
  const english = text(f.render("RBACView"));
  assert.ok(english.includes("Suspend and reactivate clients"));
  assert.ok(english.includes("clients.manage"));
  assert.ok(english.includes(flat.en["commerce.rbac.confirmSensitive"]));
  assert.equal(f.calls.filter(([name]) => name === "updateRolePermissions").length, 0);
});

test("service names, quota boundaries and access banners remain correct in both languages", async () => {
  const f = fixture();
  f.render("ResellerServicesView"); await f.flush();
  f.setLanguage("en");
  assert.match(text(f.render("ResellerServicesView")), /Available VPN services.*Service utilisateur/);
  f.setAccess({ accessState: "expired", quotaState: "unlimited", quotaUnlimited: true, quotaBytes: "-1", quotaAllocatedBytes: "9007199254740993", accessExpiresAt: "2026-01-02T00:00:00Z" });
  const banner = text(f.render("ResellerAccessBanner", {}, "ResellerAccessBanner"));
  assert.match(banner, /Access expired/);
  assert.match(text(f.render("ResellerAccessBanner", {}, "ResellerAccessSummaryCard")), /Unlimited/);
  f.setAccess({ accessState: "active", quotaState: "reached", quotaUnlimited: false, quotaBytes: "0", quotaAllocatedBytes: "0", quotaRemainingBytes: "0" });
  assert.match(text(f.render("ResellerAccessBanner", {}, "ResellerAccessSummaryCard")), /0 B/);
  const huge = 9007199254740993n * 1024n ** 6n;
  assert.equal(f.core.formatBytes(huge), `${new Intl.NumberFormat("en-US").format(9007199254740993n)} EB`);
});

test("CSV headers, status and durations use the selected language without translating client data", async () => {
  const f = fixture();
  f.render("SubscriptionsView"); await f.flush();
  button(f.render("SubscriptionsView"), flat.fr["commerce.subscriptions.export"]).props.onClick();
  f.setLanguage("en");
  button(f.render("SubscriptionsView"), flat.en["commerce.subscriptions.export"]).props.onClick();
  assert.equal(f.downloads[0].filename, "forfaits.csv");
  assert.equal(f.downloads[1].filename, "plans.csv");
  const french = await f.downloads[0].blob.text();
  const english = await f.downloads[1].blob.text();
  assert.match(french, /^"Nom","Client","Profil"/);
  assert.match(english, /^"Name","Client","Profile"/);
  assert.match(english, /"Active"/);
  assert.match(english, /"30 d"/);
  assert.match(english, /Forfait utilisateur/);
  assert.match(english, /Nom utilisateur/);
});

test("client creation keeps manual plan assignment and its existing success toast reacts to language changes", async () => {
  const f = fixture();
  f.render("ClientsView"); await f.flush();
  button(f.render("ClientsView"), flat.fr["commerce.clients.add"]).props.onClick();
  let tree = f.render("ClientsView");
  const form = nodes(tree).find(node => node.type === "form");
  nodes(form.children).find(node => node.type === "input" && node.props.required).props.onChange({ target: { value: "Client sans plan" } });
  tree = f.render("ClientsView");
  await nodes(tree).find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  const creations = f.calls.filter(([name]) => /^create|generate/.test(name));
  assert.equal(creations.length, 1);
  assert.equal(creations[0][0], "createClient");
  assert.equal(creations[0][1].name, "Client sans plan");
  const notification = f.toasts.find(toast => toast.kind === "success");
  assert.equal(text(f.expand(notification.value)), flat.fr["commerce.clients.created"]);
  f.setLanguage("en");
  assert.equal(text(f.expand(notification.value)), flat.en["commerce.clients.created"]);
});
