/**
 * api-client-stub.mjs — Remplace app-mobile/services/apiClient.ts pour tests.
 * Réutilise le VRAI axios (app-mobile/node_modules) vers le serveur de test
 * local. Le JWT est injecté via globalThis.__SXB_TEST_JWT (simule SecureStore).
 */
import axios from 'axios';

const BASE = () => `${globalThis.__SXB_TEST_BASE || 'http://127.0.0.1:1'}/api`;

async function request(method, url, body) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (globalThis.__SXB_TEST_JWT) headers.Authorization = `Bearer ${globalThis.__SXB_TEST_JWT}`;
  const res = await axios({
    method, url: BASE() + url, data: body, headers, timeout: 10000,
    validateStatus: (s) => s < 500, // comporte comme axios côté app : rejette seulement >= 500 ici pour lecture du corps 4xx
  });
  if (res.status >= 400) {
    const err = new Error(`Request failed with status code ${res.status}`);
    err.response = res;
    throw err;
  }
  return res;
}

export default {
  post: (url, body) => request('post', url, body),
  get:  (url)       => request('get', url),
};
