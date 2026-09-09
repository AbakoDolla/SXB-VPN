import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, urlencoded, type ErrorRequestHandler, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { config } from "../config";
import { prisma } from "../database";
import copy from "../resources/privacy-content.json";
import {
  escapeHtml, PRIVACY_CONTENT_VERSION, PUBLIC_PRIVACY_ORIGIN, publicRequestSchema,
  readPrivacySettings, type PrivacyLanguage, type PrivacySettings,
} from "../services/public-privacy";

export const PUBLIC_REQUEST_LIMIT = 5;
export const PUBLIC_REQUEST_WINDOW_MS = 60 * 60 * 1000;
export const PUBLIC_FORM_LIFETIME_MS = 20 * 60 * 1000;

function language(req: Request): PrivacyLanguage {
  if (req.query.lang === "en" || req.query.lang === "fr") return req.query.lang;
  return req.acceptsLanguages("fr", "en") === "en" ? "en" : "fr";
}

function section(title: string, text: string): string {
  return `<section><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></section>`;
}

function page(lang: PrivacyLanguage, title: string, body: string, settings: PrivacySettings): string {
  const text = copy[lang];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#17233b;background:#f5f7fb}a{color:#1647a1}section,form,aside{background:#fff;border:1px solid #bbc7dc;border-radius:.5rem;padding:1rem;margin:1rem 0}aside{border:2px solid #936300}label{display:block;margin-top:1rem}input:not([type=checkbox]),select,textarea{display:block;box-sizing:border-box;width:100%;padding:.7rem;font:inherit}textarea{min-height:9rem}button{margin-top:1rem;background:#1647a1;color:white;border:0;border-radius:.3rem;padding:.8rem;font:inherit}h1{line-height:1.2}p{white-space:pre-line}.trap{display:none}</style></head>
<body><nav aria-label="Language"><a href="?lang=fr" lang="fr">Français</a> | <a href="?lang=en" lang="en">English</a></nav>
<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text.version)}: ${PRIVACY_CONTENT_VERSION}</p>
${settings.SXB_PRIVACY_REVIEWED !== "true" ? `<aside role="note">${escapeHtml(text.draft)}</aside>` : ""}
${section(text.operator, settings.SXB_PRIVACY_OPERATOR_NAME || text.operatorUnknown)}
${section(text.contact, settings.SXB_PRIVACY_CONTACT_EMAIL || text.contactUnknown)}
${body}</main></body></html>`;
}

function sendPage(res: Response, status: number, lang: PrivacyLanguage, title: string, body: string, settings: PrivacySettings) {
  return res.status(status).type("html").send(page(lang, title, body, settings));
}

function secureHeaders(res: Response) {
  res.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex",
  });
}

export function createPublicPrivacyRouter(options: { now?: () => number; settings?: PrivacySettings } = {}) {
  const router = Router();
  const now = options.now || Date.now;
  const settings = options.settings || readPrivacySettings();
  const production = config.NODE_ENV === "production";
  const cookieName = production ? "__Host-sxb-privacy-csrf" : "sxb-privacy-csrf";
  const sign = (value: string) => createHmac("sha256", config.JWT_SECRET)
    .update(`sxb-public-privacy-v1\0${value}`).digest("hex");
  const formToken = () => {
    const value = `${now()}.${randomBytes(24).toString("hex")}`;
    return `${value}.${sign(value)}`;
  };
  const same = (left: string, right: string) => {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const validCsrf = (req: Request, token: string) => {
    const cookies = (req.headers.cookie || "").split(";").map(item => item.trim())
      .filter(item => item.startsWith(`${cookieName}=`));
    if (cookies.length !== 1 || !same(cookies[0].slice(cookieName.length + 1), token)) return false;
    const match = /^(\d{13})\.([a-f0-9]{48})\.([a-f0-9]{64})$/.exec(token);
    if (!match || !same(sign(`${match[1]}.${match[2]}`), match[3])) return false;
    const age = now() - Number(match[1]);
    return age >= 2000 && age <= PUBLIC_FORM_LIFETIME_MS;
  };
  const failure = (req: Request, res: Response, status: number, key: "invalid" | "csrfError" | "rateError" | "unavailable") => {
    const lang = language(req);
    return sendPage(res, status, lang, copy[lang].deletionTitle,
      `<p role="alert">${escapeHtml(copy[lang][key])}</p><a href="/data-deletion?lang=${lang}">${escapeHtml(copy[lang].back)}</a>`, settings);
  };

  router.use(["/privacy", "/data-deletion"], (_req, res, next) => {
    secureHeaders(res);
    next();
  });

  router.get("/privacy", (req, res) => {
    const lang = language(req);
    const text = copy[lang];
    const retention = lang === "fr" ? settings.SXB_PRIVACY_RETENTION_NOTE_FR : settings.SXB_PRIVACY_RETENTION_NOTE_EN;
    const processors = lang === "fr" ? settings.SXB_PRIVACY_PROCESSORS_NOTE_FR : settings.SXB_PRIVACY_PROCESSORS_NOTE_EN;
    return sendPage(res, 200, lang, text.privacyTitle,
      text.sections.map(item => section(item.title, item.text)).join("") +
      (retention ? section(text.retentionNote, retention) : "") +
      (processors ? section(text.processorsNote, processors) : "") +
      `<a href="/data-deletion?lang=${lang}">${escapeHtml(text.contactForm)}</a>`, settings);
  });

  router.get("/data-deletion", (req, res) => {
    const lang = language(req);
    const text = copy[lang];
    const csrf = formToken();
    res.cookie(cookieName, csrf, {
      httpOnly: true, sameSite: "strict", secure: production, path: "/", maxAge: PUBLIC_FORM_LIFETIME_MS,
    });
    return sendPage(res, 200, lang, text.deletionTitle, `
