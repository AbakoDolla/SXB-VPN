/**
 * VPN Management Routes
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../../database';
import { requireAuth } from '../../middleware/auth';

const router = Router();

router.get('/stats', requireAuth, async (req: Request, res: Response) => {
  try {
    const stats = {
      server: { uptime: Math.floor(process.uptime()) },
      database: {
        users: prisma ? await prisma.user.count() : 0,
        clients: prisma ? await prisma.vpnClient.count() : 0,
        activeClients: prisma ? await prisma.vpnClient.count({ where: { status: 'active' } }) : 0,
      },
      tokens: {
        total: prisma ? await prisma.tokenSXB.count() : 0,
        active: prisma ? await prisma.tokenSXB.count({ where: { status: 'active' } }) : 0,
      },
    };
    res.json({ success: true, stats });
  } catch (error) {
    console.error('VPN stats error:', error);
    res.status(500).json({ error: 'Failed to fetch VPN stats' });
  }
});

router.get('/clients', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!prisma) return res.status(500).json({ error: 'Database not connected' });
    const clients = await prisma.vpnClient.findMany({
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, clients });
  } catch (error) {
    console.error('Get clients error:', error);
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

router.post('/clients', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!prisma) return res.status(500).json({ error: 'Database not connected' });
    const { userId, quotaGB, durationDays } = req.body;
    const quotaBytes = BigInt(Math.floor(quotaGB * 1024 * 1024 * 1024));
    const expireAt = new Date();
    expireAt.setDate(expireAt.getDate() + durationDays);
    const token = 'SXB-' + Math.random().toString(36).substring(2, 6).toUpperCase() + '-' + 
                  Math.random().toString(36).substring(2, 6).toUpperCase() + '-' +
                  Math.random().toString(36).substring(2, 6).toUpperCase();
    const client = await prisma.vpnClient.create({
      data: { userId, token, quotaTotal: quotaBytes, expireAt, status: 'active' },
      include: { user: { select: { name: true, email: true } } }
    });
    // Convertir BigInt en Number pour JSON
    const response = {
      id: client.id,
      userId: client.userId,
      token: client.token,
      quotaTotal: Number(client.quotaTotal),
      quotaUsed: Number(client.quotaUsed),
      expireAt: client.expireAt,
      status: client.status,
      user: client.user,
      createdAt: client.createdAt,
    };
    res.json({ success: true, client: response });
  } catch (error) {
    console.error('Create client error:', error);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

router.delete('/clients/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!prisma) return res.status(500).json({ error: 'Database not connected' });
    await prisma.vpnClient.update({
      where: { id: req.params.id },
      data: { status: 'suspended' }
    });
    res.json({ success: true, message: 'Client revoked successfully' });
  } catch (error) {
    console.error('Revoke client error:', error);
    res.status(500).json({ error: 'Failed to revoke client' });
  }
});

router.get('/config/:token', async (req: Request, res: Response) => {
  try {
    if (!prisma) return res.status(500).json({ error: 'Database not connected' });
    const client = await prisma.vpnClient.findUnique({
      where: { token: req.params.token },
      include: { user: { select: { name: true } } }
    });
    if (!client || client.status !== 'active') {
      return res.status(404).json({ error: 'Client not found or inactive' });
    }
    if (new Date() > client.expireAt) {
      await prisma.vpnClient.update({
        where: { id: client.id },
        data: { status: 'expired' }
      });
      return res.status(403).json({ error: 'Account expired' });
    }
    const config = {
      protocol: 'vmess',
      server: 'vpnsxb.afrihall.com',
      server_port: 443,
      uuid: client.id.replace(/-/g, ''),
      alterId: 0,
      security: 'auto',
      network: 'tcp',
      remark: client.user?.name || 'SXB VPN Client',
      quota_used: Number(client.quotaUsed),
      quota_total: Number(client.quotaTotal),
      expire_at: client.expireAt.toISOString(),
    };
    res.json({ success: true, config });
  } catch (error) {
    console.error('Get config error:', error);
    res.status(500).json({ error: 'Failed to get configuration' });
  }
});

export default router;
