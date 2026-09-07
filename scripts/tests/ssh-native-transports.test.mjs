import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const service = read('app-mobile/modules/android-native/SxbVpnService.kt');
const udpgw = read('app-mobile/modules/android-native/SxbUdpGateway.kt');
const build = read('app-mobile/scripts/build-dnstt.sh');
const workflow = read('.github/workflows/build-android.yml');
const validator = read('app-mobile/services/configValidator.ts');

describe('Android SSH native transports', () => {
  it('builds the pinned DNSTT client reproducibly for both Android ABIs', () => {
    assert.match(build, /Mygod\/dnstt\.git/);
    assert.match(build, /17aa1fed864cd5493e3d09a14df1b8b5cc1df123/);
    assert.doesNotMatch(build, /anonvector\/dnstt/);
    assert.match(build, /go1\.24/);
    assert.match(build, /CGO_ENABLED=1 GOOS=android/);
    assert.match(build, /aarch64-linux-android/);
    assert.match(build, /armv7a-linux-androideabi/);
    assert.match(build, /ANDROID_API=21/);
    assert.match(build, /-buildmode=pie/);
    assert.match(build, /max-page-size=16384/);
    assert.ok(build.includes('"arm64-v8a" "arm64"'));
    assert.ok(build.includes('"armeabi-v7a" "arm"'));
    assert.ok(build.includes('/libdnstt.so'));
  });

  it('protects DNSTT sockets passed with SCM_RIGHTS and owns process cleanup', () => {
    assert.match(service, /LocalSocketAddress\(socketFile\.absolutePath, LocalSocketAddress\.Namespace\.FILESYSTEM\)/);
    assert.match(service, /LocalServerSocket\(binder\.fileDescriptor\)/);
    assert.match(service, /SCM_RIGHTS/);
    assert.match(service, /ancillaryFileDescriptors/);
    assert.match(service, /protect\(descriptor\)/);
    assert.match(service, /Os\.close\(descriptor\)/);
    assert.match(service, /if \(protected\) \{[\s\S]{0,100}client\.outputStream\.write\(1\)/);
    assert.doesNotMatch(service, /write\(if \(protected\) 1 else 0\)/);
    assert.match(service, /ProcessBuilder\(executable\.absolutePath\)/);
    for (const name of ['SS_PLUGIN_OPTIONS', 'SS_LOCAL_HOST', 'SS_LOCAL_PORT', '__android_vpn=1']) {
      assert.ok(service.includes(name), `missing DNSTT environment ${name}`);
    }
    assert.match(service, /\.directory\(filesDir\)/);
    assert.match(service, /domain=\$tunnelDomain/);
    assert.match(service, /val resolver = cfg\.optStringOrNull\("dns"/);
    assert.match(service, /endpoint\.startsWith\("\["\)/);
    assert.match(service, /close == endpoint\.lastIndex/);
    assert.match(service, /isProcessRunning\(process\)/);
    assert.match(service, /SocketTimeoutException\("Timeout au démarrage/);
    assert.match(service, /sshConnectHost = if \(dnsttPort != null\) "127\.0\.0\.1"/);
    assert.match(service, /getSession\(username, sshConnectHost, sshConnectPort\)/);
    assert.match(service, /stopDnstt\(\)[\s\S]{0,120}socks5Server\?\.close/);
  });

  it('keeps logical payload targets distinct from physical proxy endpoints', () => {
    assert.match(service, /private val connectHost: String/);
    assert.match(service, /private val targetHost: String/);
    assert.match(service, /rawSocket\.connect\(InetSocketAddress\(connectHost, connectPort\)/);
    assert.match(service, /expandSshPayloadTokens\(rawPayload, targetHost, targetPort, userAgent, sni\)/);
    for (const token of [
      '[crlf]', '[lf]', '[cr]', '[lfcr]', '[host]', '[host_port]', '[port]', '[ua]',
      '[sni]', '%HOST%', '%IP%', '%PORT%', '%RAND%', '%SNI%',
    ]) assert.ok(service.includes(`"${token}"`), `missing payload token ${token}`);
    assert.match(service, /isConnectPayload/);
    assert.match(service, /response\.contains\("101"\)/);
    assert.match(service, /WEBSOCKET_RFC6455/);
    assert.match(service, /endpointIdentificationAlgorithm = "HTTPS"/);
    assert.match(service, /tlsInsecure/);
  });

  it('implements SOCKS5 UDP ASSOCIATE through BadVPN udpgw', () => {
    assert.match(service, /command == 3/);
    assert.match(service, /udpMode != "udpgw"/);
    assert.match(service, /byteArrayOf\(5, 7,/);
    assert.match(udpgw, /ChannelDirectTCPIP/);
    assert.match(udpgw, /FLAG_KEEPALIVE = 0x01/);
    assert.match(udpgw, /FLAG_REBIND = 0x02/);
    assert.match(udpgw, /FLAG_DNS = 0x04/);
    assert.match(udpgw, /FLAG_IPV6 = 0x08/);
    assert.match(udpgw, /FRAG doit rester 0/);
    assert.match(udpgw, /packetproto uint16 little-endian/);
    assert.match(udpgw, /Inet6Address/);
    assert.match(udpgw, /writeBe16\(socks\.port\)/);
    assert.match(udpgw, /val responsePort = \(\(frame\[portOffset\].*shl 8\) or/s);
    assert.match(udpgw, /responseAddress != destination\.address \|\| responsePort != destination\.port/);
    assert.match(udpgw, /write\(\(responsePort ushr 8\) and 0xff\)/);
    assert.match(udpgw, /write\(responsePort and 0xff\)/);
    assert.match(udpgw, /MAX_DATAGRAM = 32768/);
    assert.match(udpgw, /class ConnectionTable/);
    assert.match(udpgw, /LinkedHashMap<DestinationKey, Int>/);
    assert.match(udpgw, /getOrAllocate\(destination\)/);
    assert.match(udpgw, /getById\(connectionId\)/);
    assert.match(udpgw, /MAX_CONNECTIONS = 256/);
    assert.doesNotMatch(udpgw, /CONNECTION_ID\s*=\s*1/);
    assert.match(udpgw, /DatagramSocket\(InetSocketAddress/);
  });

  it('validates supported SSH modes without claiming unsupported UDP success', () => {
    assert.match(validator, /direct', 'tls', 'payload', 'payload-tls', 'http-connect', 'slowdns/);
    assert.match(validator, /slowDnsPublicKey/);
    assert.match(validator, /udpMode.*udpgw/s);
    assert.match(validator, /udpGatewayPort \?\? 7300/);
    assert.match(validator, /proxyEnabled/);
    assert.match(validator, /timeoutMs/);
    assert.doesNotMatch(validator, /SSH direct \+ TLS activé : combinaison REJETÉE/);
  });

  it('builds DNSTT after prebuild and verifies both libraries in the APK', () => {
    assert.match(workflow, /Setup Go 1\.24[\s\S]*go-version: "1\.24\.x"/);
    const prebuild = workflow.indexOf('Expo prebuild (Android, clean)');
    const libbox = workflow.indexOf('Extraire les bibliothèques natives libbox vers jniLibs');
    const dnstt = workflow.indexOf('Construire DNSTT Android');
    assert.ok(prebuild >= 0 && libbox > prebuild && dnstt > libbox);
    assert.match(workflow, /DNSTT_OUTPUT_DIR="\$PWD\/android\/app\/src\/main\/jniLibs"/);
    assert.match(workflow, /arm64-v8a\/libdnstt\.so/);
    assert.match(workflow, /armeabi-v7a\/libdnstt\.so/);
    assert.match(workflow, /libbox\\?\.so|libbox\\\.so/);
    assert.ok(workflow.includes('lib/${ABI}/libdnstt\\\\.so'));
  });
});
