export interface EngineAccountMetadata {
  id: string;
  name: string;
  status: "active" | "suspended" | "expired";
  expireAt: string | null;
  quotaTotal: string | null;
  quotaUsed: string;
  clientId?: string | null;
  client?: { id: string; userId?: string; user: { name: string; email: string } | null } | null;
  createdAt: string;
  updatedAt: string;
  profileId?: string | null;
  hasLock?: boolean;
}

export interface LockedEngineAccount extends EngineAccountMetadata {
  isLocked: true;
  hasLock: true;
  profileId: string;
}

export interface LegacyEngineAccount extends EngineAccountMetadata {
  // Missing lock metadata is supported only for legacy responses.
  isLocked?: false;
}
