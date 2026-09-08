import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dashboard = path.join(root, "artifacts", "sxb-dashboard", "src");
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const read = file => readFileSync(path.join(dashboard, file), "utf8");
const dictionaries = Object.fromEntries(["fr", "en"].map(language => [
  language, JSON.parse(read(path.join("locales", language, "technical.json"))),
]));
const views = ["SSHManagerView", "XrayManagerView", "SingboxManagerView", "PayloadManagerView", "VpnEngineView", "ServersView"];
const componentFiles = [
  ...views.map(name => path.join("components", `${name}.tsx`)),
  ...readdirSync(path.join(dashboard, "components", "technical")).map(name => path.join("components", "technical", name)),
];
const flatten = (value, prefix = "") => Object.fromEntries(Object.entries(value).flatMap(([key, child]) =>
  typeof child === "string" ? [[`${prefix}${key}`, child]] : Object.entries(flatten(child, `${prefix}${key}.`))));
const flat = { fr: flatten(dictionaries.fr), en: flatten(dictionaries.en) };
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
const source = file => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

test("technical dictionaries have complete semantic key and interpolation parity", () => {
  assert.deepEqual(Object.keys(flat.fr).sort(), Object.keys(flat.en).sort());
  for (const [key, value] of Object.entries(flat.fr)) {
    assert.ok(value.trim(), key);
    assert.ok(flat.en[key].trim(), key);
    assert.deepEqual(value.match(/\{\{\w+\}\}/g) ?? [], flat.en[key].match(/\{\{\w+\}\}/g) ?? [], key);
  }
  for (const file of componentFiles) {
    walk(source(file), node => {
      if (ts.isStringLiteral(node) && node.text.startsWith("technical.")) {
        assert.ok(flat.fr[node.text.slice("technical.".length)], `${file}: missing ${node.text}`);
      }
    });
  }
});

test("all six views and lock components have no untranslated JSX prose or locale literals", () => {
  for (const file of componentFiles) {
    const tree = source(file);
    assert.equal(tree.parseDiagnostics.length, 0, file);
    walk(tree, node => {
      if (ts.isJsxText(node)) assert.ok(!/[A-Za-z\u00c0-\u024f]/.test(node.text), `${file}: untranslated ${node.text}`);
      if (ts.isJsxAttribute(node) && ["title", "aria-label", "placeholder", "alt"].includes(node.name.getText(tree)) &&
          node.initializer && ts.isStringLiteral(node.initializer)) {
        const text = node.initializer.text;
        assert.ok(!/[A-Za-z\u00c0-\u024f]/.test(text), `${file}: untranslated attribute ${text}`);
      }
    });
    assert.doesNotMatch(read(file), /toLocale(?:Date|Time)?String\(\s*["']fr|\.toFixed\(/, file);
  }
});

// Evaluate the actual TSX with deterministic React hooks and API doubles.
// No DOM, network, real accounts or production credentials are involved.
function harness(view, accounts = [], role = "ADMIN") {
  let language = "fr";
  let cursor = 0;
  const states = [];
  const calls = [];
  const modules = new Map();
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
    useEffect() {},
    useId: () => "fixture-lock",
  };
  const t = (key, params = {}) => {
    const text = flat[language][key.replace(/^technical\./, "")] ?? key;
    return text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(params[key]));
  };
  const api = new Proxy({}, {
    get: (_, name) => async (...args) => {
      calls.push({ name, args });
      if (String(name).startsWith("fetch") && String(name).endsWith("Accounts")) return accounts;
      if (String(name).startsWith("fetch") && String(name).endsWith("Stats")) return { total: accounts.length, active: 0, byProtocol: [] };
      if (String(name).startsWith("fetch") && String(name).endsWith("Protocols")) return { protocols: ["vless"] };
      if (name === "fetchPayloads") return accounts;
      return { id: "created", isLocked: true, hasLock: true, profileId: "profile" };
    },
  });
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    });
    const module = { exports: {} };
    modules.set(file, module);
    runInNewContext(compiled.outputText, {
      module, exports: module.exports, TextEncoder, setTimeout: () => 0,
      window: { confirm: () => true }, confirm: () => true,
      navigator: { clipboard: { writeText: async value => calls.push({ name: "clipboard", args: [value] }) } },
      require(id) {
        if (id === "react") return react;
        if (id === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
        if (id === "lucide-react") return new Proxy({}, { get: (_, name) => String(name) });
        if (id.endsWith("I18nContext")) return { useTranslation: () => ({
          t, message: t, errorText: (_, fallback) => t(fallback),
          locale: language === "fr" ? "fr-FR" : "en-US",
          formatBytes: value => String(value),
          formatNumber: (value, options) => new Intl.NumberFormat(language, options).format(value),
          formatDate: value => new Intl.DateTimeFormat(language).format(new Date(value)),
        }) };
        if (id.includes("/api/")) return api;
        if (id.endsWith("/types")) return { UserRole: { ADMIN: "ADMIN", SUPPORT: "SUPPORT", OWNER: "OWNER" } };
        if (id.endsWith("/roles")) return { isAdmin: value => ["ADMIN", "SUPER_ADMIN", "OWNER"].includes(value) };
        if (id.startsWith(".")) {
          const resolved = path.resolve(path.dirname(file), id);
          return load(`${resolved}.tsx`);
        }
        throw new Error(`Unexpected test dependency: ${id}`);
      },
    });
    return module.exports;
  }
  const component = load(path.join(dashboard, "components", `${view}.tsx`)).default;
  function render() {
    cursor = 0;
    return component({ currentUserRole: role });
  }
  render();
  if (view !== "VpnEngineView") {
    states[0] = accounts;
    const loading = states.findIndex(value => value === true);
    if (loading !== -1) states[loading] = false;
  }
  const nodes = tree => {
    if (tree == null || typeof tree === "boolean") return [];
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (typeof tree !== "object") return [tree];
    if (typeof tree.type === "function") return nodes(tree.type(tree.props));
    return [tree, ...nodes(tree.props.children)];
  };
  return { states, calls, render, nodes, t, load, setLanguage: value => { language = value; } };
}

