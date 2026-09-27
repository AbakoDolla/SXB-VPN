import { currentIdentityRequest } from './accessEvents';

let writes: Promise<unknown> = Promise.resolve();

export function assertIdentityRequest(stamp: { epoch: number }): void {
  if (!currentIdentityRequest(stamp)) throw new Error('AUTH_SESSION_CHANGED');
}

export function serializeIdentityPersistence<T>(operation: () => Promise<T>): Promise<T> {
  const next = writes.then(operation);
  writes = next.catch(() => { /* The caller receives the error; subsequent owners must still run. */ });
  return next;
}

export async function waitForIdentityPersistence(stamp: { epoch: number }): Promise<void> {
  await writes;
  assertIdentityRequest(stamp);
}

// A rejected write must not release the owner while another write is still in flight.
export async function settleIdentityWrites(operations: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(operations);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
