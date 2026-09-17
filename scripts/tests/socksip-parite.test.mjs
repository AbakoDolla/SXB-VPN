/**
 * socksip-parite.test.mjs — Le tableau de bord et l'application lisent un
 * export SocksIP de la MÊME façon.
 *
 * POURQUOI CE TEST EXISTE :
 *
 *   La lecture de ce format vit à deux endroits — `server/services/
 *   canonical-config.ts` pour l'import du tableau de bord, et
 *   `app-mobile/services/socksIpProfile.ts` pour un fichier collé directement
 *   dans l'application. Deux lectures, c'est deux occasions de diverger ; et
 *   une divergence ici ne se voit pas à l'import, seulement plus tard, par un
 *   tunnel qui ne monte pas d'un côté alors qu'il monte de l'autre.
 *
 *   Ce contrôle compare les deux canoniques produits, champ pour champ. Il
 *   échoue dès que l'un des deux change sans l'autre.
 *
 * Exécution : npx tsx --test scripts/tests/socksip-parite.test.mjs
 */
import './register-hooks.mjs';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'e2e-encryption-key-32-bytes-pad!';

const { parseImportedConfig } = await import(
  pathToFileURL(path.join(ROOT, 'server/services/canonical-config.ts')).href
);
const { lireProfilSocksIp, normaliserChargeUtileSocksIp } = await import(
  pathToFileURL(path.join(ROOT, 'app-mobile/services/socksIpProfile.ts')).href
);

const BASE = {
  TypeSSHTransport: 0,
  TypeTunnel: 2,
  DNSTType: 0,
  enableFreeServers: true,
  ProxyHostPort: '5.75.179.98:443@bugsleuth:bugsleuth',
  SSHPassword: 'bugsleuth',
  SSHPayload:
    'CONNECT www.mtnplay.com HTTP/1.1[crlf]\\nHost: www.mtnplay.com[crlf]\\n'
    + 'Proxy-Connection: Keep-Alive[crlf]\\nContent-Length: 0[crlf]\\n[crlf]',
  SSHProxyServerResolution: 'node05.mikosi.fr.eu.org:443@bugsleuth:bugsleuth',
  SSHServer: '5.75.179.98:443',
  SSHServerResolution: 'node05.mikosi.fr.eu.org:443',
  SSHUsername: 'bugsleuth',
  __decode_mode__: 'ver47',
};

/** Les variantes qui font vraiment diverger deux lectures. */
const CAS = {
  'export complet': BASE,
  'proxy distinct du serveur': { ...BASE, ProxyHostPort: '10.0.0.9:8080@bugsleuth:bugsleuth' },
  'sans charge utile': { ...BASE, SSHPayload: '' },
  'charge utile sans jeton': { ...BASE, SSHPayload: 'CONNECT [host_port] HTTP/1.1\\nHost: [host]\\n\\n' },
  'identifiants seulement dans le point d’accès': (() => {
    const c = { ...BASE };
    delete c.SSHUsername;
    delete c.SSHPassword;
    return c;
  })(),
  'serveur absent, proxy seul': (() => {
    const c = { ...BASE };
    delete c.SSHServer;
    return c;
  })(),
};

describe('parité SocksIP — tableau de bord et application', () => {
  for (const [nom, entree] of Object.entries(CAS)) {
    it(`lit « ${nom} » de façon identique des deux côtés`, () => {
      const serveur = parseImportedConfig(JSON.stringify(entree));
      assert.equal(serveur.ok, true, `serveur : ${serveur.errors.join(' | ')}`);
      const mobile = lireProfilSocksIp(entree);
      assert.notEqual(mobile, null, 'application : export refusé');

      // Le canonique du serveur traverse une normalisation commune (port
      // entier, tls booléen) : on compare donc les champs que les deux
      // produisent, et non l'objet entier.
      for (const champ of Object.keys(mobile)) {
        assert.deepEqual(
          serveur.canonical[champ], mobile[champ],
          `champ « ${champ} » divergent : serveur=${JSON.stringify(serveur.canonical[champ])} `
          + `application=${JSON.stringify(mobile[champ])}`,
        );
      }
      // Et le serveur n'invente aucun champ SSH que l'application ignorerait.
      for (const champ of ['protocol', 'sshTransport', 'host', 'port', 'username', 'password', 'usePayload', 'proxyEnabled']) {
        assert.ok(champ in mobile, `l'application doit produire « ${champ} »`);
      }
    });
  }

  it('nettoie la charge utile de la même façon des deux côtés', () => {
    const serveur = parseImportedConfig(JSON.stringify(BASE)).canonical.payload;
    const mobile = normaliserChargeUtileSocksIp(BASE.SSHPayload);
    assert.equal(serveur, mobile);
    assert.ok(!mobile.includes('\\'), 'aucune barre oblique inverse ne doit partir sur le fil');
  });

  it('refuse des deux côtés ce qui n’est pas un profil SocksIP', () => {
    const inutilisable = { TypeTunnel: 2, enableFreeServers: true };
    assert.equal(parseImportedConfig(JSON.stringify(inutilisable)).ok, false);
    assert.equal(lireProfilSocksIp(inutilisable), null);

    // Un canonique SXB porte déjà son protocole : jamais reclassifié.
    const canonique = { protocol: 'ssh', host: '1.2.3.4', port: 22, username: 'u', password: 'p' };
    assert.equal(lireProfilSocksIp(canonique), null);
    assert.notEqual(parseImportedConfig(JSON.stringify(canonique)).sourceFormat, 'socksip-json');
  });
});
