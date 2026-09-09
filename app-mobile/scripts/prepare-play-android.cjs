const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseVersionCode } = require('./android-version.cjs');

function configureGradle(source, versionCode) {
  assert.match(source, /android\s*\{/);
  assert.equal(Number(source.match(/\bversionCode\s+(\d+)/)?.[1]), versionCode,
    'Native versionCode must match Expo config generated before prebuild');
  assert.ok(!source.includes('// SXB Play release'), 'Play release already configured');
  // Append the override after the generated Expo blocks: the template's debug
  // signing assignment must never win. Passwords are read at build time only.
  return `${source}

// SXB Play release
def sxbSecret = { name ->
    def value = System.getenv(name)
    if (value == null || value.isEmpty()) throw new GradleException("Missing release credential: " + name)
    return value
}
def sxbAgp = com.android.Version.ANDROID_GRADLE_PLUGIN_VERSION
def sxbAgpParts = sxbAgp.tokenize('.').take(3).collect { it.toInteger() }
if (sxbAgpParts[0] < 8 || (sxbAgpParts[0] == 8 &&
    (sxbAgpParts[1] < 5 || (sxbAgpParts[1] == 5 && sxbAgpParts[2] < 1)))) {
    throw new GradleException("Google Play requires AGP >= 8.5.1; found " + sxbAgp)
}
android {
    ndkVersion "27.1.12297006"
    defaultConfig {
        ndk { abiFilters "arm64-v8a", "armeabi-v7a" }
    }
    signingConfigs {
        create("sxbPlayRelease") {
            storeFile file(sxbSecret("SXB_KEYSTORE_PATH"))
            storePassword sxbSecret("KEYSTORE_PASSWORD")
            keyAlias sxbSecret("KEY_ALIAS")
            keyPassword sxbSecret("KEY_PASSWORD")
        }
    }
    buildTypes.release.signingConfig = signingConfigs.sxbPlayRelease
}
tasks.register("sxbVerifyPlayToolchain") {
    doLast {
        if (android.compileSdkVersion != "android-36" ||
            android.defaultConfig.targetSdkVersion.apiLevel != 36 ||
            android.defaultConfig.minSdkVersion.apiLevel != 24) {
            throw new GradleException("Unexpected Android SDK configuration")
        }
        if (android.buildTypes.release.signingConfig.name != "sxbPlayRelease") {
            throw new GradleException("Release signing was overridden")
        }
        println("SXB toolchain: AGP=" + sxbAgp + " NDK=" + android.ndkVersion +
            " compile=36 target=36 min=24")
    }
}
`;
}

module.exports = { configureGradle };

if (require.main === module) {
  assert.equal(process.env.EXPO_PUBLIC_DISTRIBUTION, 'play');
  const root = path.resolve(__dirname, '..');
  const file = path.join(root, 'android', 'app', 'build.gradle');
  const code = parseVersionCode(process.env.SXB_ANDROID_VERSION_CODE);
  fs.writeFileSync(file, configureGradle(fs.readFileSync(file, 'utf8'), code));
  const main = path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'sxbvpn', 'mobile', 'MainApplication.kt');
  assert.match(fs.readFileSync(main, 'utf8'), /add\(SxbVpnPackage\(\)\)|packages\.add\(SxbVpnPackage\(\)\)/,
    'Native VPN package not registered');
  const properties = path.join(root, 'android', 'gradle.properties');
  let contents = fs.readFileSync(properties, 'utf8');
  for (const [key, value] of Object.entries({
    'org.gradle.jvmargs': '-Xmx4096m -XX:MaxMetaspaceSize=1024m',
    'org.gradle.daemon': 'false',
    'android.enableJetifier': 'true',
    'android.enableR8.fullMode': 'false',
  })) {
    contents = contents.split('\n').filter(line => !line.startsWith(`${key}=`)).join('\n');
    contents += `\n${key}=${value}\n`;
  }
  fs.writeFileSync(properties, contents);
}
