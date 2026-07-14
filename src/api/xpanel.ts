import { XPanelStatus, UserRole } from "../types";
import { getClients, getServers, getCurrentUser, logActivity } from "./db";

let isSyncingState = false;

export async function getXPanelStatus(): Promise<XPanelStatus> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const activeClients = getClients().filter((c) => c.status === "active").length;
      const onlineServers = getServers().filter((s) => s.status === "online").length;
      
      resolve({
        status: "online",
        connectedServers: onlineServers,
        synchronizedUsers: activeClients,
        availableConfigs: 6, // Protocols like VLESS, VMESS, Trojan, Shadowbox, SSH, Hysteria
        isSyncing: isSyncingState,
      });
    }, 150);
  });
}

export interface XPanelUser {
  username: string;
  protocol: string;
  connectedIp: string;
  duration: string;
  trafficUsed: number;
}

export async function fetchXPanelUsers(): Promise<XPanelUser[]> {
  const currentUser = getCurrentUser();
  if (currentUser.role === UserRole.RESELLER) {
    throw new Error("Accès refusé : Permission XPanel insuffisante");
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      // Dynamic generation based on actual active clients in memory
      const activeClients = getClients().filter((c) => c.status === "active");
      const list: XPanelUser[] = activeClients.map((c) => ({
        username: c.name,
        protocol: c.plan.includes("Premium") ? "VLESS + Sing-Box" : "SSH Direct",
        connectedIp: `197.84.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
        duration: `${Math.floor(Math.random() * 12) + 1}h ${Math.floor(Math.random() * 60)}m`,
        trafficUsed: Number((Math.random() * 2.5).toFixed(2)),
      }));
      resolve(list);
    }, 200);
  });
}

export interface XPanelConfig {
  id: string;
  name: string;
  protocol: string;
  uuid: string; // Sensitive
  privateKey?: string; // Sensitive
  port: number;
  fullConfigUrl: string; // Sensitive
}

export async function fetchXPanelConfigurations(): Promise<XPanelConfig[]> {
  const currentUser = getCurrentUser();
  
  // Reseller and Support can't view configurations
  if (currentUser.role === UserRole.RESELLER || currentUser.role === UserRole.SUPPORT) {
    throw new Error("Accès refusé : Permission de voir les configurations VPN refusée par le système RBAC.");
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      // Return highly detailed VPN configurations (only for Admin)
      const list: XPanelConfig[] = [
        {
          id: "cfg-1",
          name: "Sing-box VLESS XTLS",
          protocol: "VLESS",
          uuid: "e814a098-b633-4f3b-b2f7-ec8f38dbb24c",
          privateKey: "mc89...m219amNvbXBt...",
          port: 443,
          fullConfigUrl: "vless://e814a098-b633-4f3b-b2f7-ec8f38dbb24c@sxb-node1.net:443?security=xtls&sni=sxb-vpn.com#SXB-VLESS",
        },
        {
          id: "cfg-2",
          name: "Trojan TLS Tunnel",
          protocol: "Trojan",
          uuid: "trojan-pass-sxb-vless-secure",
          privateKey: "not-applicable-pre-shared-key",
          port: 8443,
          fullConfigUrl: "trojan://trojan-pass-sxb-vless-secure@sxb-node1.net:8443?sni=sxb-vpn.com#SXB-Trojan",
        },
        {
          id: "cfg-3",
          name: "VLESS gRPC Websocket",
          protocol: "VLESS",
          uuid: "9f01a08c-9b11-477d-8cc7-3ffab8dbb32c",
          privateKey: "abc...key...",
          port: 80,
          fullConfigUrl: "vless://9f01a08c-9b11-477d-8cc7-3ffab8dbb32c@sxb-node2.net:80?type=ws&path=/sxb-grpc#SXB-gRPC",
        },
      ];
      resolve(list);
    }, 250);
  });
}

export async function triggerXPanelSync(): Promise<void> {
  const currentUser = getCurrentUser();
  if (currentUser.role !== UserRole.ADMIN) {
    throw new Error("Accès refusé : Seuls les administrateurs peuvent forcer la synchronisation XPanel.");
  }

  isSyncingState = true;
  const actor = currentUser.name;
  logActivity(`Lancement de la synchronisation forcée XPanel (SSH & Sing-box)`, actor, "info");

  return new Promise((resolve) => {
    setTimeout(() => {
      isSyncingState = false;
      logActivity(`Synchronisation XPanel terminée avec succès. Serveurs mis à jour.`, actor, "success");
      resolve();
    }, 2500); // 2.5s simulated heavy sync background task
  });
}
