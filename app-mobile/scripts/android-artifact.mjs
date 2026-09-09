import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function archiveEntries(archive) {
  execFileSync('unzip', ['-t', archive], { maxBuffer: 32 * 1024 * 1024 });
  const names = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    .trim().split(/\r?\n/);
  assert.equal(new Set(names).size, names.length, 'Duplicate archive entries');
  for (const name of names) {
    assert.ok(/^[a-zA-Z0-9_./+@()$ -]+$/.test(name) && !name.startsWith('/')
      && !name.split('/').some(part => part === '..' || part === '.'),
    `Unsafe or unsupported archive entry: ${name}`);
  }
  return names;
}

export function archiveRead(archive, entry) {
  return execFileSync('unzip', ['-p', archive, entry], { maxBuffer: 256 * 1024 * 1024 });
}

const abiHeaders = {
  'arm64-v8a': [2, 183],
  'armeabi-v7a': [1, 40],
  x86_64: [2, 62],
  x86: [1, 3],
};

export function inspectElf(buffer, abi, name = abi) {
  assert.ok(buffer.length >= 64 && buffer.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])),
    `${name}: not an ELF binary`);
  const header = abiHeaders[abi];
  assert.ok(header, `${name}: unsupported ABI ${abi}`);
  assert.equal(buffer[4], header[0], `${name}: incorrect ELF class`);
  assert.equal(buffer[5], 1, `${name}: expected little-endian ELF`);
  assert.equal(buffer.readUInt16LE(16), 3, `${name}: expected shared library / PIE (ET_DYN)`);
  assert.equal(buffer.readUInt16LE(18), header[1], `${name}: machine does not match ABI`);
  const is64 = buffer[4] === 2;
  const integer = (offset) => {
    const value = buffer.readBigUInt64LE(offset);
    assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER), `${name}: oversized ELF integer`);
    return Number(value);
  };
  const offset = is64 ? integer(32) : buffer.readUInt32LE(28);
  const size = buffer.readUInt16LE(is64 ? 54 : 42);
  const count = buffer.readUInt16LE(is64 ? 56 : 44);
  assert.ok(size >= (is64 ? 56 : 32) && count > 0 && count < 65535
    && offset + size * count <= buffer.length, `${name}: invalid program headers`);
  const segments = [];
  for (let i = 0; i < count; i++) {
    const p = offset + i * size;
    if (buffer.readUInt32LE(p) !== 1) continue;
    const fileOffset = is64 ? integer(p + 8) : buffer.readUInt32LE(p + 4);
    const address = is64 ? integer(p + 16) : buffer.readUInt32LE(p + 8);
    const fileSize = is64 ? integer(p + 32) : buffer.readUInt32LE(p + 16);
    const memorySize = is64 ? integer(p + 40) : buffer.readUInt32LE(p + 20);
    const alignment = is64 ? integer(p + 48) : buffer.readUInt32LE(p + 28);
    assert.ok(fileOffset + fileSize <= buffer.length && memorySize >= fileSize,
      `${name}: invalid LOAD bounds`);
    assert.ok(alignment >= 1 && Number.isInteger(Math.log2(alignment)),
      `${name}: invalid LOAD alignment`);
    assert.equal(address % alignment, fileOffset % alignment, `${name}: incongruent LOAD segment`);
    if (is64) {
      assert.ok(alignment >= 16384, `${name}: LOAD p_align ${alignment} is below 16 KiB`);
      assert.equal(address % 16384, fileOffset % 16384, `${name}: not 16 KiB page congruent`);
    }
    segments.push({ offset: fileOffset, address, fileSize, memorySize, alignment });
  }
  assert.ok(segments.length > 0, `${name}: missing LOAD segments`);
  return { name, abi, sha256: createHash('sha256').update(buffer).digest('hex'), segments };
}

export function inspectNativeArchive(archive, prefix, requiredLibraries) {
  const names = archiveEntries(archive);
  const libraries = names.filter(name => name.startsWith(`${prefix}/`) && name.endsWith('.so'));
  assert.ok(libraries.length > 0, 'No packaged native libraries');
  const abis = [...new Set(libraries.map(name => name.split('/').at(-2)))].sort();
  for (const abi of ['arm64-v8a', 'armeabi-v7a']) assert.ok(abis.includes(abi), `Missing ABI ${abi}`);
  for (const abi of abis) {
    for (const library of requiredLibraries) {
      assert.ok(libraries.includes(`${prefix}/${abi}/${library}`), `Missing ${abi}/${library}`);
    }
  }
  return libraries.map(name => inspectElf(archiveRead(archive, name), name.split('/').at(-2), name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [archive, prefix = 'jni'] = process.argv.slice(2);
  assert.ok(archive, 'Usage: node android-artifact.mjs archive.aar [jni]');
  const report = inspectNativeArchive(archive, prefix, ['libbox.so']);
  console.log(JSON.stringify(report, null, 2));
}
