const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
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
  const moduleSource = readFileSync(native('SxbVpnModule.kt'), 'utf8');
  const receiverMethods = ['registerReceivers', 'unregisterReceivers'].map(name => {
    const match = moduleSource.match(new RegExp(`^    private fun ${name}\\([\\s\\S]*?^    }`, 'm'));
    assert.ok(match, `Production receiver method missing: ${name}`);
    return match[0];
  });
  const lifecycleMethods = ['initialize', 'invalidate', 'setUsageReportingEnabled'].map(name => {
    const match = moduleSource.match(new RegExp(`^    (?:override )?fun ${name}\\([^\\n]+`, 'm'));
    assert.ok(match, `Production lifecycle method missing: ${name}`);
    return match[0];
  });
  const receiverFields = moduleSource.slice(moduleSource.indexOf('    private var statusReceiver'),
    moduleSource.indexOf('    private val accessExecutor'));
  assert.ok(receiverFields.includes('usageReportingEnabled') && receiverFields.includes('usageTaskId'));
  const receiverHarness = path.join(build, 'UsageReceiverHarness.kt');
  writeFileSync(receiverHarness, `package com.sxbvpn.usagefixture
class UsageReceiverHarness(val reactApplicationContext: Context) : Lifecycle() {
${receiverFields}
    val accessExecutor = Executor()
    val events = mutableListOf<String>()
    private fun sendEvent(name: String, params: WritableMap?) { events.add(name) }
${lifecycleMethods.join('\n')}
${receiverMethods.join('\n')}
}
`);
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
    path.join(__dirname, 'NativeUsageReportingTest.kt'),
    receiverHarness,
    '-classpath', coroutines, '-include-runtime', '-d', jar,
  ]);
  run(java, ['-cp', `${jar}${path.delimiter}${coroutines}`, 'com.sxbvpn.vpnmodule.NativeRecoveryTestKt']);
  run(java, ['-cp', `${jar}${path.delimiter}${coroutines}`, 'com.sxbvpn.vpnmodule.NativeUsageTestKt']);
  run(java, ['-cp', `${jar}${path.delimiter}${coroutines}`, 'com.sxbvpn.usagefixture.NativeUsageReportingTestKt']);
} finally {
  rmSync(build, { recursive: true, force: true });
}
