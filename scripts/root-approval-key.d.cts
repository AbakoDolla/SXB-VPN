import type { KeyObject } from 'node:crypto';
export const CREDENTIAL: 'SXB-ROOT-ACCESS-1';
export function rootSigningIdentity(secret: string | undefined): {
  key: KeyObject;
  publicKey: string;
  keyId: string;
};
export function publicRootAuthority(secret: string | undefined): {
  version: number;
  scope: string;
  origin: string;
  publicKey: string;
  keyId: string;
};
export function prepareRootAuthority(source: string, parsed: Record<string, string>, confirmed: boolean,
  generate?: () => string): { after: string; authority: ReturnType<typeof publicRootAuthority>; changed: boolean };