<p>${escapeHtml(text.deletionIntro)}</p><p>${escapeHtml(text.deletionScope)}</p><p>${escapeHtml(text.manual)}</p>
<form method="post" action="/data-deletion?lang=${lang}" accept-charset="utf-8">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="lang" value="${lang}">
<div class="trap" aria-hidden="true"><label>Website<input name="website" value="" tabindex="-1" autocomplete="off"></label></div>
<label for="kind">${escapeHtml(text.kind)}</label><select id="kind" name="kind"><option value="deletion">${escapeHtml(text.deleteOption)}</option><option value="privacy">${escapeHtml(text.privacyOption)}</option></select>
<label for="email">${escapeHtml(text.email)}</label><input id="email" type="email" name="email" maxlength="254" autocomplete="email" required>
<label for="deviceId">${escapeHtml(text.device)}</label><input id="deviceId" name="deviceId" maxlength="83" pattern="SXB[A-Z0-9]{6,80}" autocomplete="off">
<label for="message">${escapeHtml(text.message)}</label><textarea id="message" name="message" minlength="10" maxlength="2000" required></textarea>
<label><input type="checkbox" name="acknowledge" value="yes" required> ${escapeHtml(text.acknowledge)}</label>
<button type="submit">${escapeHtml(text.submit)}</button></form>
<a href="/privacy?lang=${lang}">${escapeHtml(text.privacyLink)}</a>`, settings);
  });

  const limiter = rateLimit({
    windowMs: PUBLIC_REQUEST_WINDOW_MS, limit: PUBLIC_REQUEST_LIMIT,
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => { failure(req, res, 429, "rateError"); },
  });
  router.post("/data-deletion", limiter, (req, res, next) => {
    // Fixed canonical origin: never trust Host/X-Forwarded-Host supplied by a caller.
    if (req.headers.origin !== PUBLIC_PRIVACY_ORIGIN ||
      (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
      failure(req, res, 403, "csrfError");
      return;
    }
    if (!req.is("application/x-www-form-urlencoded")) {
      failure(req, res, 415, "invalid");
      return;
    }
    next();
  }, urlencoded({ extended: false, limit: "16kb", parameterLimit: 10, inflate: false }), async (req, res) => {
    const parsed = publicRequestSchema.safeParse(req.body);
    if (!parsed.success) return failure(req, res, 400, "invalid");
    if (!validCsrf(req, parsed.data.csrf)) return failure(req, res, 403, "csrfError");
    if (!prisma) return failure(req, res, 503, "unavailable");
    const input = parsed.data;
    try {
      // Never look up accounts from public input, and never associate this ticket
      // with a claimed userId. Null ownership keeps it in the staff-only queue.
      await prisma.supportTicket.create({
        data: {
          userId: null, status: "open", priority: "medium",
          title: input.kind === "deletion" ? "[PRIVACY] Deletion request" : "[PRIVACY] Data request",
          clientName: "Public privacy request",
          description: JSON.stringify({
            source: "public-privacy", version: PRIVACY_CONTENT_VERSION,
            language: input.lang, kind: input.kind, replyEmail: input.email,
            deviceId: input.deviceId || null, message: input.message,
            acknowledgement: true, identityVerified: false,
          }),
        },
        select: { id: true },
      });
    } catch {
      // Database exceptions may contain the submitted email/message. Log only
      // the failure category, never the request or Prisma exception.
      console.error("[public-privacy] support ticket persistence failed");
      return failure(req, res, 503, "unavailable");
    }
    res.clearCookie(cookieName, { httpOnly: true, sameSite: "strict", secure: production, path: "/" });
    return sendPage(res, 202, input.lang, copy[input.lang].deletionTitle,
      `<p role="status">${escapeHtml(copy[input.lang].sent)}</p>
<a href="/privacy?lang=${input.lang}">${escapeHtml(copy[input.lang].privacyLink)}</a>`, settings);
  });

  const bodyErrorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
    const type = typeof error === "object" && error !== null && "type" in error ? error.type : null;
    if (req.path.toLowerCase().replace(/\/+$/, "") === "/data-deletion" &&
      typeof type === "string" && ["entity.too.large", "parameters.too.many", "encoding.unsupported", "charset.unsupported", "entity.parse.failed"].includes(type)) {
      failure(req, res, type === "entity.too.large" || type === "parameters.too.many" ? 413 : 400, "invalid");
      return;
    }
    next(error);
  };
  router.use(bodyErrorHandler);
  return router;
}

export default createPublicPrivacyRouter();
