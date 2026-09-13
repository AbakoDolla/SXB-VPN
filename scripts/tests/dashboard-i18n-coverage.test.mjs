import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const sourceRoot = path.join(root, "artifacts", "sxb-dashboard", "src");

// Exceptions identify an exact file, UI sink and literal, never a whole file,
// language, regular expression or a snapshot of untranslated legacy labels.
const exceptions = [
  { file: "App.tsx", sink: "jsx", text: "SXB VPN", reason: "Product name" },
  { file: "App.tsx", sink: "attribute:placeholder", text: "admin@example.com", reason: "Example email address" },
  { file: "App.tsx", sink: "attribute:placeholder", text: "SXB-XXXX-XXXX-XXXX", reason: "Opaque token syntax" },
  { file: "components/Layout.tsx", sink: "jsx", text: "SXB VPN", reason: "Product name" },
  { file: "components/Layout.tsx", sink: "attribute:alt", text: "SXB VPN", reason: "Product logotype" },
  { file: "components/Layout.tsx", sink: "attribute:alt", text: "SXB VPN", reason: "Product logotype" },
  { file: "components/Layout.tsx", sink: "expression", text: "U", reason: "Fallback avatar initial, not a role label" },
  { file: "components/AccountsView.tsx", sink: "attribute:placeholder", text: "+225 07 XX XX XX", reason: "Example phone syntax" },
  { file: "components/ClientsView.tsx", sink: "attribute:placeholder", text: "+225 07 XX XX XX XX", reason: "Example phone syntax" },
  { file: "components/ResellersView.tsx", sink: "attribute:placeholder", text: "+225 07 XX XX XX", reason: "Example phone syntax" },
  { file: "components/ResellersView.tsx", sink: "attribute:placeholder", text: "awa@example.com", reason: "Example email address" },
  { file: "components/SettingsView.tsx", sink: "attribute:placeholder", text: "+225 07 XX XX XX", reason: "Example phone syntax" },
  { file: "components/SettingsView.tsx", sink: "jsx", text: "https://vpnsxb.afrihall.com", reason: "Literal product URL" },
  { file: "components/AppUpdatesView.tsx", sink: "attribute:placeholder", text: "https://vpnsxb.afrihall.com/download/sxbvpn-latest.apk", reason: "Literal release URL syntax" },
  { file: "components/TokensView.tsx", sink: "jsx", text: "SXB-XXXX-XXXX-XXXX", reason: "Opaque account token syntax" },
  { file: "components/VouchersView.tsx", sink: "attribute:placeholder", text: "VCH-XXXXX-XXXXX", reason: "Opaque voucher syntax" },
  ...["VLESS", "VMess", "Trojan", "Shadowsocks", "Hysteria2", "TUIC"].map(text => ({
    file: "components/VpnProfilesView.tsx", sink: "property:label", text, reason: "Standard VPN protocol name",
  })),
  ...["sha256:", "badvpn-udpgw", "SNI", "UUID", "TLS/SSL"].map(text => ({
    file: "components/VpnProfilesView.tsx", sink: "jsx", text, reason: "Technical identifier",
  })),
  ...["ubuntu", "t.example.com", "example.com", "9dbbfb7374360504…",
    "CONNECT exemple.com HTTP/1.1[crlf]Host: exemple.com[crlf]User-Agent: Mozilla/5.0[crlf][crlf]"].map(text => ({
      file: "components/VpnProfilesView.tsx", sink: "attribute:placeholder", text, reason: "Exact example of technical input syntax",
    })),
];

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(fullPath) : /\.tsx?$/.test(entry.name) ? [fullPath] : [];
  });
}

function flatten(value, prefix = "") {
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [[fullKey, child]] : Object.entries(flatten(child, fullKey));
  }));
}

function dictionary(language) {
  const directory = path.join(sourceRoot, "locales", language);
  return Object.fromEntries(readdirSync(directory).filter(file => file.endsWith(".json")).flatMap(file =>
    Object.entries(flatten(JSON.parse(readFileSync(path.join(directory, file), "utf8")), file.slice(0, -5)))));
}

