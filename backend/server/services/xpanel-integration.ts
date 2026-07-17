import { prisma } from '../database';
import Database from 'better-sqlite3';
import crypto from 'crypto';

const XNET_DB_PATH = '/opt/xnet/data/xnet.db';

export interface XNetClient {
  id: string;
  username: string;
  uuid: string;
  status: string;
  trafficLimit: bigint;
  trafficUsed: bigint;
  expireDate: string | null;
  maxConnections: number;
}

export class XPanelIntegration {
  private db: Database.Database;

  constructor() {
    this.db = new Database(XNET_DB_PATH, { readonly: false });
  }

  static generateToken(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const segment = () => Array.from({length: 4}, () => chars[crypto.randomInt(chars.length)]).join('');
    return 'SXB-' + segment() + '-' + segment() + '-' + segment();
  }

  getClients(): XNetClient[] {
    const rows = this.db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all() as any[];
    return rows.map(row => ({
      id: row.id,
      username: row.username,
      uuid: row.uuid,
      status: row.status,
      trafficLimit: BigInt(row.traffic_limit_bytes || 0),
      trafficUsed: BigInt(row.traffic_used_bytes || 0),
      expireDate: row.expire_date,
      maxConnections: row.max_connections || 1
    }));
  }

  getClientById(id: string): XNetClient | null {
    const row = this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      uuid: row.uuid,
      status: row.status,
      trafficLimit: BigInt(row.traffic_limit_bytes || 0),
      trafficUsed: BigInt(row.traffic_used_bytes || 0),
      expireDate: row.expire_date,
      maxConnections: row.max_connections || 1
    };
  }

  async createClient(data: {
    username: string;
    email?: string;
    trafficLimitBytes: bigint;
    expireDate?: Date;
    inboundId?: string;
  }): Promise<XNetClient> {
    const id = crypto.randomUUID();
    const uuid = crypto.randomUUID();
    
    const inbound = this.db.prepare('SELECT id FROM inbounds WHERE enabled = 1 LIMIT 1').get() as any;
    const inboundId = data.inboundId || inbound?.id || 'default';
    
    const stmt = this.db.prepare(`
      INSERT INTO clients (id, inbound_id, username, email, uuid, protocol, status, traffic_limit_bytes, traffic_used_bytes, created_at, expire_date)
      VALUES (?, ?, ?, ?, ?, 'vless', 'active', ?, 0, ?, ?)
    `);
    
    const now = new Date().toISOString();
    stmt.run(id, inboundId, data.username, data.email || '', uuid, data.trafficLimitBytes.toString(), now, data.expireDate?.toISOString() || null);
    
    const token = XPanelIntegration.generateToken();
    if (prisma) {
      await prisma.vpnToken.create({
        data: {
          token,
          clientId: id,
          username: data.username,
          status: 'active',
          expiresAt: data.expireDate
        }
      });
    }
    
    return {
      id,
      username: data.username,
      uuid,
      status: 'active',
      trafficLimit: data.trafficLimitBytes,
      trafficUsed: BigInt(0),
      expireDate: data.expireDate?.toISOString() || null,
      maxConnections: 1
    };
  }

  deleteClient(id: string): void {
    this.db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  }

  getClientConfig(clientId: string): any {
    const client = this.getClientById(clientId);
    if (!client) return null;
    
    const inbound = this.db.prepare('SELECT * FROM inbounds WHERE enabled = 1 LIMIT 1').get() as any;
    if (!inbound) return null;
    
    return {
      protocol: inbound.protocol,
      address: 'vpnsxb.afrihall.com',
      port: inbound.port,
      uuid: client.uuid,
      path: inbound.ws_path || '/ws',
      remark: client.username
    };
  }

  getStats() {
    const totalClients = (this.db.prepare('SELECT COUNT(*) as count FROM clients').get() as any).count;
    const activeClients = (this.db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'active'").get() as any).count;
    const totalTraffic = (this.db.prepare('SELECT SUM(traffic_used_bytes) as total FROM clients').get() as any).total || 0;
    
    return {
      totalClients,
      activeClients,
      inactiveClients: totalClients - activeClients,
      totalTrafficUsed: BigInt(totalTraffic)
    };
  }

  close() {
    this.db.close();
  }
}

export const xpanelIntegration = new XPanelIntegration();