test("lock passwords enforce Unicode characters, the UTF-8 byte ceiling and separation from VPN passwords", () => {
  const h = harness("SSHManagerView");
  const { validateLockPassword } = h.load(path.join(dashboard, "components", "technical", "ConfigurationLock.tsx"));
  for (const password of ["12345678", "a".repeat(72), "\u00e9".repeat(36), "\u{1f512}".repeat(18)]) {
    assert.equal(validateLockPassword(password, "vpn-secret"), null);
  }
  for (const password of ["1234567", "\u{1f512}".repeat(7), "a".repeat(73), "\u00e9".repeat(37), "\u{1f512}".repeat(19)]) {
    assert.equal(validateLockPassword(password, "vpn-secret"), "technical.lock.invalidLength");
  }
  assert.equal(validateLockPassword("same-password", "same-password"), "technical.lock.mustDiffer");
});

const locked = {
  id: "locked", name: "Customer name", isLocked: true, hasLock: true, profileId: "profile",
  status: "active", quotaUsed: "0", quotaTotal: null, expireAt: null,
  // Unexpected secret fields must still not be rendered if a server returns them.
  host: "secret-host.invalid", username: "secret-username", port: 12345,
  password: "secret-password", link: "secret-link", content: "secret-payload", network: "secret-network",
};
for (const view of views.slice(0, 4)) {
  for (const role of ["ADMIN", "OWNER", "SUPPORT"]) {
    test(`${view}: ${role} sees only locked metadata and no technical actions`, () => {
      const h = harness(view, [locked], role);
      const nodes = h.nodes(h.render());
      const text = nodes.filter(node => typeof node === "string").join(" ");
      assert.match(text, /Customer name/);
      assert.match(text, /verrouill/);
      assert.doesNotMatch(text, /secret-/);
      assert.equal(nodes.filter(node => node?.type === "input" && node.props.type === "password").length, 0);
      for (const node of nodes.filter(node => node?.type === "button")) {
        const label = node.props["aria-label"] ?? node.props.title;
        assert.ok(!["Modifier", "Supprimer", "Tester la connexion", "Télécharger la configuration", "Copier le lien", "Suspendre"].includes(label));
      }
      assert.equal(h.calls.length, 0);
    });
  }
}

