#!/usr/bin/env node
'use strict';

/**
 * Antigravity 2.0 Telemetry Bar & Token Activity Heatmap Patcher
 *
 * Supports patching or restoring either:
 *   1) An extracted app.asar directory:
 *        npx @electron/asar extract "<Antigravity>/resources/app.asar" app-extracted
 *        node src/patch-asar.js app-extracted [--restore]
 *        npx @electron/asar pack app-extracted "<Antigravity>/resources/app.asar"
 *   2) An app.asar archive directly in-place:
 *        node src/patch-asar.js "<Antigravity>/resources/app.asar" [--restore] [--force]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const DEFAULT_BLOCK_SIZE = 4 * 1024 * 1024;
const ELECTRON_FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

function loadBlock(fileName) {
  const fullPath = path.join(__dirname, fileName);
  if (!fs.existsSync(fullPath)) {
    throw new Error('Missing required patch asset: ' + fullPath);
  }
  return stripBom(fs.readFileSync(fullPath, 'utf8')).replace(/\r\n/g, '\n').trimEnd();
}

function splitTrailingSourceMap(code) {
  const m = code.match(/(?:^|\r?\n)([ \t]*\/\/[#@]\s*sourceMappingURL=[^\r\n]*\s*)$/);
  if (!m) {
    return { prefix: code.replace(/\s+$/, ''), sourceMapTail: '' };
  }
  return {
    prefix: code.slice(0, m.index).replace(/\s+$/, ''),
    sourceMapTail: m[1].trim(),
  };
}

function stripIpcPatch(code) {
  let out = stripBom(code);
  out = out.replace(
    /[ \t]*\/\/\s*===\s*TELEMETRY_MOD_IPC_START\s*===[\s\S]*?(?:\/\/\s*===\s*TELEMETRY_MOD_IPC_END\s*===[ \t]*(?:\r?\n)?)+/g,
    ''
  );
  out = out.replace(/^[ \t]*\/\/\s*===\s*TELEMETRY_MOD_IPC_(?:START|END)\s*===[ \t]*\r?\n?/gm, '');
  return out;
}

function stripPreloadPatch(code) {
  let out = stripBom(code);
  out = out.replace(
    /[ \t]*\/\/\s*===\s*TELEMETRY_MOD_PRELOAD_START\s*===[\s\S]*?(?:\/\/\s*===\s*TELEMETRY_MOD_PRELOAD_END\s*===[ \t]*(?:\r?\n)?)+/g,
    ''
  );
  out = out.replace(/^[ \t]*\/\/\s*===\s*TELEMETRY_MOD_PRELOAD_(?:START|END)\s*===[ \t]*\r?\n?/gm, '');

  const legacyMatch = out.match(/^[ \t]*function installTelemetryBar\s*\(\)/m);
  if (legacyMatch) {
    const tail = out.slice(legacyMatch.index);
    const sm = tail.match(/(\r?\n[ \t]*\/\/[#@]\s*sourceMappingURL=[^\r\n]*\s*)$/);
    const before = out.slice(0, legacyMatch.index).replace(/\s+$/, '');
    out = sm ? (before ? before + '\n' : '') + sm[1].trim() + '\n' : (before ? before + '\n' : '');
  }
  return out;
}

function ensureWrappedIpcBlock(ipcBlock) {
  const trimmed = String(ipcBlock || '').replace(/\r\n/g, '\n').trim();
  const hasMarkers = trimmed.includes('TELEMETRY_MOD_IPC_START') && trimmed.includes('TELEMETRY_MOD_IPC_END');
  if (!hasMarkers) {
    return '// === TELEMETRY_MOD_IPC_START ===\n{\n' + trimmed + '\n}\n// === TELEMETRY_MOD_IPC_END ===';
  }
  const inner = trimmed
    .replace(/^\s*\/\/\s*===\s*TELEMETRY_MOD_IPC_START\s*===\s*\n?/, '')
    .replace(/\n?\s*\/\/\s*===\s*TELEMETRY_MOD_IPC_END\s*===\s*$/, '')
    .trim();
  if (inner.startsWith('{') && inner.endsWith('}')) {
    return trimmed;
  }
  return '// === TELEMETRY_MOD_IPC_START ===\n{\n' + inner + '\n}\n// === TELEMETRY_MOD_IPC_END ===';
}

function applyIpcPatch(rawCode, ipcBlock) {
  let code = stripIpcPatch(rawCode);
  const block = ensureWrappedIpcBlock(ipcBlock);

  const wcvRe = /(?:^|\r?\n)([ \t]*(?:\(0,\s*[\w$]+\.registerWcvIpcHandlers\)|[\w$.]*registerWcvIpcHandlers)\s*\()/g;
  let match;
  let lastMatch = null;
  while ((match = wcvRe.exec(code)) !== null) {
    lastMatch = match;
  }

  if (lastMatch) {
    const prefixNewline = lastMatch[0].startsWith('\r\n') ? 2 : (lastMatch[0].startsWith('\n') ? 1 : 0);
    const lineStart = lastMatch.index + prefixNewline;
    code = code.slice(0, lineStart) + block + '\n' + code.slice(lineStart);
  } else {
    const { prefix, sourceMapTail } = splitTrailingSourceMap(code);
    code = (prefix ? prefix + '\n' : '') + block + '\n' + (sourceMapTail ? sourceMapTail + '\n' : '');
  }

  new vm.Script(code, { filename: 'dist/ipcHandlers.js' });
  return code;
}

function applyPreloadPatch(rawCode, preloadBlock) {
  let code = stripPreloadPatch(rawCode);
  const block = String(preloadBlock || '').replace(/\r\n/g, '\n').trim();
  const { prefix, sourceMapTail } = splitTrailingSourceMap(code);
  code = (prefix ? prefix + '\n' : '') + block + '\n' + (sourceMapTail ? sourceMapTail + '\n' : '');

  new vm.Script(code, { filename: 'dist/preload.js' });
  return code;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function computeAsarIntegrity(buf, blockSize) {
  const bs = Number(blockSize) > 0 ? Number(blockSize) : DEFAULT_BLOCK_SIZE;
  const blocks = [];
  if (buf.length === 0) {
    blocks.push(sha256Hex(buf));
  } else {
    for (let pos = 0; pos < buf.length; pos += bs) {
      const end = Math.min(buf.length, pos + bs);
      blocks.push(sha256Hex(buf.subarray(pos, end)));
    }
  }
  return {
    algorithm: 'SHA256',
    hash: sha256Hex(buf),
    blockSize: bs,
    blocks,
  };
}

function readAsarArchive(asarPath) {
  const bytes = readFileWithRetry(asarPath);
  if (bytes.length < 16) {
    throw new Error('Invalid or truncated ASAR file: ' + asarPath);
  }
  const u0 = bytes.readUInt32LE(0);
  const u1 = bytes.readUInt32LE(4);
  const u2 = bytes.readUInt32LE(8);
  const u3 = bytes.readUInt32LE(12);
  const dataOffset = 8 + u1;
  if (u0 !== 4 || dataOffset > bytes.length || 16 + u3 > dataOffset) {
    throw new Error(`Invalid ASAR Pickle header (u0=${u0}, u1=${u1}, u2=${u2}, u3=${u3})`);
  }
  const jsonStr = stripBom(bytes.subarray(16, 16 + u3).toString('utf8'));
  const hdr = JSON.parse(jsonStr);
  if (!hdr || typeof hdr !== 'object' || !hdr.files || typeof hdr.files !== 'object') {
    throw new Error('Invalid ASAR JSON header structure');
  }
  return { bytes, dataOffset, jsonStr, hdr };
}

function getAsarEntry(hdr, relPath) {
  const parts = relPath.split('/').filter(Boolean);
  let cur = hdr;
  for (let i = 0; i < parts.length; i++) {
    if (!cur || !cur.files || typeof cur.files !== 'object') return null;
    cur = cur.files[parts[i]];
  }
  return cur || null;
}

function shiftAsarOffsets(dirNode, afterOffset, delta) {
  if (!dirNode || !dirNode.files || typeof dirNode.files !== 'object') return;
  for (const key of Object.keys(dirNode.files)) {
    const entry = dirNode.files[key];
    if (!entry || typeof entry !== 'object') continue;
    if (entry.files && typeof entry.files === 'object') {
      shiftAsarOffsets(entry, afterOffset, delta);
    } else if (!entry.unpacked && entry.offset !== undefined && entry.offset !== null) {
      const off = Number(entry.offset);
      if (!Number.isSafeInteger(off) || off < 0) {
        throw new Error('Invalid ASAR entry offset for ' + key + ': ' + entry.offset);
      }
      if (off > afterOffset) {
        entry.offset = String(off + delta);
      }
    }
  }
}

function verifyAsarHeaderAndData(jsonStr, dataBuf, targets) {
  const parsed = JSON.parse(jsonStr);
  if (!parsed || !parsed.files || typeof parsed.files !== 'object') {
    throw new Error('ASAR verification failed: invalid root header');
  }

  function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files)) {
      const full = prefix ? prefix + '/' + name : name;
      if (!entry || typeof entry !== 'object') {
        throw new Error('ASAR verification failed: invalid entry at ' + full);
      }
      if (entry.files && typeof entry.files === 'object') {
        walk(entry, full);
        continue;
      }
      if (entry.unpacked === true || entry.link !== undefined) {
        continue;
      }
      if (entry.offset === undefined || entry.offset === null || entry.size === undefined || entry.size === null) {
        throw new Error('ASAR verification failed: missing offset/size at ' + full);
      }
      const off = Number(entry.offset);
      const sz = Number(entry.size);
      if (!Number.isSafeInteger(off) || off < 0 || !Number.isSafeInteger(sz) || sz < 0 || off + sz > dataBuf.length) {
        throw new Error(`ASAR verification failed: out-of-bounds offset/size at ${full} (offset=${off}, size=${sz}, dataLen=${dataBuf.length})`);
      }
    }
  }
  walk(parsed, '');

  for (const t of targets) {
    const entry = getAsarEntry(parsed, t.relPath);
    if (!entry) {
      throw new Error('ASAR verification failed: missing target entry ' + t.relPath);
    }
    const off = Number(entry.offset);
    const sz = Number(entry.size);
    if (sz !== t.newBytes.length) {
      throw new Error(`ASAR verification failed: size mismatch for ${t.relPath} (${sz} !== ${t.newBytes.length})`);
    }
    const slice = dataBuf.subarray(off, off + sz);
    if (!slice.equals(t.newBytes)) {
      throw new Error('ASAR verification failed: payload mismatch for ' + t.relPath);
    }
    if (entry.integrity && typeof entry.integrity === 'object') {
      const expected = computeAsarIntegrity(slice, entry.integrity.blockSize);
      if (entry.integrity.hash !== expected.hash) {
        throw new Error('ASAR verification failed: integrity hash mismatch for ' + t.relPath);
      }
      if (!Array.isArray(entry.integrity.blocks) ||
          entry.integrity.blocks.length !== expected.blocks.length ||
          entry.integrity.blocks.some((b, i) => b !== expected.blocks[i])) {
        throw new Error('ASAR verification failed: integrity blocks mismatch for ' + t.relPath);
      }
    }
  }
}

function buildAsarBuffer(hdr, dataBuf) {
  const newJsonStr = JSON.stringify(hdr);
  const newJsonBytes = Buffer.from(newJsonStr, 'utf8');
  const alignedJsonLen = Math.ceil(newJsonBytes.length / 4) * 4;
  const paddingLen = alignedJsonLen - newJsonBytes.length;

  const headerBuf = Buffer.alloc(16 + alignedJsonLen);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(8 + alignedJsonLen, 4);
  headerBuf.writeUInt32LE(4 + alignedJsonLen, 8);
  headerBuf.writeUInt32LE(newJsonBytes.length, 12);
  newJsonBytes.copy(headerBuf, 16);

  return {
    jsonStr: newJsonStr,
    buffer: Buffer.concat([headerBuf, dataBuf]),
  };
}

function checkElectronAsarFuse(exePath) {
  if (!exePath || !fs.existsSync(exePath)) {
    return { found: false, asarIntegrityEnabled: false };
  }
  const chunkSize = 4 * 1024 * 1024;
  const overlap = 128;
  const stat = fs.statSync(exePath);
  const fd = fs.openSync(exePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.min(stat.size, chunkSize + overlap));
    let filePos = 0;
    let carryLen = 0;
    while (filePos < stat.size) {
      const toRead = Math.min(chunkSize, stat.size - filePos, buf.length - carryLen);
      if (toRead <= 0) break;
      const bytesRead = fs.readSync(fd, buf, carryLen, toRead, filePos);
      if (bytesRead <= 0) break;
      filePos += bytesRead;
      const total = carryLen + bytesRead;

      let searchFrom = 0;
      while (searchFrom <= total - ELECTRON_FUSE_SENTINEL.length - 6) {
        const idx = buf.indexOf(ELECTRON_FUSE_SENTINEL, searchFrom);
        if (idx === -1) break;
        const verPos = idx + ELECTRON_FUSE_SENTINEL.length;
        if (verPos + 2 < total) {
          const version = buf[verPos];
          const count = buf[verPos + 1];
          if (version >= 1 && version <= 5 && count >= 5 && count <= 32 && verPos + 2 + count <= total) {
            const flagsSlice = buf.subarray(verPos + 2, verPos + 2 + count);
            const flagsStr = flagsSlice.toString('ascii');
            if (/^[01]+$/.test(flagsStr)) {
              return {
                found: true,
                version,
                count,
                flags: flagsStr,
                asarIntegrityEnabled: flagsStr[4] === '1',
              };
            }
          }
        }
        searchFrom = idx + 1;
      }

      if (filePos < stat.size) {
        const keep = Math.min(overlap, total);
        buf.copy(buf, 0, total - keep, total);
        carryLen = keep;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { found: false, asarIntegrityEnabled: false };
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function readFileWithRetry(filePath, encoding) {
  const maxRetries = 15;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return encoding ? fs.readFileSync(filePath, encoding) : fs.readFileSync(filePath);
    } catch (err) {
      const transient = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
      if (!transient || attempt === maxRetries) {
        throw err;
      }
      sleepSync(500);
    }
  }
}

function writeAtomic(targetPath, data) {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, data);
  const maxRetries = 15;
  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        fs.renameSync(tmpPath, targetPath);
        return;
      } catch (err) {
        const transient = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
        if (!transient || attempt === maxRetries) {
          if (transient) {
            fs.copyFileSync(tmpPath, targetPath);
            return;
          }
          throw err;
        }
        sleepSync(500);
      }
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

function patchExtractedDir(extractDir, opts) {
  const ipcPath = path.join(extractDir, 'dist', 'ipcHandlers.js');
  const preloadPath = path.join(extractDir, 'dist', 'preload.js');
  if (!fs.existsSync(ipcPath) || !fs.existsSync(preloadPath)) {
    throw new Error('Missing dist/ipcHandlers.js or dist/preload.js inside: ' + extractDir);
  }

  const rawIpc = readFileWithRetry(ipcPath, 'utf8');
  const rawPre = readFileWithRetry(preloadPath, 'utf8');

  if (opts.restore) {
    const cleanIpc = stripIpcPatch(rawIpc);
    const cleanPre = stripPreloadPatch(rawPre);
    new vm.Script(cleanIpc, { filename: 'dist/ipcHandlers.js' });
    new vm.Script(cleanPre, { filename: 'dist/preload.js' });
    writeAtomic(ipcPath, Buffer.from(cleanIpc, 'utf8'));
    writeAtomic(preloadPath, Buffer.from(cleanPre, 'utf8'));
    console.log('[OK] Restored dist/ipcHandlers.js and dist/preload.js');
    return;
  }

  const ipcBlock = loadBlock('ipc-block.js');
  const preloadBlock = [
    loadBlock('preload-part1.js'),
    loadBlock('preload-part2.js'),
    loadBlock('preload-part3.js'),
  ].join('\n');

  const nextIpc = applyIpcPatch(rawIpc, ipcBlock);
  const nextPre = applyPreloadPatch(rawPre, preloadBlock);

  writeAtomic(ipcPath, Buffer.from(nextIpc, 'utf8'));
  writeAtomic(preloadPath, Buffer.from(nextPre, 'utf8'));
  console.log('[OK] Patched dist/ipcHandlers.js');
  console.log('[OK] Patched dist/preload.js');
}

function patchAsarArchive(asarPath, opts) {
  const resourcesDir = path.dirname(asarPath);
  const exePath = path.join(path.dirname(resourcesDir), 'Antigravity.exe');
  const bakPath = asarPath + '.bak';

  if (!opts.restore && !opts.force) {
    const fuseState = checkElectronAsarFuse(exePath);
    if (fuseState.found && fuseState.asarIntegrityEnabled) {
      throw new Error(
        'Detected EnableEmbeddedAsarIntegrityValidation (Electron fuse[4]=1) in Antigravity.exe. ' +
        'Modifying app.asar will prevent Antigravity from starting. Pass --force to override at your own risk.'
      );
    }
  }

  if (opts.restore && fs.existsSync(bakPath)) {
    const bakInfo = readAsarArchive(bakPath);
    writeAtomic(asarPath, bakInfo.bytes);
    console.log('[OK] Restored app.asar from backup:', bakPath);
    return;
  }

  const info = readAsarArchive(asarPath);
  const ipcEntry = getAsarEntry(info.hdr, 'dist/ipcHandlers.js');
  const preEntry = getAsarEntry(info.hdr, 'dist/preload.js');
  if (!ipcEntry || !preEntry) {
    throw new Error('Target app.asar missing dist/ipcHandlers.js or dist/preload.js');
  }
  if (ipcEntry.unpacked || preEntry.unpacked || ipcEntry.offset === undefined || preEntry.offset === undefined) {
    throw new Error('Target dist/ipcHandlers.js or dist/preload.js is unpacked or missing offset');
  }

  const ipcOff = Number(ipcEntry.offset);
  const ipcSize = Number(ipcEntry.size);
  const preOff = Number(preEntry.offset);
  const preSize = Number(preEntry.size);
  if (info.dataOffset + ipcOff + ipcSize > info.bytes.length || info.dataOffset + preOff + preSize > info.bytes.length) {
    throw new Error('Target ASAR entry offsets exceed file length');
  }

  const rawIpc = info.bytes.subarray(info.dataOffset + ipcOff, info.dataOffset + ipcOff + ipcSize).toString('utf8');
  const rawPre = info.bytes.subarray(info.dataOffset + preOff, info.dataOffset + preOff + preSize).toString('utf8');

  const alreadyPatched =
    rawIpc.includes('TELEMETRY_MOD_IPC_START') ||
    rawPre.includes('TELEMETRY_MOD_PRELOAD_START') ||
    rawPre.includes('function installTelemetryBar()');

  if (opts.restore && !alreadyPatched) {
    console.log('[SKIP] Target app.asar does not contain telemetry patch; nothing to restore:', asarPath);
    return;
  }

  if (!opts.restore && !alreadyPatched) {
    writeAtomic(bakPath, info.bytes);
    console.log('[OK] Backed up clean app.asar to:', bakPath);
  }

  let nextIpc;
  let nextPre;
  if (opts.restore) {
    nextIpc = stripIpcPatch(rawIpc);
    nextPre = stripPreloadPatch(rawPre);
    new vm.Script(nextIpc, { filename: 'dist/ipcHandlers.js' });
    new vm.Script(nextPre, { filename: 'dist/preload.js' });
  } else {
    const ipcBlock = loadBlock('ipc-block.js');
    const preloadBlock = [
      loadBlock('preload-part1.js'),
      loadBlock('preload-part2.js'),
      loadBlock('preload-part3.js'),
    ].join('\n');
    nextIpc = applyIpcPatch(rawIpc, ipcBlock);
    nextPre = applyPreloadPatch(rawPre, preloadBlock);
  }

  const targets = [
    { relPath: 'dist/ipcHandlers.js', oldOff: ipcOff, oldSize: ipcSize, newBytes: Buffer.from(nextIpc, 'utf8') },
    { relPath: 'dist/preload.js', oldOff: preOff, oldSize: preSize, newBytes: Buffer.from(nextPre, 'utf8') },
  ].sort((a, b) => b.oldOff - a.oldOff);

  let curData = Buffer.from(info.bytes.subarray(info.dataOffset));
  for (const t of targets) {
    const entry = getAsarEntry(info.hdr, t.relPath);
    const delta = t.newBytes.length - t.oldSize;
    if (delta !== 0) {
      shiftAsarOffsets(info.hdr, t.oldOff, delta);
    }
    entry.size = t.newBytes.length;
    if (entry.integrity && typeof entry.integrity === 'object') {
      entry.integrity = computeAsarIntegrity(t.newBytes, entry.integrity.blockSize);
    }

    const head = curData.subarray(0, t.oldOff);
    const tail = curData.subarray(t.oldOff + t.oldSize);
    curData = Buffer.concat([head, t.newBytes, tail]);
  }

  const built = buildAsarBuffer(info.hdr, curData);
  verifyAsarHeaderAndData(built.jsonStr, curData, targets);
  writeAtomic(asarPath, built.buffer);
  console.log(`[OK] ${opts.restore ? 'Restored' : 'Patched'} ASAR archive:`, asarPath);
}

function resolveTarget(argv) {
  let targetArg = '';
  let restore = false;
  let force = process.env.ANTIGRAVITY_IGNORE_FUSE_CHECK === '1';

  for (const arg of argv) {
    if (arg === '--restore' || arg === '-r') restore = true;
    else if (arg === '--force' || arg === '-f') force = true;
    else if (!arg.startsWith('-') && !targetArg) targetArg = arg;
  }

  if (targetArg) {
    return { targetPath: path.resolve(targetArg), restore, force };
  }

  const candidates = [
    path.resolve(process.cwd(), 'app-extracted'),
    path.resolve(process.cwd(), 'extracted'),
    path.resolve(__dirname, '..', 'app-extracted'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'dist', 'ipcHandlers.js'))) {
      return { targetPath: dir, restore, force };
    }
  }
  return { targetPath: '', restore, force };
}

function main() {
  const opts = resolveTarget(process.argv.slice(2));
  if (!opts.targetPath || !fs.existsSync(opts.targetPath)) {
    console.error('Usage: node src/patch-asar.js <extracted-app-asar-dir | path/to/app.asar> [--restore] [--force]');
    process.exit(1);
  }

  const stat = fs.statSync(opts.targetPath);
  if (stat.isFile() && opts.targetPath.toLowerCase().endsWith('.asar')) {
    patchAsarArchive(opts.targetPath, opts);
  } else if (stat.isDirectory()) {
    patchExtractedDir(opts.targetPath, opts);
  } else {
    console.error('Unsupported target path (expected extracted directory or .asar file):', opts.targetPath);
    process.exit(1);
  }
  console.log('[DONE] All operations completed cleanly.');
}

if (require.main === module) {
  main();
}

module.exports = {
  stripIpcPatch,
  stripPreloadPatch,
  applyIpcPatch,
  applyPreloadPatch,
  computeAsarIntegrity,
  readAsarArchive,
  shiftAsarOffsets,
  verifyAsarHeaderAndData,
  buildAsarBuffer,
  checkElectronAsarFuse,
  patchExtractedDir,
  patchAsarArchive,
};
