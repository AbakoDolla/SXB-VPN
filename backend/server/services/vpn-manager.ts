import { prisma } from '../database';
import crypto from 'crypto';

// Generate unique SXB token: SXB-XXXX-XXXX-XXXX
export function generateSXBToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segment = () => Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `SXB-${segment()}-${segment()}-${segment()}`;
}

// Create VPN client with SXB token
export async function createVPNClient(data: {
  username: string;
  email?: string;
  plan: string;
  durationDays: number;
  trafficGB: number;
}) {
  // Generate SXB token
  const token = generateSXBToken();
  
  // Calculate expiry
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + data.durationDays);
  
  // Calculate traffic limit in bytes
  const trafficLimitBytes = BigInt(data.trafficGB * 1024 * 1024 * 1024);
  
  // Create in PostgreSQL
  const client = await prisma.vpnClient.create({
    data: {
      email: data.email || '',
      username: data.username,
      plan: data.plan,
      status: 'active',
      trafficLimit: trafficLimitBytes,
      trafficUsed: BigInt(0),
      expiresAt,
      maxConnections: 1
    }
  });
  
  // Create SXB token
  const vpnToken = await prisma.vpnToken.create({
    data: {
      token,
      clientId: client.id,
      username: data.username,
      status: 'active',
      expiresAt
    }
  });
  
  return {
    client,
    token: vpnToken.token,
    expiresAt
  };
}

// Get real-time statistics
export async function getVPNStats() {
  const [
    totalClients,
    activeClients,
    totalTokens,
    activeTokens
  ] = await Promise.all([
    prisma.vpnClient.count(),
    prisma.vpnClient.count({ where: { status: 'active' } }),
    prisma.vpnToken.count(),
    prisma.vpnToken.count({ where: { status: 'active' } })
  ]);
  
  // Get traffic stats
  const clients = await prisma.vpnClient.findMany({
    where: { status: 'active' },
    select: { trafficUsed: true, trafficLimit: true }
  });
  
  const totalTrafficUsed = clients.reduce((sum, c) => sum + c.trafficUsed, BigInt(0));
  const totalTrafficLimit = clients.reduce((sum, c) => sum + c.trafficLimit, BigInt(0));
  
  return {
    totalClients,
    activeClients,
    inactiveClients: totalClients - activeClients,
    totalTokens,
    activeTokens,
    totalTrafficUsed: totalTrafficUsed.toString(),
    totalTrafficLimit: totalTrafficLimit.toString()
  };
}

// Format bytes to human readable
export function formatBytes(bytes: bigint | number): string {
  const b = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) {
    i++;
  }
  return (b / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}
