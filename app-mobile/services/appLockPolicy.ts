export const APP_LOCK_DELAY_MS = 30_000;
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 8;

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${MIN_PIN_LENGTH},${MAX_PIN_LENGTH}}$`).test(pin);
}

export function shouldLockAfterBackground(
  backgroundedAt: number | null,
  now: number,
  delayMs = APP_LOCK_DELAY_MS,
): boolean {
  return backgroundedAt !== null && now - backgroundedAt >= delayMs;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return difference === 0;
}
