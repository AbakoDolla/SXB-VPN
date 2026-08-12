import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prisma, logDbActivity } from '../database';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';

const router = Router();
const SETTINGS_KEY = 'sxb.announcements.v1';
const PUBLISHER_ROLES = new Set(['OWNER', 'SUPER_ADMIN', 'ADMIN', 'SUPPORT']);

export type Announcement = {
  id: string;
  title: string;
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
  active: boolean;
  startsAt: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const announcementSchema = z.object({
  title: z.string().trim().min(3).max(140),
  message: z.string().trim().min(3).max(2000),
  level: z.enum(['info', 'success', 'warning', 'error']).default('info'),
  active: z.boolean().default(true),
  startsAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

const isPublisher = (req: AuthenticatedRequest) => PUBLISHER_ROLES.has(req.user?.role || '');

function normalize(raw: unknown): Announcement[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is Announcement => !!value && typeof value === 'object' &&
    typeof (value as any).id === 'string' && typeof (value as any).title === 'string' &&
    typeof (value as any).message === 'string').map((value: any) => ({
      id: value.id,
      title: value.title,
      message: value.message,
      level: ['info', 'success', 'warning', 'error'].includes(value.level) ? value.level : 'info',
      active: value.active !== false,
      startsAt: value.startsAt || value.createdAt || new Date().toISOString(),
      expiresAt: value.expiresAt || null,
      createdAt: value.createdAt || new Date().toISOString(),
      updatedAt: value.updatedAt || value.createdAt || new Date().toISOString(),
    }));
}

async function readAll(): Promise<Announcement[]> {
  if (!prisma) throw new Error('DB_UNAVAILABLE');
  const row = await (prisma as any).setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row?.value) return [];
  try { return normalize(JSON.parse(row.value)); } catch { return []; }
}

async function writeAll(announcements: Announcement[]): Promise<void> {
  if (!prisma) throw new Error('DB_UNAVAILABLE');
  await (prisma as any).setting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: JSON.stringify(announcements) },
    update: { value: JSON.stringify(announcements) },
  });
}

export async function getActiveAnnouncements(): Promise<Announcement[]> {
  const now = Date.now();
  return (await readAll()).filter(item => item.active && new Date(item.startsAt).getTime() <= now &&
    (!item.expiresAt || new Date(item.expiresAt).getTime() > now))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

router.get('/', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const announcements = await readAll();
    return res.json({ announcements: announcements.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) });
  } catch (err: any) {
    return res.status(503).json({ error: 'DB_UNAVAILABLE', message: err.message || 'Annonces indisponibles' });
  }
});

router.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  if (!isPublisher(req)) return res.status(403).json({ error: 'FORBIDDEN', message: 'Publication réservée aux administrateurs et au support' });
  try {
    const input = announcementSchema.parse(req.body);
    if (input.expiresAt && new Date(input.expiresAt) <= new Date(input.startsAt || Date.now())) {
      return res.status(422).json({ error: 'INVALID_DATES', message: 'La date de fin doit être postérieure au début' });
    }
    const now = new Date().toISOString();
    const announcement: Announcement = {
      id: randomUUID(), title: input.title, message: input.message, level: input.level, active: input.active,
      startsAt: input.startsAt || now, expiresAt: input.expiresAt || null, createdAt: now, updatedAt: now,
    };
    const all = await readAll();
    all.push(announcement);
    await writeAll(all);
    await logDbActivity(req.user?.userId || null, `Annonce publiée: "${announcement.title}"`, 'success', req.ip || '');
    return res.status(201).json({ announcement });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(422).json({ error: 'VALIDATION', message: err.issues[0]?.message || 'Annonce invalide' });
    return res.status(503).json({ error: 'DB_UNAVAILABLE', message: err.message || 'Publication impossible' });
  }
});

router.patch('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  if (!isPublisher(req)) return res.status(403).json({ error: 'FORBIDDEN', message: 'Modification réservée aux administrateurs et au support' });
  try {
    const input = announcementSchema.partial().parse(req.body);
    const all = await readAll();
    const index = all.findIndex(item => item.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'NOT_FOUND', message: 'Annonce introuvable' });
    const current = all[index];
    const next: Announcement = { ...current, ...input, startsAt: input.startsAt || current.startsAt, expiresAt: input.expiresAt === undefined ? current.expiresAt : input.expiresAt, updatedAt: new Date().toISOString() };
    if (next.expiresAt && new Date(next.expiresAt) <= new Date(next.startsAt)) {
      return res.status(422).json({ error: 'INVALID_DATES', message: 'La date de fin doit être postérieure au début' });
    }
    all[index] = next;
    await writeAll(all);
    await logDbActivity(req.user?.userId || null, `Annonce modifiée: "${next.title}"`, 'info', req.ip || '');
    return res.json({ announcement: next });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(422).json({ error: 'VALIDATION', message: err.issues[0]?.message || 'Annonce invalide' });
    return res.status(503).json({ error: 'DB_UNAVAILABLE', message: err.message || 'Modification impossible' });
  }
});

router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  if (!isPublisher(req)) return res.status(403).json({ error: 'FORBIDDEN', message: 'Suppression réservée aux administrateurs et au support' });
  try {
    const all = await readAll();
    const current = all.find(item => item.id === req.params.id);
    if (!current) return res.status(404).json({ error: 'NOT_FOUND', message: 'Annonce introuvable' });
    await writeAll(all.filter(item => item.id !== req.params.id));
    await logDbActivity(req.user?.userId || null, `Annonce supprimée: "${current.title}"`, 'warning', req.ip || '');
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(503).json({ error: 'DB_UNAVAILABLE', message: err.message || 'Suppression impossible' });
  }
});

export default router;
