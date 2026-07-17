import Database from 'better-sqlite3';

const XNET_DB_PATH = '/opt/xnet/data/xnet.db';

export interface XNetClient {
  id: string;
  username: string;
  uuid: string;
  status: string;
  traffic_limit_bytes: number;
  traffic_used_bytes: number;
  expire_date: string | null;
  max_connections: number;
  protocol: string;
  created_at: string;
}

export interface XNetInbound {
  id: string;
  remark: string;
  protocol: string;
  port: number;
  enabled: number;
  ws_path: string;
}

export class XNetDirect {
  private db: Database.Database;

  constructor() {
    this.db = new Database(XNET_DB_PATH, { readonly: true });
  }

  getClients(): XNetClient[] {
    try {
      return this.db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all() as XNetClient[];
    } catch {
      return [];
    }
  }

  getActiveClients(): XNetClient[] {
    try {
      return this.db.prepare("SELECT * FROM clients WHERE status = 'active'").all() as XNetClient[];
    } catch {
      return [];
    }
  }

  getInbounds(): XNetInbound[] {
    try {
      return this.db.prepare('SELECT id, remark, protocol, port, enabled, ws_path FROM inbounds WHERE enabled = 1').all() as XNetInbound[];
    } catch {
      return [];
    }
  }

  getStats() {
    try {
      const totalClients = (this.db.prepare('SELECT COUNT(*) as c FROM clients').get() as any)?.c || 0;
      const activeClients = (this.db.prepare("SELECT COUNT(*) as c FROM clients WHERE status = 'active'").get() as any)?.c || 0;
      const totalTraffic = (this.db.prepare('SELECT SUM(traffic_used_bytes) as t FROM clients').get() as any)?.t || 0;
      const inbounds = this.getInbounds();

      return {
        online: true,
        xpanelEngineConnected: true,
        latencyMs: 1,
        activeSyncCount: activeClients,
        totalClients,
        activeClients,
        inactiveClients: totalClients - activeClients,
        totalTrafficBytes: totalTraffic,
        inbounds: inbounds.length,
        lastSyncTime: new Date().toISOString()
      };
    } catch {
      return {
        online: true,
        xpanelEngineConnected: false,
        latencyMs: 0,
        activeSyncCount: 0,
        totalClients: 0,
        activeClients: 0,
        inactiveClients: 0,
        totalTrafficBytes: 0,
        inbounds: 0,
        lastSyncTime: new Date().toISOString()
      };
    }
  }

  close() {
    this.db.close();
  }
}

let xnetInstance: XNetDirect | null = null;

export function getXNetDirect(): XNetDirect {
  if (!xnetInstance) {
    xnetInstance = new XNetDirect();
  }
  return xnetInstance;
}
