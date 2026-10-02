const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const input = process.argv[2] || path.resolve(__dirname, '..', 'modules', 'android-native', 'SxbVpnService.kt');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'sxb-frame-throughput-'));
try {
  const source = readFileSync(input, 'utf8');
  const start = source.indexOf('private object SxbSshIoPolicy') >= 0
    ? source.indexOf('private object SxbSshIoPolicy') : source.indexOf('private class WsOutputStream');
  const end = source.indexOf('private class WsInputStream', start);
  assert.ok(start >= 0 && end > start, 'Benchmark must use exact production frame declarations');
  const harness = path.join(temporary, 'FrameThroughputHarness.kt');
  writeFileSync(harness, 'import java.io.*\nimport java.net.Socket\nimport java.security.SecureRandom\n' +
    'import com.jcraft.jsch.Session\n' + source.slice(start, end) + '\n' +
    readFileSync(path.join(__dirname, 'SshFrameThroughputTest.kt'), 'utf8').replace('import java.lang.management.ManagementFactory', ''));
  const jar = path.join(temporary, 'throughput.jar');
  let compiler = process.env.KOTLINC || 'kotlinc', args = [harness, '-classpath', process.env.SXB_JSCH_JAR, '-include-runtime', '-d', jar];
  if (process.platform === 'win32' && compiler.endsWith('.bat')) {
    const home = path.resolve(path.dirname(compiler), '..');
    args = [`-Dkotlin.home=${home}`, '-cp', path.join(home, 'lib', '*'), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', ...args];
    compiler = process.env.JAVA || 'java';
  }
  // ManagementFactory is supplied at the top, not substituted in the data path.
  const text = readFileSync(harness, 'utf8');
  writeFileSync(harness, 'import java.lang.management.ManagementFactory\n' + text);
  const built = spawnSync(compiler, args, { encoding: 'utf8', timeout: 120000 });
  assert.equal(built.status, 0, `Exact frame implementation failed to compile: ${built.stderr || ''}`);
  const result = spawnSync(process.env.JAVA || 'java', ['-Xmx256m', '-cp',
    jar + path.delimiter + process.env.SXB_JSCH_JAR, 'FrameThroughputHarnessKt'], { encoding: 'utf8', timeout: 90000 });
  assert.equal(result.status, 0, `Frame benchmark failed: ${result.stderr || ''}`);
  if (!process.argv[2]) {
    const samples = [...result.stdout.matchAll(/payload_bytes=(\d+) elapsed_ns=(\d+) allocated_bytes=(-?\d+) event_calls=(\d+)/g)];
    assert.equal(samples.length, 4, 'All exact-code frame workloads must complete');
    for (const sample of samples) {
      assert.equal(Number(sample[4]), 0, 'Steady-state frames must not flood diagnostic callbacks');
      assert.ok(Number(sample[3]) >= 0, 'The declared JVM must expose measured thread allocations');
      assert.ok(Number(sample[3]) < Number(sample[1]) / 10, 'Framing must not recreate payload-sized arrays per packet');
    }
  }
  process.stdout.write(result.stdout);
} finally { rmSync(temporary, { recursive: true, force: true }); }
