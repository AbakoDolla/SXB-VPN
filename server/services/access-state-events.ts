import type { MobileIdentity } from "./access-ticket";

export const ACCESS_STATE_LIMITS = { waitSeconds: 25, resyncMs: 2000, maxWaiters: 1024, coalesceMs: 25 } as const;
export class AccessWaitLimitError extends Error {}
type Invalidation = { clientId?: string; subscriptionId?: string };
type Waiter = { identity: MobileIdentity; subscriptions: Set<string>; wake: () => void };

export class AccessStateHub {
  private readonly waiters = new Map<string, Waiter>();
  constructor(private readonly maximum: number = ACCESS_STATE_LIMITS.maxWaiters) {}
  get size() { return this.waiters.size; }

  subscribe(identity: MobileIdentity, wake: () => void) {
    const key = JSON.stringify([identity.clientId, identity.deviceId]);
    if (this.waiters.has(key) || this.waiters.size >= this.maximum) throw new AccessWaitLimitError();
    const waiter = { identity, subscriptions: new Set<string>(), wake };
    this.waiters.set(key, waiter);
    return {
      update: (snapshot: { subscriptions: Array<{ id: string }> }) => {
        waiter.subscriptions = new Set(snapshot.subscriptions.map(sub => sub.id));
      },
      close: () => { if (this.waiters.get(key) === waiter) this.waiters.delete(key); },
    };
  }

  invalidate(hint: Invalidation = {}) {
    for (const waiter of this.waiters.values()) {
      if (hint.clientId && waiter.identity.clientId !== hint.clientId) continue;
      if (hint.subscriptionId && !waiter.subscriptions.has(hint.subscriptionId)) continue;
      waiter.wake();
    }
  }
}

export const accessStateHub = new AccessStateHub();
