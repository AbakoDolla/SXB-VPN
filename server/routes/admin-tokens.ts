/**
 * Admin Token Routes — SXB-ADMIN-XXXX-XXXX
 * Système de tokens pour la première connexion des comptes dashboard.
 * Flow: Admin crée compte → génère token → utilisateur utilise token → JWT session
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma, logDbActivity } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';
import { config } from '../config';
import { generateTokens } from '../middleware/auth';

const router = Router();

// Génère un token SXB-ADMIN-XXXX-XXXX
function makeAdminToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const part = () =>
    Array.from(crypto.randomBytes(4))
      .map((b) => chars[b % chars.length])
      .join('');
  return `SXB-ADMIN-${part()}-${part()}`;
}

// POST /api/admin-tokens/generate
// Génère un token d'accès pour un compte dashboard (première connexion)
const generateSchema = z.object({
  userId: z.string().uuid('ID utilisateur invalide'),
  expiresInHours: z.coerce.number().min(1).max(168).default(24), // 1h à 7j, défaut 24h
});

router.post(
  '/generate',
  requireAuth,
  requirePermission('users.create'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) {
        return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'Base de données indisponible' });
      }

      const body = generateSchema.parse(req.body);

      // Vérifier que l'utilisateur cible existe
      const targetUser = await prisma.user.findUnique({
        where: { id: body.userId },
        include: { role: true },
      });

      if (!targetUser) {
        return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Utilisateur non trouvé' });
      }

      // Un ADMIN ne peut pas générer de token pour un SUPER_ADMIN
      if (
        req.user?.role !== 'SUPER_ADMIN' &&
        targetUser.role.name === 'SUPER_ADMIN'
      ) {
        return res.status(403).json({
          error: 'FORBIDDEN',
          message: 'Vous ne pouvez pas générer un token pour un SUPER_ADMIN',
        });
      }

      // Révoquer les tokens actifs existants pour cet utilisateur
      await prisma.adminToken.updateMany({
        where: { userId: body.userId, status: 'active' },
        data: { status: 'revoked' },
      });

      // Créer le nouveau token
      const tokenStr = makeAdminToken();
      const expiresAt = new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000);

      const adminToken = await prisma.adminToken.create({
        data: {
          token: tokenStr,
          userId: body.userId,
          expiresAt,
          status: 'active',
        },
      });

      await logDbActivity(
        req.user?.userId || null,
        `Generated admin token for user: ${targetUser.email}`,
        'success',
        req.ip
      );

      return res.status(201).json({
        success: true,
        token: tokenStr,
        expiresAt: expiresAt.toISOString(),
        expiresInHours: body.expiresInHours,
        user: {
          id: targetUser.id,
          name: targetUser.name,
          email: targetUser.email,
          role: targetUser.role.name,
        },
        message: `Token créé. Valide ${body.expiresInHours}h. Partagez-le de façon sécurisée.`,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: err.issues });
      }
      console.error('Admin token generation error:', err);
      return res.status(500).json({ error: 'SERVER_ERROR', message: 'Erreur lors de la génération du token' });
    }
  }
);

// POST /api/admin-tokens/activate
// Première connexion via token admin — retourne un JWT session
const activateSchema = z.object({
  token: z.string().regex(/^SXB-ADMIN-[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'Format de token invalide'),
  newPassword: z.string().min(8, 'Mot de passe minimum 8 caractères').optional(),
});

router.post('/activate', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!prisma) {
      return res.status(503).json({ error: 'DB_UNAVAILABLE', message: 'Base de données indisponible' });
    }

    const { token, newPassword } = activateSchema.parse(req.body);

    // Trouver le token
    const adminToken = await prisma.adminToken.findUnique({
      where: { token },
      include: {
        user: {
          include: {
            role: {
              include: { permissions: { include: { permission: true } } },
            },
          },
        },
      },
    });

    if (!adminToken) {
      return res.status(404).json({ error: 'INVALID_TOKEN', message: 'Token invalide ou inexistant' });
    }

    if (adminToken.status === 'used') {
      return res.status(400).json({ error: 'TOKEN_USED', message: 'Ce token a déjà été utilisé' });
    }

    if (adminToken.status === 'revoked') {
      return res.status(400).json({ error: 'TOKEN_REVOKED', message: 'Ce token a été révoqué' });
    }

    if (new Date(adminToken.expiresAt) < new Date()) {
      await prisma.adminToken.update({ where: { id: adminToken.id }, data: { status: 'revoked' } });
      return res.status(400).json({ error: 'TOKEN_EXPIRED', message: 'Ce token a expiré' });
    }

    if (adminToken.user.status !== 'active') {
      return res.status(403).json({ error: 'ACCOUNT_DISABLED', message: 'Ce compte est désactivé' });
    }

    // Marquer le token comme utilisé
    await prisma.adminToken.update({
      where: { id: adminToken.id },
      data: { status: 'used', usedAt: new Date() },
    });

    // Optionnellement changer le mot de passe
    if (newPassword) {
      const bcrypt = await import('bcryptjs');
      const passwordHash = await bcrypt.hash(newPassword, 12);
      await prisma.user.update({ where: { id: adminToken.userId }, data: { passwordHash } });
    }

    const permissions = adminToken.user.role.permissions.map(
      (rp: any) => rp.permission.name
    );

    const tokens = generateTokens({
      userId: adminToken.user.id,
      email: adminToken.user.email,
      role: adminToken.user.role.name,
      permissions,
    });

    await logDbActivity(
      adminToken.userId,
      `First login via admin token: ${adminToken.user.email}`,
      'success',
      req.ip
    );

    return res.json({
      success: true,
      message: 'Connexion réussie via token admin',
      user: {
        id: adminToken.user.id,
        name: adminToken.user.name,
        email: adminToken.user.email,
        role: adminToken.user.role.name,
        permissions,
      },
      ...tokens,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: err.issues });
    }
    console.error('Admin token activation error:', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Erreur lors de l\'activation' });
  }
});

// GET /api/admin-tokens — liste les tokens (ADMIN+)
router.get(
  '/',
  requireAuth,
  requirePermission('users.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return res.json({ tokens: [] });

      const tokens = await prisma.adminToken.findMany({
        include: { user: { include: { role: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      return res.json({
        tokens: tokens.map((t) => ({
          id: t.id,
          token: t.token,
          status: t.status,
          expiresAt: t.expiresAt,
          usedAt: t.usedAt,
          createdAt: t.createdAt,
          user: {
            id: t.user.id,
            name: t.user.name,
            email: t.user.email,
            role: t.user.role.name,
          },
        })),
      });
    } catch (err) {
      console.error('List admin tokens error:', err);
      return res.status(500).json({ error: 'SERVER_ERROR', message: 'Erreur serveur' });
    }
  }
);

// POST /api/admin-tokens/:id/revoke — révoque un token
router.post(
  '/:id/revoke',
  requireAuth,
  requirePermission('users.create'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!prisma) return res.status(503).json({ error: 'DB_UNAVAILABLE' });

      const token = await prisma.adminToken.findUnique({ where: { id: req.params.id } });
      if (!token) return res.status(404).json({ error: 'NOT_FOUND' });

      await prisma.adminToken.update({
        where: { id: req.params.id },
        data: { status: 'revoked' },
      });

      await logDbActivity(req.user?.userId || null, `Revoked admin token: ${token.token}`, 'danger', req.ip);
      return res.json({ success: true, message: 'Token révoqué' });
    } catch (err) {
      return res.status(500).json({ error: 'SERVER_ERROR' });
    }
  }
);

export default router;
