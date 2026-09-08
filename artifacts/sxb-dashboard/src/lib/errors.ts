import { formatNumber, getLanguage, resolveTranslation, translate, type Language } from "./i18n";

const CODE_KEYS: Record<string, string> = {
  RESELLER_ACCOUNT_REQUIRED: "errors.resellers.not_found",
  RESELLER_EXPIRED: "errors.resellers.access_expired",
  RESELLER_SUSPENDED: "errors.resellers.suspended",
  RESELLER_QUOTA_REACHED: "errors.resellers.quota_reached",
  OWNERSHIP_FORBIDDEN: "errors.resellers.ownership_forbidden",
  SUPPORT_READ_ONLY: "errors.resellers.support_read_only",
  RESELLER_ACCESS_REQUIRED: "errors.resellers.access_required",
  RATE_LIMITED: "errors.rate_limit",
  SERVER_ERROR: "errors.server",
  DB_UNAVAILABLE: "errors.db.unavailable",
  VALIDATION_ERROR: "errors.validation",
  INVALID_BODY: "errors.badRequest",
  session_expired: "errors.sessionExpired",
  SESSION_REFRESH_UNAVAILABLE: "errors.refreshUnavailable",
  maintenance: "errors.maintenance",
  PROFILE_LOCKED: "configurations.lock.errors.PROFILE_LOCKED",
  PROFILE_UNLOCK_FAILED: "configurations.lock.errors.PROFILE_UNLOCK_FAILED",
  PROFILE_LOCK_PASSWORD_INVALID: "configurations.lock.errors.PROFILE_LOCK_PASSWORD_INVALID",
  PROFILE_UNLOCK_RATE_LIMITED: "configurations.lock.errors.PROFILE_UNLOCK_RATE_LIMITED",
  PROFILE_ENGINE_LINK_AMBIGUOUS: "configurations.lock.errors.PROFILE_ENGINE_LINK_AMBIGUOUS",
  PROFILE_ENGINE_LINKED: "configurations.lock.errors.PROFILE_ENGINE_LINKED",
  PROFILE_NOT_LOCKED: "configurations.lock.errors.PROFILE_NOT_LOCKED",
  PROFILE_LOCK_FIELDS_FORBIDDEN: "configurations.lock.errors.PROFILE_LOCK_FIELDS_FORBIDDEN",
  PROFILE_UNLOCK_UNAVAILABLE: "configurations.lock.errors.PROFILE_UNLOCK_UNAVAILABLE",
  PROFILE_LOCK_UNAVAILABLE: "configurations.lock.errors.PROFILE_LOCK_UNAVAILABLE",
  PROFILE_ENGINE_NOT_FOUND: "configurations.lock.errors.PROFILE_ENGINE_NOT_FOUND",
  PROFILE_ENGINE_LINK_INVALID: "configurations.lock.errors.PROFILE_ENGINE_LINK_INVALID",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function knownMessage(code: unknown, language: Language): string | undefined {
  if (typeof code !== "string") return undefined;
  return resolveTranslation(language, CODE_KEYS[code] ?? code);
}

function diagnostic(message: string, language: Language): string {
  return translate(language, "errors.diagnostic", { message });
}

function issueMessage(issue: Record<string, unknown>, language: Language): string {
  const t = (key: string, params?: Record<string, string | number>) => translate(language, `errors.validationIssue.${key}`, params);
  const limit = (value: unknown) => typeof value === "number" || typeof value === "bigint" ? formatNumber(value, language) : String(value);
  const type = issue.type ?? issue.origin;
  switch (issue.code) {
    case "invalid_type":
      if (issue.received === "undefined") return t("required");
      if (issue.expected === "integer") return t("integer");
      if (typeof issue.expected !== "string") break;
      return t("type", { type: resolveTranslation(language, `errors.types.${issue.expected}`) ?? issue.expected });
    case "too_small":
      if (typeof issue.minimum !== "number" && typeof issue.minimum !== "bigint") break;
      return t(type === "string" ? "minLength" : type === "array" ? "minItems" : issue.inclusive === false ? "greater" : "minimum", { minimum: limit(issue.minimum) });
    case "too_big":
      if (typeof issue.maximum !== "number" && typeof issue.maximum !== "bigint") break;
      return t(type === "string" ? "maxLength" : type === "array" ? "maxItems" : issue.inclusive === false ? "less" : "maximum", { maximum: limit(issue.maximum) });
    case "invalid_string":
    case "invalid_format": {
      const format = issue.validation ?? issue.format;
      if (typeof format === "string" && ["email", "url", "uuid", "datetime"].includes(format)) return t(format);
      break;
    }
    case "invalid_enum_value":
    case "invalid_value": {
      const options = issue.options ?? issue.values;
      if (Array.isArray(options)) return t("enum", { options: options.map(String).join(", ") });
      break;
    }
    case "not_multiple_of":
      if (typeof issue.multipleOf === "number") return t("multiple", { multiple: limit(issue.multipleOf) });
      break;
    case "unrecognized_keys":
      if (Array.isArray(issue.keys)) return t("unrecognized", { keys: issue.keys.map(String).join(", ") });
      break;
  }
  const message = text(issue.message);
  return message ? `${t("invalid")} ${diagnostic(message, language)}` : t("invalid");
}

export function validationMessages(issues: unknown, language: Language = getLanguage()): string[] {
  if (!Array.isArray(issues)) return [];
  return issues.flatMap(value => {
    const issue = record(value);
    if (!issue || (!text(issue.message) && !text(issue.code))) return [];
    const path = Array.isArray(issue.path) ? issue.path.filter(part => typeof part === "string" || typeof part === "number") : [];
    const rawPath = path.join(".");
    const label = path.map(part => typeof part === "string" ? resolveTranslation(language, `errors.fields.${part}`) ?? part : String(part)).join(".");
    const field = label === rawPath ? rawPath : `${label} (${rawPath})`;
    const message = issueMessage(issue, language);
    return [field ? `${field}: ${message}` : message];
  });
}

export function apiErrorMessage(
  data: unknown,
  status: number,
  language: Language = getLanguage(),
  code?: string,
  retryAfterSeconds?: number,
): string {
  const body = record(data);
  if (status === 429) {
    return retryAfterSeconds === undefined
      ? translate(language, "errors.rate_limit")
      : translate(language, "errors.rateLimitDelay", { seconds: formatNumber(retryAfterSeconds, language) });
  }
  const issues = status < 500 ? [
    ...validationMessages(body?.details, language),
    ...validationMessages(body?.message, language),
    ...validationMessages(body?.issues, language),
  ] : [];
  if (issues.length) return `${translate(language, "errors.validation")} ${issues.join("; ")}`;
  const known = knownMessage(body?.error, language) ?? knownMessage(code ?? body?.code, language);
  if (known) {
    const detail = text(body?.message);
    return body?.error === "errors.validation" && detail ? `${known} ${diagnostic(detail, language)}` : known;
  }
  const fallback = status === 400 || status === 422 ? "errors.badRequest"
    : status === 401 ? "errors.auth.unauthorized"
    : status === 403 ? "errors.auth.forbidden"
    : status === 404 ? "errors.notFound"
    : status === 409 ? "errors.conflict"
    : status === 503 ? "errors.unavailable"
    : status >= 500 ? "errors.server" : "errors.requestFailed";
  const explanation = `${translate(language, fallback)} ${translate(language, "errors.http", { status })}`;
  // Unrecognized machine codes and explicit diagnostics stay available, but
  // never replace the localized explanation or expose a raw 5xx error trace.
  const raw = status < 500
    ? text(body?.message) ?? text(body?.error) ?? text(code)
    : undefined;
  return raw ? `${explanation} ${diagnostic(raw, language)}` : explanation;
}

export function errorMessage(error: unknown, language: Language = getLanguage(), fallbackKey = "errors.requestFailed"): string {
  const value = record(error);
  if (typeof value?.status === "number") {
    return apiErrorMessage(value.responseData, value.status, language, text(value.code) ?? text(value.errorKey), typeof value.retryAfterSeconds === "number" ? value.retryAfterSeconds : undefined);
  }
  const message = text(error) ?? text(value?.message);
  if (message) {
    const known = knownMessage(message, language);
    if (known) return known;
  }
  const explanation = translate(language, value?.name === "TypeError" ? "errors.network" : fallbackKey);
  return message ? `${explanation} ${diagnostic(message, language)}` : explanation;
}
