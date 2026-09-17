/**
 * import-socksip.test.mjs — Import d'un profil SSH exporté par SocksIP.
 *
 * LE CAS RÉEL, tel qu'il est arrivé :
 *
 *   L'exploitant fournit un profil SSH à charge utile, exporté par SocksIP et
 *   qui fonctionne chez son auteur. L'importateur du tableau de bord le rejetait
 *   tout net : « champ protocol requis ». Il fallait donc le retranscrire champ
 *   par champ, à la main, en devinant les correspondances — pour un format qui
 *   circule couramment entre exploitants.
 *
 *   Et même retranscrite, sa charge utile était piégée : l'export intercale des
 *   séquences `\n` de DEUX CARACTÈRES entre ses lignes, en plus des jetons
 *   `[crlf]` qui portent déjà la vraie fin de ligne. Transmises telles quelles,
 *   ces deux lettres partent sur le fil au milieu des en-têtes HTTP.
 *
 * Exécution : npx tsx --test scripts/tests/import-socksip.test.mjs
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

/** L'export fourni par l'exploitant, dans sa forme exacte. */
const EXPORT_SOCKSIP = {
  DNSResolver: 0,
  DNSTType: 0,
  FreePortIndex: 0,
  ReceiverC: 0,
  SenderC: 0,
  TypeSSHTransport: 0,
  TypeTunnel: 2,
  UDPRequestType: 0,
  enableFreeServers: true,
  endPort: 0,
  expireFile: 0,
  remotePortUDP: 0,
  ProxyHostPort: '5.75.179.98:443@bugsleuth:bugsleuth',
  SSHPassword: 'bugsleuth',
  SSHPayload:
    'CONNECT www.mtnplay.com HTTP/1.1[crlf]\\nHost: www.mtnplay.com[crlf]\\n'
    + 'User-Agent: Mozilla/5.0 (Linux; Android 11; Mobile)[crlf]\\n'
    + 'Proxy-Connection: Keep-Alive[crlf]\\nContent-Length: 0[crlf]\\n[crlf]',
  SSHProxyServerResolution: 'node05.mikosi.fr.eu.org:443@bugsleuth:bugsleuth',
  SSHServer: '5.75.179.98:443',
  SSHServerResolution: 'node05.mikosi.fr.eu.org:443',
  SSHUsername: 'bugsleuth',
  expiration: 0,
  __decode_mode__: 'ver47',
};

const importer = (obj) => parseImportedConfig(JSON.stringify(obj));

