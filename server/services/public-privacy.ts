import { z } from "zod";

export const PUBLIC_PRIVACY_ORIGIN = "https://vpnsxb.afrihall.com";
export const PRIVACY_CONTENT_VERSION = "2026-09-09";
export type PrivacyLanguage = "fr" | "en";

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();
const settingsSchema = z.object({
  SXB_PRIVACY_OPERATOR_NAME: optionalText(200),
  SXB_PRIVACY_CONTACT_EMAIL: z.string().trim().email().max(254).optional(),
  SXB_PRIVACY_RETENTION_NOTE_FR: optionalText(4000),
  SXB_PRIVACY_RETENTION_NOTE_EN: optionalText(4000),
  SXB_PRIVACY_PROCESSORS_NOTE_FR: optionalText(4000),
  SXB_PRIVACY_PROCESSORS_NOTE_EN: optionalText(4000),
  SXB_PRIVACY_REVIEWED: z.enum(["true", "false"]).default("false"),
}).superRefine((value, ctx) => {
  if (value.SXB_PRIVACY_REVIEWED !== "true") return;
  for (const field of [
    "SXB_PRIVACY_OPERATOR_NAME", "SXB_PRIVACY_CONTACT_EMAIL",
    "SXB_PRIVACY_RETENTION_NOTE_FR", "SXB_PRIVACY_RETENTION_NOTE_EN",
    "SXB_PRIVACY_PROCESSORS_NOTE_FR", "SXB_PRIVACY_PROCESSORS_NOTE_EN",
  ] as const) {
    if (!value[field]) ctx.addIssue({ code: "custom", path: [field], message: "Required before privacy publication approval" });
  }
});

export type PrivacySettings = z.infer<typeof settingsSchema>;

export function readPrivacySettings(env: NodeJS.ProcessEnv = process.env): PrivacySettings {
  return settingsSchema.parse(Object.fromEntries(
    Object.entries(env).filter(([key, value]) => key.startsWith("SXB_PRIVACY_") && value?.trim()),
  ));
}

export function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, character => entities[character]);
}

export const publicRequestSchema = z.object({
  lang: z.enum(["fr", "en"]),
  csrf: z.string().max(160),
  kind: z.enum(["deletion", "privacy"]),
  email: z.string().trim().email().max(254),
  deviceId: z.string().trim().max(83).regex(/^(?:SXB[A-Z0-9]{6,80})?$/).default(""),
  message: z.string().trim().min(10).max(2000)
    .refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), "Control characters are not allowed")
    .refine(value => !/SXB-(?:USER|DATA|ADMIN)-|-----BEGIN |(?:vless|vmess|trojan|ss|ssh):\/\/|Bearer\s+\S+/i.test(value),
      "Do not send access codes, credentials or VPN configurations"),
  website: z.literal(""),
  acknowledge: z.literal("yes"),
}).strict();
