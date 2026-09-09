import type { AccessIssue } from './accessPolicy';

// Request stamps are independent of React closures and of the opaque server revision.
let epoch = 0;
let revision = 0;
export const accessRequestStamp = () => ({ epoch, revision });
export const advanceAccessRevision = () => { revision++; };
export const advanceAccessSession = () => { epoch++; revision++; };
export const currentAccessRequest = (stamp: { epoch: number; revision: number }) =>
  stamp.epoch === epoch && stamp.revision === revision;
export const currentIdentityRequest = (stamp: { epoch: number }) => stamp.epoch === epoch;

type Failure = { issue: AccessIssue; stamp: ReturnType<typeof accessRequestStamp> };
const listeners = new Set<(failure: Failure) => void>();
export function subscribeAccessFailures(listener: (failure: Failure) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function publishAccessFailure(issue: AccessIssue, stamp: Failure['stamp']) {
  if (!currentIdentityRequest(stamp)) return;
  listeners.forEach(listener => listener({ issue, stamp }));
}