describe('import d’un profil SocksIP', () => {
  it('accepte l’export tel quel, sans retranscription', () => {
    const r = importer(EXPORT_SOCKSIP);
    assert.equal(r.ok, true, r.errors.join(' | '));
    assert.equal(r.sourceFormat, 'socksip-json');
    assert.equal(r.canonical.protocol, 'ssh+payload');
    assert.equal(r.canonical.sshTransport, 'payload');
    assert.equal(r.canonical.host, '5.75.179.98');
    assert.equal(r.canonical.port, 443);
    assert.equal(r.canonical.username, 'bugsleuth');
    assert.equal(r.canonical.password, 'bugsleuth');
    assert.equal(r.canonical.usePayload, true);
  });

  it('nettoie les séparateurs d’affichage de la charge utile', () => {
    const charge = importer(EXPORT_SOCKSIP).canonical.payload;
    // Aucune barre oblique inverse ne doit subsister : elle partirait sur le fil.
    assert.ok(!charge.includes('\\n'), 'les « \\n » littéraux doivent disparaître');
    assert.ok(!charge.includes('\\r'), 'les « \\r » littéraux doivent disparaître');
    // Les vraies fins de ligne, elles, sont conservées telles que le moteur les attend.
    assert.equal((charge.match(/\[crlf\]/g) ?? []).length, 6);
    assert.ok(charge.startsWith('CONNECT www.mtnplay.com HTTP/1.1[crlf]'));
    assert.ok(charge.endsWith('[crlf][crlf]'), 'la ligne vide finale ferme les en-têtes');
    // L'hôte de façade de la charge utile n'est jamais réécrit : c'est lui qui
    // fait passer le profil sur un forfait restreint.
    assert.ok(charge.includes('Host: www.mtnplay.com[crlf]'));
  });

  it('porte la fin de ligne quand l’export n’emploie aucun jeton', () => {
    // Certaines variantes n'écrivent que des « \n ». Les supprimer laisserait
    // une requête sur une seule ligne, que jamais aucun frontal n'accepte.
    const r = importer({
      ...EXPORT_SOCKSIP,
      SSHPayload: 'CONNECT [host_port] HTTP/1.1\\nHost: [host]\\n\\n',
    });
    assert.equal(r.ok, true, r.errors.join(' | '));
    assert.equal(r.canonical.payload, 'CONNECT [host_port] HTTP/1.1[crlf]Host: [host][crlf][crlf]');
  });

  it('ne déclare un proxy que s’il DIFFÈRE du serveur', () => {
    // SocksIP recopie souvent le serveur dans ProxyHostPort. Le prendre pour un
    // proxy distinct ferait basculer le moteur sur un CONNECT en deux temps.
    const memeHote = importer(EXPORT_SOCKSIP).canonical;
    assert.equal(memeHote.proxyEnabled, false);
    assert.equal(memeHote.proxyHost, undefined);
    assert.equal(memeHote.sshTransport, 'payload');

    const distinct = importer({ ...EXPORT_SOCKSIP, ProxyHostPort: '10.0.0.9:8080@bugsleuth:bugsleuth' }).canonical;
    assert.equal(distinct.proxyEnabled, true);
    assert.equal(distinct.proxyHost, '10.0.0.9');
    assert.equal(distinct.proxyPort, 8080);
    assert.equal(distinct.sshTransport, 'http-connect');
    // L'adresse du SSH, elle, ne bouge pas.
    assert.equal(distinct.host, '5.75.179.98');
  });

  it('lit les identifiants portés par ProxyHostPort quand ils manquent ailleurs', () => {
    const sansChamps = { ...EXPORT_SOCKSIP };
    delete sansChamps.SSHUsername;
    delete sansChamps.SSHPassword;
    const c = importer(sansChamps).canonical;
    assert.equal(c.username, 'bugsleuth');
    assert.equal(c.password, 'bugsleuth');
  });

  it('retombe sur du SSH simple quand aucune charge utile n’est fournie', () => {
    const r = importer({ ...EXPORT_SOCKSIP, SSHPayload: '' });
    assert.equal(r.ok, true, r.errors.join(' | '));
    assert.equal(r.canonical.protocol, 'ssh');
    assert.equal(r.canonical.sshTransport, 'direct');
    assert.equal(r.canonical.usePayload, false);
    assert.equal(r.canonical.payload, undefined);
  });

  it('dit ce qu’il a déduit, plutôt que de deviner en silence', () => {
    const r = importer(EXPORT_SOCKSIP);
    const avertissements = r.warnings.join(' | ');
    // Les énumérations du format ne sont documentées nulle part : les
    // interpréter au jugé produirait un profil silencieusement faux.
    assert.match(avertissements, /TypeTunnel/);
    assert.match(avertissements, /node05\.mikosi\.fr\.eu\.org/);
  });

  it('ne détourne aucun autre format', () => {
    // Un canonique SXB porte déjà son protocole : il ne doit jamais être
    // reclassifié, même s'il contient un hôte et des identifiants.
    const canonique = importer({
      protocol: 'ssh+payload', host: '1.2.3.4', port: 22,
      username: 'u', password: 'p', payload: 'CONNECT [host_port] HTTP/1.1[crlf][crlf]',
    });
    assert.equal(canonique.ok, true, canonique.errors.join(' | '));
    assert.notEqual(canonique.sourceFormat, 'socksip-json');

    // Et une URI VLESS reste une URI VLESS.
    const vless = parseImportedConfig(
      'vless://ae446a7b-9988-4353-80c7-050a915e1a1e@front.example.com:443?type=ws&security=tls&host=svc.example.com#x',
    );
    assert.equal(vless.sourceFormat, 'vless-uri');
  });

  it('refuse toujours un JSON qui ne ressemble à rien', () => {
    const r = importer({ TypeTunnel: 2, enableFreeServers: true, expiration: 0 });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' | '), /SocksIP/);
  });
});
