import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  parseImportedConfig,
  parseImportedConfigList,
  validateTransportCoherence,
  canonicalJson, encryptCanonical, decryptCanonical, engineConfigFromCanonical,
} from "../services/canonical-config";
import { substitutePayload, DEFAULT_SSH_USER_AGENT } from "../services/transport-probe";
import { relayUpstream } from "../services/ssh-relay-transport";

describe("imports et transports de la gamme SSH", () => {
  it("préserve domaines, IPv4, IPv6 et User-Agent explicite du stockage chiffré au moteur direct", () => {
    const previousKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "synthetic-domain-parity-key";
    try {
      for (const host of ["ssh.example.test", "203.0.113.10", "2001:db8::10"]) {
        const imported = { protocol: "ssh+payload", host, port: 80, tls: false,
          username: "fixture", password: "synthetic-only", payload: "GET / HTTP/1.1[crlf]Host: [host][crlf]User-Agent:[ua][crlf][crlf]",
          userAgent: "Synthetic-Agent/1" };
        const parsed = parseImportedConfig(JSON.stringify(imported));
        assert.equal(parsed.ok, true, parsed.errors.join(" | "));
        const cipher = encryptCanonical(canonicalJson(parsed.canonical!));
        const engine = engineConfigFromCanonical(JSON.parse(decryptCanonical(cipher)!));
        assert.equal(engine.host, host);
        assert.equal(engine.userAgent, imported.userAgent);
        assert.equal(engine.payload, imported.payload);
        assert.equal(engine.tls, false);
      }
      const native = readFileSync(new URL("../../app-mobile/modules/android-native/SxbVpnService.kt", import.meta.url), "utf8");
      assert.ok(native.includes(`private const val SXB_SSH_USER_AGENT = "${DEFAULT_SSH_USER_AGENT}"`));
      assert.doesNotMatch(DEFAULT_SSH_USER_AGENT, /SXB-VPN/);
      assert.match(DEFAULT_SSH_USER_AGENT, /^Mozilla\/5\.0 .*Android/);
      const invalid = validateTransportCoherence({ protocol: "ssh+payload", host: "ssh.example.test", port: 80,
        username: "fixture", password: "synthetic-only", userAgent: "value\r\nInjected: value" });
      assert.ok(invalid.errors.some(error => error.includes("userAgent")));
    } finally {
      if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = previousKey;
    }
  });

  it("transmet l'identité SSH et le payload déclaré jusqu'au relais privé après stockage chiffré", () => {
    const previousKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "synthetic-ssh-fidelity-key";
    try {
      const payload = "[method] [ssh] [protocol][crlf]Host: [host][cr][lf]X-SNI: [sni][crlf]" +
        "User-Agent: [ua][crlf][split]X-Phase: final[crlf][crlf]";
      const imported = {
        protocol: "ssh+payload", sshTransport: "http-connect", host: "ssh.example.test", port: 2222,
        username: "synthetic-user", password: "synthetic-password", tls: true, sni: "tls.example.test",
        proxyEnabled: true, proxyHost: "proxy.example.test", proxyPort: 443,
        fingerprint: "SHA256:" + Buffer.alloc(32, 1).toString("base64").replace(/=+$/, ""),
        payload, userAgent: "Synthetic-SXB/1",
      };
      const parsed = parseImportedConfig(JSON.stringify(imported));
      assert.equal(parsed.ok, true, parsed.errors.join(" | "));
      const stored = encryptCanonical(canonicalJson(parsed.canonical!));
      assert.doesNotMatch(stored, /synthetic-password|ssh\.example\.test|\[split\]/);
      const restored = JSON.parse(decryptCanonical(stored)!);
      const engine = engineConfigFromCanonical(restored);
      assert.equal(engine.payload, payload);
      const upstream = relayUpstream(engine);
      assert.equal(upstream.host, imported.host);
      assert.equal(upstream.port, imported.port);
      assert.equal(upstream.username, imported.username);
      assert.equal(upstream.password, imported.password);
      assert.equal(upstream.proxyHost, imported.proxyHost);
      assert.equal(upstream.proxyPort, imported.proxyPort);
      assert.equal(upstream.payload, payload);
      const expanded = substitutePayload(payload, upstream.host, upstream.sni, upstream.port, "Synthetic-SXB/1");
      assert.match(expanded, /^CONNECT ssh\.example\.test:2222 HTTP\/1\.0\r\n/);
      assert.match(expanded, /User-Agent: Synthetic-SXB\/1\r\n/);
      assert.match(expanded, /Host: ssh\.example\.test\r\n/);
      assert.match(expanded, /X-SNI: tls\.example\.test\r\n/);
    } finally {
      if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = previousKey;
    }
  });

  it("conserve le transport explicite et le budget d'un export SSH Custom v92", () => {
    const payload = "GET / HTTP/1.1[crlf]Host: public.example.test[crlf][crlf]" +
      "X / HTTP/1.1[crlf]Host: [host][crlf][crlf]" +
      "GET / HTTP/1.1[crlf]Host: edge.example.test[crlf]Backend: synthetic[crlf]" +
      "Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]";
    const parsed = parseImportedConfigList(JSON.stringify({
      CONFIGS: [{
        CONFIGS: 18719, NOTE: "synthetic", d: true, CONFIGNAME: "Synthetic SSC",
        "PAYLOAD ENABLED": true, TYPE: "TLS", PORT: 80, TIMEOUT: 58875,
        PROTOCOL: 1, VERSION: 92, ENCRYPTION: 0, COMPRESSIONLEVEL: 0,
        LOCALPORT: 2222, PAYLOAD: payload, ADDRESS: "public.example.test",
        USERNAME: "synthetic", PASSWORD: "synthetic-test-only", DNS: "8.8.8.8",
      }], d: 92,
    }));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].ok, true, parsed[0].errors.join(" | "));
    const config = parsed[0].canonical;
    assert.equal(config?.protocol, "ssh+payload");
    assert.equal(config?.sshTransport, "payload-tls");
    assert.equal(config?.tls, true);
    assert.equal(config?.port, 80);
    assert.equal(config?.timeoutMs, 58875);
    assert.equal(config?.payload, payload);
    assert.equal(config?.dns, "8.8.8.8");
    assert.notEqual(config?.slowDns, true);
    assert.notEqual(config?.proxyEnabled, true);
  });

  it("importe atomiquement les exports HTTP Custom CONFIGS[]", () => {
    const source = {
      CONFIGS: [
        {
          CONFIGS: 0,
          CONFIGNAME: "love camtel A",
          "PAYLOAD ENABLED": true,
          TYPE: "TLS",
          "PROXY ENABLED": true,
          PORT: 53,
          TIMEOUT: 63100,
          LOCALPORT: 2222,
          ADDRESS: "172.105.103.56",
          USERNAME: "ssh",
          PASSWORD: "secret-a",
          DNS: "8.8.8.8",
          NSSERVER: "xs.example.net",
          PUBKEY: "9dbbfb7374360504a22e71b8ffda2c9c3c8ee62283d171fef9d881bd6b51b605",
        },
        {
          CONFIGNAME: "love camtel B",
          "PAYLOAD ENABLED": false,
          TYPE: "SSH",
          PORT: 22,
          ADDRESS: "ssh.example.net",
          USERNAME: "vpn",
          PASSWORD: "secret-b",
        },
      ],
    };

    const parsed = parseImportedConfigList(JSON.stringify(source));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].ok, true, parsed[0].errors.join(" | "));
    assert.equal(parsed[0].sourceFormat, "http-custom-json");
    assert.equal(parsed[0].displayName, "love camtel A");
    assert.equal(parsed[0].canonical?.protocol, "ssh+payload");
    assert.equal(parsed[0].canonical?.sshTransport, "slowdns");
    assert.equal(parsed[0].canonical?.slowDns, true);
    assert.equal(parsed[0].canonical?.tls, true);
    assert.equal(parsed[0].canonical?.proxyEnabled, true);
    assert.equal(parsed[0].canonical?.dns, "8.8.8.8");
    assert.equal(parsed[0].canonical?.nameServer, "xs.example.net");
    assert.equal(parsed[0].canonical?.localPort, 2222);
    assert.match(String(parsed[0].canonical?.payload), /^CONNECT \[host_port\]/);
    assert.equal(parsed[1].canonical?.protocol, "ssh");
    assert.equal(parsed[1].canonical?.sshTransport, "direct");
  });

  it("détecte SlowDNS quand DNS, NSSERVER et PUBKEY valide sont présents", () => {
    const parsed = parseImportedConfig(JSON.stringify({
      ADDRESS: "ssh.example.net",
      PORT: 443,
      USERNAME: "ssh",
      PASSWORD: "secret",
      TYPE: "TLS",
      DNS: "8.8.8.8",
      NSSERVER: "t.example.net",
      PUBKEY: "9dbbfb7374360504a22e71b8ffda2c9c3c8ee62283d171fef9d881bd6b51b605",
    }));
    assert.equal(parsed.ok, true, parsed.errors.join(" | "));
    assert.equal(parsed.canonical?.slowDns, true);
    assert.equal(parsed.canonical?.sshTransport, "slowdns");
    assert.equal(parsed.canonical?.tls, true);
    assert.ok(parsed.warnings.some((warning) => warning.includes("SlowDNS activé automatiquement")));
  });

  it("respecte SLOWDNS=false même si l'export garde des champs dormants", () => {
    const parsed = parseImportedConfig(JSON.stringify({
      ADDRESS: "ssh.example.net",
      PORT: 443,
      USERNAME: "ssh",
      PASSWORD: "secret",
      TYPE: "TLS",
      SLOWDNS: false,
      DNS: "8.8.8.8",
      NSSERVER: "t.example.net",
      PUBKEY: "9dbbfb7374360504a22e71b8ffda2c9c3c8ee62283d171fef9d881bd6b51b605",
    }));
    assert.equal(parsed.ok, true, parsed.errors.join(" | "));
    assert.notEqual(parsed.canonical?.slowDns, true);
    assert.equal(parsed.canonical?.sshTransport, "tls");
  });

  it("valide strictement SlowDNS et UDPGW", () => {
    const valid = validateTransportCoherence({
      protocol: "ssh",
      sshTransport: "slowdns",
      host: "ssh.example.net",
      port: 22,
      username: "vpn",
      password: "secret",
      slowDns: true,
      dns: "8.8.8.8",
      nameServer: "t.example.net",
      slowDnsPublicKey: "9dbbfb7374360504a22e71b8ffda2c9c3c8ee62283d171fef9d881bd6b51b605",
      localPort: 2222,
      udpMode: "udpgw",
      udpGatewayHost: "127.0.0.1",
      udpGatewayPort: 7300,
    });
    assert.deepEqual(valid.errors, []);

    const invalid = validateTransportCoherence({
      protocol: "ssh",
      host: "ssh.example.net",
      port: 22,
      username: "vpn",
      password: "secret",
      slowDns: true,
      dns: "8.8.8.8",
      nameServer: "bad domain",
      slowDnsPublicKey: "not-a-key",
      localPort: 70000,
      udpMode: "direct",
    });
    assert.ok(invalid.errors.some((error) => error.includes("64 caractères hexadécimaux")));
    assert.ok(invalid.errors.some((error) => error.includes("NSSERVER")));
    assert.ok(invalid.errors.some((error) => error.includes("localPort")));
    assert.ok(invalid.errors.some((error) => error.includes("udpMode")));

    const conflict = validateTransportCoherence({
      protocol: "ssh",
      sshTransport: "slowdns",
      slowDns: false,
      host: "ssh.example.net",
      port: 22,
      username: "vpn",
      password: "secret",
      localPort: 1080,
    });
    assert.ok(conflict.errors.some((error) => error.includes("contradictoire")));
    assert.ok(conflict.errors.some((error) => error.includes("localPort 1080")));

    const aliasConflict = parseImportedConfig(JSON.stringify({
      protocol: "ssh+slowdns",
      slowDns: false,
      host: "ssh.example.net",
      port: 22,
      username: "vpn",
      password: "secret",
      dns: "8.8.8.8",
      nameServer: "t.example.net",
      slowDnsPublicKey: "9dbbfb7374360504a22e71b8ffda2c9c3c8ee62283d171fef9d881bd6b51b605",
      localPort: 2222,
    }));
    assert.equal(aliasConflict.ok, false);
    assert.ok(aliasConflict.errors.some((error) => error.includes("contradictoire")));
  });

  it("accepte SSH direct encapsulé dans TLS", () => {
    const parsed = parseImportedConfig(JSON.stringify({
      protocol: "ssh",
      sshTransport: "tls",
      host: "ssh.example.net",
      port: 443,
      username: "vpn",
      password: "secret",
      tls: true,
      sni: "cdn.example.net",
    }));
    assert.equal(parsed.ok, true, parsed.errors.join(" | "));
    assert.equal(parsed.canonical?.tls, true);
  });

  it("normalise les noms usuels de la gamme SSH vers des couches explicites", () => {
    const cases = [
      ["ssh+tls", "ssh", "tls"],
      ["ssh+ssl", "ssh", "tls"],
      ["ssh+payload+tls", "ssh+payload", "payload-tls"],
      ["ssh+payload+ssl", "ssh+payload", "payload-tls"],
      ["ssh+http-connect", "ssh+payload", "http-connect"],
      ["ssh+http", "ssh+payload", "payload"],
      ["ssh+proxy", "ssh+payload", "http-connect"],
      ["ssh+slowdns", "ssh", "slowdns"],
      ["ssh+udp", "ssh", "direct"],
    ] as const;
    for (const [input, protocol, transport] of cases) {
      const parsed = parseImportedConfig(JSON.stringify({
        protocol: input,
        host: "ssh.example.net",
        port: 22,
        username: "vpn",
        password: "secret",
        ...(input === "ssh+slowdns" ? {
          dns: "8.8.8.8",
          nameServer: "t.example.net",
          slowDnsPublicKey: "9dbbfb7374360504a22e71b8ffda2c9c3c8ee62283d171fef9d881bd6b51b605",
          localPort: 2222,
        } : {}),
      }));
      assert.equal(parsed.ok, true, `${input}: ${parsed.errors.join(" | ")}`);
      assert.equal(parsed.canonical?.protocol, protocol);
      assert.equal(parsed.canonical?.sshTransport, transport);
    }
  });

  it("sépare la cible du payload et le SNI comme le moteur Android", () => {
    const payload = substitutePayload(
      "CONNECT [host_port] HTTP/1.1[crlf]Host: %HOST%[crlf]X-SNI: [sni][crlf][crlf]",
      "ssh.example.net",
      "cdn.example.net",
      443,
    );
    assert.match(payload, /^CONNECT ssh\.example\.net:443 HTTP\/1\.1/);
    assert.match(payload, /Host: ssh\.example\.net/);
    assert.match(payload, /X-SNI: cdn\.example\.net/);
  });

  it("sonde le proxy physique sans remplacer la cible logique du payload", () => {
    const probe = readFileSync(
      new URL("../services/transport-probe.ts", import.meta.url),
      "utf8",
    );
    assert.match(probe, /const connectHost = explicitProxy \? String\(canonical\.proxyHost\)\.trim\(\) : host/);
    assert.match(probe, /tcpConnect\(connectHost, connectPort, timeoutMs\)/);
    assert.match(probe, /substitutePayload\(payloadTpl, host, tlsServerName, port,\s+typeof canonical\.userAgent/);
    assert.match(probe, /rejectUnauthorized: !insecure/);
    assert.match(probe, /canonical\.insecure === true/);
    assert.match(probe, /Payload CONNECT non prouvé depuis ce serveur/);
  });
});