const dictionaries = { fr: dictionary("fr"), en: dictionary("en") };
const resolve = (language, key) => dictionaries[language][key] ?? dictionaries[language][`common.${key}`];
const normalize = text => text.replace(/\s+/g, " ").trim();
const hasWords = text => /\p{L}/u.test(text);
const isString = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const propertyName = node => node && (ts.isIdentifier(node) || isString(node)) ? node.text : undefined;
const humanProperties = new Set(["label", "title", "description", "hint", "tooltip", "placeholder", "text", "message", "emptyText", "loadingText", "errorText"]);
const humanAttributes = new Set([...humanProperties, "alt", "aria-label", "aria-roledescription", "aria-description"]);
const translatedCalls = new Set(["t", "translate", "message", "errorText", "errorMessage", "formatNumber", "formatDate", "formatBytes", "formatRelativeTime"]);

function calleeName(expression) {
  return ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
}

function insideStyling(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isPropertyAssignment(parent) || ts.isJsxAttribute(parent)) &&
      ["classNames", "className", "style", "variants", "theme"].includes(propertyName(parent.name))) return true;
    if (ts.isVariableDeclaration(parent) && ["classNames", "className", "style", "variants", "theme"].includes(propertyName(parent.name))) return true;
    if (ts.isFunctionLike(parent)) return false;
  }
  return false;
}

function insideTranslation(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent) && translatedCalls.has(calleeName(parent.expression))) return true;
    if (ts.isFunctionLike(parent)) return false;
  }
  return false;
}

