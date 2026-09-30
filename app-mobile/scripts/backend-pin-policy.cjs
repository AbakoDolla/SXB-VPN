const fs = require('node:fs');
const path = require('node:path');

function validatePinPolicy(policy) {
  if (!policy || policy.version !== 1 || typeof policy.origin !== 'string' ||
      !Array.isArray(policy.pins) || policy.pins.length < 2 || policy.pins.length > 8 ||
      policy.pins.some(pin => typeof pin !== 'string' || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(pin)) ||
      new Set(policy.pins).size !== policy.pins.length) throw new Error('BACKEND_PIN_POLICY_INVALID');
  const url = new URL(policy.origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith('/api') || policy.origin.endsWith('/')) throw new Error('BACKEND_PIN_ORIGIN_INVALID');
  return { version: 1, origin: policy.origin, pins: [...policy.pins] };
}

function readPinPolicy() {
  return validatePinPolicy(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'security', 'backend-pins.json'), 'utf8')));
}

function pinsForOrigin(origin, override, policy = readPinPolicy()) {
  if (override !== undefined && override !== '') {
    return validatePinPolicy({ version: 1, origin, pins: JSON.parse(override) }).pins;
  }
  if (origin !== policy.origin) throw new Error('BACKEND_PIN_ORIGIN_REQUIRES_REVIEW');
  return [...policy.pins];
}

module.exports = { validatePinPolicy, readPinPolicy, pinsForOrigin };
