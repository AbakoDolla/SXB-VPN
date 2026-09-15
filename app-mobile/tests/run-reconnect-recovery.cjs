const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readdirSync, rmSync } = require('node:fs');
const path = require('node:path');

const kotlinc = process.env.KOTLINC;
assert.ok(kotlinc && existsSync(kotlinc),
  'Set KOTLINC to an existing Kotlin 2.1.20 compiler; this gate never downloads toolchains');
const coroutines = process.env.SXB_COROUTINES_JAR
  || path.resolve(path.dirname(kotlinc), '..', 'lib', 'kotlinx-coroutines-core-jvm.jar');
assert.ok(existsSync(coroutines),
  'Use the coroutines JVM jar bundled with Kotlin, or set SXB_COROUTINES_JAR');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}

const java = process.env.JAVA || 'java';
run(java, ['-version']);
const build = path.relative(process.cwd(), path.join(__dirname, `.native-recovery-build-${process.pid}`));
mkdirSync(build);
try {
  const jar = path.join(build, 'native-recovery.jar');
  const native = name => path.resolve(__dirname, '..', 'modules', 'android-native', name);
  run(kotlinc, [
    native('SxbReconnectPolicy.kt'),
    native('AutoReconnectManager.kt'),
    native('SxbSshKeepAlive.kt'),
    native('SxbUsageOdometer.kt'),
    native('SxbUsageCheckpoint.kt'),
    native('TrafficStatsManager.kt'),
    path.join(__dirname, 'native-recovery', 'SxbSecureLogger.kt'),
    ...readdirSync(path.join(__dirname, 'native-usage')).filter(name => name.endsWith('.kt'))
      .map(name => path.join(__dirname, 'native-usage', name)),
    path.join(__dirname, 'NativeRecoveryTest.kt'),
    path.join(__dirname, 'NativeUsageTest.kt'),
    '-classpath', coroutines, '-include-runtime', '-d', jar,
  ]);
  run(java, ['-cp', `${jar}${path.delimiter}${coroutines}`, 'com.sxbvpn.vpnmodule.NativeRecoveryTestKt']);
  run(java, ['-cp', `${jar}${path.delimiter}${coroutines}`, 'com.sxbvpn.vpnmodule.NativeUsageTestKt']);
} finally {
  rmSync(build, { recursive: true, force: true });
}