export function auditSource(text, file = "fixture.tsx", allowed = exceptions) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings = [];
  const reported = new Set();
  const bindings = new Map();
  const collect = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const declarations = bindings.get(node.name.text) ?? [];
      declarations.push(node.initializer);
      bindings.set(node.name.text, declarations);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const report = (node, sink, raw) => {
    const content = normalize(raw);
    if (!hasWords(content)) return;
    if (allowed.some(entry => entry.file === file && entry.sink === sink && entry.text === content)) return;
    const id = `${node.getStart(source)}:${sink}:${content}`;
    if (reported.has(id)) return;
    reported.add(id);
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ file, line: position.line + 1, column: position.character + 1, sink, text: content });
  };

  // Resolve named constants and indexed label maps, but never execute source.
  // Unknown server/user values are deliberately not guessed or translated.
  const candidates = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return [];
    const next = new Set(seen).add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return candidates(node.expression, next);
    if (ts.isIdentifier(node)) return (bindings.get(node.text) ?? []).flatMap(value => candidates(value, next));
    if (ts.isConditionalExpression(node)) return [...candidates(node.whenTrue, next), ...candidates(node.whenFalse, next)];
    if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) {
      const objects = candidates(node.expression, next);
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : isString(node.argumentExpression) ? node.argumentExpression.text : undefined;
      return objects.flatMap(object => {
        if (ts.isObjectLiteralExpression(object)) return object.properties.flatMap(property =>
          ts.isPropertyAssignment(property) && (key === undefined || propertyName(property.name) === key) ? candidates(property.initializer, next) : []);
        if (ts.isArrayLiteralExpression(object)) return object.elements.flatMap(value => candidates(value, next));
        return [];
      });
    }
    return [node];
  };

  const inspectValue = (node, sink, seen = new Set()) => {
    if (!node || seen.has(node)) return;
    const next = new Set(seen).add(node);
    if (isString(node)) {
      const keyContainer = sink.startsWith("property:") || /^call:set\w*Error$/.test(sink);
      if (!keyContainer || !resolve("fr", node.text) || !resolve("en", node.text)) report(node, sink, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const literalText = node.head.text + node.templateSpans.map(span => span.literal.text).join("");
      if (hasWords(literalText)) {
        report(node, sink, node.head.text + node.templateSpans.map(span => `{{value}}${span.literal.text}`).join(""));
      }
      node.templateSpans.forEach(span => inspectValue(span.expression, sink, next));
      return;
    }
    if (ts.isConditionalExpression(node)) {
      inspectValue(node.whenTrue, sink, next);
      inspectValue(node.whenFalse, sink, next);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(operator)) inspectValue(node.left, sink, next);
      if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(operator)) inspectValue(node.right, sink, next);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach(value => inspectValue(value, sink, next));
      return;
    }
    if (ts.isCallExpression(node)) {
      if (translatedCalls.has(calleeName(node.expression))) return;
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "map") {
        const callback = node.arguments[0];
        if (callback && ts.isArrowFunction(callback) && !ts.isBlock(callback.body)) {
          if (ts.isIdentifier(callback.body) && callback.parameters.some(parameter => propertyName(parameter.name) === callback.body.text)) {
            inspectValue(node.expression.expression, sink, next);
          } else inspectValue(callback.body, sink, next);
        }
      }
      return;
    }
    for (const value of candidates(node)) {
      if (value !== node) inspectValue(value, sink, next);
    }
  };

  const visit = node => {
    if (ts.isJsxText(node)) report(node, "jsx", node.text);
    if (ts.isJsxAttribute(node) && humanAttributes.has(propertyName(node.name)) && node.initializer) {
      const initializer = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
      inspectValue(initializer, `attribute:${propertyName(node.name)}`);
    }
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression) inspectValue(node.expression, "expression");
    if (ts.isPropertyAssignment(node) && humanProperties.has(propertyName(node.name)) && !insideStyling(node) && !insideTranslation(node)) {
      inspectValue(node.initializer, `property:${propertyName(node.name)}`);
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression) ?? "";
      const toast = ts.isIdentifier(node.expression) && name === "toast" ||
        ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "toast";
      if (["t", "message"].includes(name) && node.arguments[0]) {
        const prefix = file === "lib/errors.ts" && name === "t" ? "errors.validationIssue." : "";
        for (const candidate of candidates(node.arguments[0])) {
          if (isString(candidate)) {
            const key = prefix + candidate.text;
            if (!resolve("fr", key) || !resolve("en", key)) report(candidate, "missing-key", key);
          }
        }
      }
      if (toast || ["confirm", "prompt", "alert"].includes(name) || /^set\w*Error$/.test(name)) {
        inspectValue(node.arguments[0], `call:${toast ? "toast" : name}`);
      }
      if (/^toLocale(?:Date|Time)?String$/.test(name)) {
        const locale = node.arguments[0];
        if (!locale || isString(locale) || locale.kind === ts.SyntaxKind.UndefinedKeyword || ts.isIdentifier(locale) && locale.text === "undefined") {
          report(node, "fixed-locale", node.getText(source));
        }
      }
    }
    if (ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Intl" &&
      ["DateTimeFormat", "NumberFormat", "RelativeTimeFormat", "ListFormat"].includes(node.expression.name.text)) {
      const locale = node.arguments?.[0];
      if (!locale || isString(locale)) report(node, "fixed-locale", node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

const files = sourceFiles(sourceRoot);
const audit = () => files.flatMap(fullPath => auditSource(readFileSync(fullPath, "utf8"), path.relative(sourceRoot, fullPath).split(path.sep).join("/")));

if (process.argv.includes("--report")) {
  const findings = audit();
  console.log(JSON.stringify({ files: files.length, findings: findings.length, items: findings }, null, 2));
  process.exitCode = findings.length ? 1 : 0;
} else {
  test("AST audit catches JSX, accessible labels, messages, choices and external constants", () => {
    const findings = auditSource(`
      const labels = { active: { label: "Actif" }, expired: { label: "Expired" } };
      const choices = ["Mensuel", "Annuel"];
      const caption = "Choisir une offre";
      export function View() {
        toast.error("Impossible de charger");
        confirm("Delete this account?");
        setFormError("Adresse invalide");
        return <main title="Gestion" aria-label={caption}>
          Bonjour <span>{ok ? "Oui" : "No"}</span>
          <span>{labels[state].label}</span>
          {choices.map(choice => choice)}
          <input placeholder="Rechercher" />
        </main>;
      }
    `);
    for (const text of ["Actif", "Expired", "Mensuel", "Annuel", "Choisir une offre", "Impossible de charger", "Delete this account?", "Adresse invalide", "Gestion", "Bonjour", "Oui", "No", "Rechercher"]) {
      assert.ok(findings.some(finding => finding.text === text), `Must flag ${text}`);
    }
  });

  test("AST audit distinguishes UI text from CSS, translation calls and user data", () => {
    assert.deepEqual(auditSource(`
      const route = "subscriptions";
      const classNames = { description: "text-gray-500" };
      export function View() {
        const { t, message, errorText, formatNumber } = useTranslation();
        toast.success(message("core.login.signIn"));
        toast.error(errorText(error));
        return <main className={active ? "text-cyan-400" : "text-gray-500"} title={t("core.login.subtitle")}>
          {t("core.login.signIn")}{formatNumber(count)}{client.name}
          <input value={token} />
        </main>;
      }
    `), []);
    assert.ok(auditSource('<span>Nouvelle chaîne</span>', "App.tsx").length);
    assert.ok(auditSource('<span>{"core.login.signIn"}</span>').some(item => item.sink === "expression"));
    assert.equal(auditSource('<span>SXB VPN</span>', "App.tsx").length, 0);
    assert.ok(auditSource('<span>SXB VPN</span>', "unapproved.tsx").length);
  });

  test("AST audit checks finite dynamic key maps as well as literal t calls", () => {
    const findings = auditSource(`
      const labels = { active: "core.login.signIn", expired: "core.login.doesNotExist" };
      const option = { text: "core.login.subtitle" };
      export function View() { return <span>{t(labels[state])}{t(option.text)}</span>; }
    `);
    assert.ok(findings.some(item => item.sink === "missing-key" && item.text === "core.login.doesNotExist"));
    assert.ok(!findings.some(item => item.sink === "missing-key" && item.text === "core.login.signIn"));
  });

  test("templates containing only punctuation and user data need no translation", () => {
    assert.deepEqual(auditSource('export function View() { return <span>{` — ${client.name}`}{`(${profile.protocol})`}</span>; }'), []);
    assert.ok(auditSource('export function View() { return <span>{`${count} jours`}</span>; }').some(item => item.text.includes("jours")));
    assert.ok(auditSource('export function View() { return <span>{`${active ? "Actif" : "Inactif"}`}</span>; }').some(item => item.text === "Actif"));
    assert.ok(auditSource('export function View() { return <span>{`(${"Supprimer"})`}</span>; }').some(item => item.text === "Supprimer"));
  });

  test("AST audit catches browser-default and fixed locales but accepts selected locales", () => {
    const source = `
      date.toLocaleDateString("fr-FR");
      number.toLocaleString();
      date.toLocaleString("default");
      new Intl.NumberFormat("en-US");
      date.toLocaleString(locale);
      new Intl.DateTimeFormat(locale);
    `;
    assert.equal(auditSource(source).filter(item => item.sink === "fixed-locale").length, 4);
  });

  test("every dashboard source file is audited, including all business and configuration views", () => {
    assert.ok(files.some(file => path.basename(file) === "VpnProfilesView.tsx"));
    assert.ok(files.some(file => path.basename(file) === "SubscriptionsView.tsx"));
    assert.ok(files.some(file => path.basename(file) === "App.tsx"));
    assert.ok(files.some(file => path.basename(file) === "Pagination.tsx"));
    const findings = audit();
    assert.equal(findings.length, 0,
      `${findings.length} hardcoded UI/locale findings. No legacy screens are excluded.\n` +
      findings.slice(0, 100).map(item => `${item.file}:${item.line} [${item.sink}] ${item.text}`).join("\n") +
      "\nFull inventory: node scripts/tests/dashboard-i18n-coverage.test.mjs --report");
  });

  test("literal translation keys and supplied interpolation parameters resolve in both languages", () => {
    const failures = [];
    for (const fullPath of files) {
      const file = path.relative(sourceRoot, fullPath);
      const source = ts.createSourceFile(file, readFileSync(fullPath, "utf8"), ts.ScriptTarget.Latest, true);
      // The API validation formatter has a local t wrapper with an explicit
      // prefix. It is not the React hook's root-namespace translator.
      const localPrefix = file === path.join("lib", "errors.ts") ? "errors.validationIssue." : "";
      const visit = node => {
        if (ts.isCallExpression(node) && ["t", "message"].includes(calleeName(node.expression)) && node.arguments[0] && isString(node.arguments[0])) {
          const key = (calleeName(node.expression) === "t" ? localPrefix : "") + node.arguments[0].text;
          const fr = resolve("fr", key);
          const en = resolve("en", key);
          if (!fr || !en) failures.push(`${file}: unknown key ${key}`);
          if (fr && en) {
            const required = [...fr.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]);
            const params = node.arguments[1];
            if (required.length && (!params || ts.isObjectLiteralExpression(params) && !params.properties.some(ts.isSpreadAssignment))) {
              const supplied = params ? params.properties.map(property => propertyName(property.name)) : [];
              for (const name of required) if (!supplied.includes(name)) failures.push(`${file}: ${key} missing {{${name}}}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    assert.deepEqual(failures, []);
  });
}
