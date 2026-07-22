import { Router, Response } from 'express';
import { prisma } from '../database';
import { requireAuth, requirePermission, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Generate SXB Token: SXB-XXXX-XXXX-XXXX
function generateSXBToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segment = () => Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `SXB-${segment()}-${segment()}-${segment()}`;
}

// GET /api/vpn-manager/stats - Get real-time VPN statistics
router.get('/stats', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [
      totalClients,
      activeClients,
      totalTokens,
      activeTokens
    ] = await Promise.all([
      prisma.vpnClient.count(),
      prisma.vpnClient.count({ where: { status: 'active' } }),
      prisma.tokenSXB.count(),
      prisma.tokenSXB.count({ where: { status: 'active' } })
    ]);

    // Get traffic data
    const clients = await prisma.vpnClient.findMany({
      where: { status: 'active' },
      select: { quotaTotal: true, quotaUsed: true }
    });

    const totalTrafficUsed = clients.reduce((sum, c) => sum + c.quotaUsed, BigInt(0));
    const totalTrafficLimit = clients.reduce((sum, c) => sum + c.quotaTotal, BigInt(0));

    // Format for display
    const formatBytes = (bytes: bigint) => {
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      let val = Number(bytes);
      while (val >= 1024 && i < units.length - 1) { i++; val /= 1024; }
      return val.toFixed(2) + ' ' + units[i];
    };

    res.json({
      totalClients,
      activeClients,
      inactiveClients: totalClients - activeClients,
      totalTokens,
      activeTokens,
      totalTrafficUsed: formatBytes(totalTrafficUsed),
      totalTrafficUsedBytes: totalTrafficUsed.toString(),
      totalTrafficLimit: formatBytes(totalTrafficLimit),
      totalTrafficLimitBytes: totalTrafficLimit.toString()
    });
  } catch (err) {
    console.error('VPN stats error:', err);
    res.status(500).json({ error: 'Failed to get VPN stats' });
  }
});

// GET /api/vpn-manager/clients - Get all VPN clients
router.get('/clients', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const clients = await prisma.vpnClient.findMany({
      orderBy: { createdAt: 'desc' },
      include: { tokens: true }
    });
    res.json(clients);
  } catch (err) {
    console.error('Get clients error:', err);
    res.status(500).json({ error: 'Failed to get clients' });
  }
});

// POST /api/vpn-manager/clients - Create new VPN client with token
router.post('/clients', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { email, quotaGB, durationDays, plan } = req.body;
    
    // Generate unique token
    let token: string;
    let tokenExists = true;
    while (tokenExists) {
      token = generateSXBToken();
      const existing = await prisma.vpnClient.findUnique({ where: { token } });
      tokenExists = !!existing;
    }
    
    // Calculate expiry
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (durationDays || 30));
    
    // Calculate quota in bytes
    const quotaTotal = BigInt((quotaGB || 10) * 1024 * 1024 * 1024);
    
    // Create VPN client
    const client = await prisma.vpnClient.create({
      data: {
        userId: req.user?.userId || '',
        token,
        quotaTotal,
        quotaUsed: BigInt(0),
        expireAt: expiresAt,
        status: 'active'
      },
      include: { tokens: true }
    });
    
    res.status(201).json({
      success: true,
      client,
      message: `VPN client created with token: ${token}`
    });
  } catch (err) {
    console.error('Create client error:', err);
    res.status(500).json({ error: 'Failed to create VPN client' });
  }
});

// GET /api/vpn-manager/tokens - Get all tokens
router.get('/tokens', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tokens = await prisma.tokenSXB.findMany({
      orderBy: { createdAt: 'desc' },
      include: { client: true }
    });
    res.json(tokens);
  } catch (err) {
    console.error('Get tokens error:', err);
    res.status(500).json({ error: 'Failed to get tokens' });
  }
});

// POST /api/vpn-manager/tokens/generate - Generate new SXB token (standalone or for existing client)
router.post('/tokens/generate', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { clientId, username, quota, durationDays } = req.body;
    
    // Calculate expiry
    const expiration = new Date();
    expiration.setDate(expiration.getDate() + (durationDays || 30));
    
    // Calculate quota
    const quotaBytes = BigInt((quota || 10) * 1024 * 1024 * 1024);
    
    // Generate unique SXB token for display
    let sxbToken: string;
    let tokenExists = true;
    while (tokenExists) {
      sxbToken = generateSXBToken();
      const existing = await prisma.tokenSXB.findUnique({ where: { token: sxbToken } });
      tokenExists = !!existing;
    }
    
    // If clientId provided, create token for existing client
    // Otherwise create a new VPN client with the token
    if (clientId) {
      const newToken = await prisma.tokenSXB.create({
        data: {
          token: sxbToken,
          clientId,
          quota: quotaBytes,
          expiration,
          status: 'active',
          deviceLimit: 1
        }
      });
      
      res.status(201).json({
        success: true,
        token: {
          id: newToken.id,
          token: newToken.token,
          status: newToken.status,
          quota: newToken.quota.toString(),
          expiration: newToken.expiration.toISOString()
        },
        message: `Token generated: ${sxbToken}`
      });
    } else {
      // Create new VPN client and token
      const newClient = await prisma.vpnClient.create({
        data: {
          userId: req.user?.userId || '',
          token: sxbToken,
          quotaTotal: quotaBytes,
          quotaUsed: BigInt(0),
          expireAt: expiration,
          status: 'active',
          tokens: {
            create: {
              token: sxbToken,
              quota: quotaBytes,
              expiration,
              status: 'active',
              deviceLimit: 1
            }
          }
        },
        include: { tokens: true }
      });
      
      res.status(201).json({
        success: true,
        client: {
          id: newClient.id,
          token: newClient.token,
          status: newClient.status,
          quotaTotal: newClient.quotaTotal.toString(),
          expireAt: newClient.expireAt.toISOString()
        },
        token: sxbToken,
        message: `VPN client created with token: ${sxbToken}`
      });
    }
  } catch (err) {
    console.error('Generate token error:', err);
    res.status(500).json({ error: 'Failed to generate token', details: String(err) });
  }
});

// DELETE /api/vpn-manager/clients/:id - Delete VPN client
router.delete('/clients/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await prisma.vpnClient.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Client deleted' });
  } catch (err) {
    console.error('Delete client error:', err);
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

export default router;