for (const [view, createMethod] of [
  ["SSHManagerView", "createSshAccount"],
  ["XrayManagerView", "createXrayAccount"],
  ["SingboxManagerView", "createSingboxAccount"],
]) {
  test(`${view}: creation requires a separate lock password and clears secrets after success`, async () => {
    const h = harness(view);
    const button = h.nodes(h.render()).find(node => node?.type === "button" &&
      h.nodes(node).some(child => child === h.t(view === "SSHManagerView" ? "technical.ssh.addImport" : "technical.common.newAccount")));
    button.props.onClick();
    const formIndex = h.states.findIndex(value => value && typeof value === "object" && "lockPassword" in value);
    h.states[formIndex] = { ...h.states[formIndex], name: "Unchanged user name", host: "vpn.example.com", port: "443", username: "user", password: "vpn-password", lockPassword: "short" };
    let nodes = h.nodes(h.render());
    assert.ok(nodes.some(node => node?.type === "input" && node.props.name === "lockPassword" && node.props.required && node.props.type === "password"));
    await nodes.find(node => node?.type === "form").props.onSubmit({ preventDefault() {} });
    assert.ok(!h.calls.some(call => call.name === createMethod));
    h.states[formIndex].lockPassword = "independent-lock-password";
    h.setLanguage("en");
    nodes = h.nodes(h.render());
    assert.ok(nodes.some(node => node === "Configuration lock password *"));
    assert.equal(h.states[formIndex].name, "Unchanged user name");
    await nodes.find(node => node?.type === "form").props.onSubmit({ preventDefault() {} });
    const call = h.calls.find(call => call.name === createMethod);
    assert.ok(call);
    assert.equal(call.args[0].password, "vpn-password");
    assert.equal(call.args[0].lockPassword, "independent-lock-password");
    assert.equal(h.states[formIndex].lockPassword, "");
    assert.equal(h.states[formIndex].password, "");
  });

  test(`${view}: legacy accounts remain editable without sending a lock password`, async () => {
    const legacy = {
      id: "legacy", name: "Legacy user name", host: "legacy.example.com", port: 22, username: "user",
      protocol: "vless", mode: "import", quotaUsed: "0", quotaTotal: null, expireAt: null,
      status: "active", maxDevices: 1, connectionLimit: 1, network: "ws", tls: false,
    };
    const h = harness(view, [legacy]);
    let nodes = h.nodes(h.render());
    assert.ok(nodes.some(node => node === "legacy.example.com"));
    const edit = nodes.find(node => node?.type === "button" && (node.props["aria-label"] ?? node.props.title) === h.t("technical.common.edit"));
    assert.ok(edit);
    edit.props.onClick();
    nodes = h.nodes(h.render());
    assert.ok(!nodes.some(node => node?.type === "input" && node.props.name === "lockPassword"));
    await nodes.find(node => node?.type === "form").props.onSubmit({ preventDefault() {} });
    const update = h.calls.find(call => call.name === createMethod.replace("create", "update"));
    assert.ok(update);
    assert.equal(update.args[0], "legacy");
    assert.equal(update.args[1].name, "Legacy user name");
    assert.ok(!("lockPassword" in update.args[1]));
  });
}

test("API inputs carry lockPassword separately and response types discriminate technical fields", () => {
  for (const [file, name] of [["ssh", "Ssh"], ["xray", "Xray"], ["singbox", "Singbox"]]) {
    const text = read(path.join("api", `${file}.ts`));
    assert.match(text, new RegExp(`export type ${name}Account = ${name}AccountDetails \\| LockedEngineAccount`));
    assert.match(text, /lockPassword: string/);
    assert.match(text, new RegExp(`create${name}Account\\(data: Create${name}AccountInput\\)`));
    assert.match(text, /method: 'POST',\s+body: data/);
    assert.doesNotMatch(text, /catch\s*\{\s*return\s*\[\]/);
  }
  assert.match(read(path.join("api", "payload.ts")), /SshPayloadDetails \| LockedSshPayload/);
  for (const file of componentFiles) {
    assert.doesNotMatch(read(file), /localStorage|sessionStorage|console\.(?:log|error)|as any/, file);
  }
});
