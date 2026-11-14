#!/usr/bin/env node
'use strict';

/**
 * Antigravity 2.0 Telemetry Bar & Token Activity Heatmap Patcher
 *
 * Patches an unpacked app.asar directory using modular files in src/:
 *   - ipc-block.js
 *   - preload-part1.js .. preload-part3.js
 *
 * Usage:
 *   npx @electron/asar extract "<Antigravity>/resources/app.asar" app-extracted
 *   node src/patch-asar.js app-extracted
 *   npx @electron/asar pack app-extracted "<Antigravity>/resources/app.asar"
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadBlock(fileName) {
  const fullPath = path.join(__dirname, fileName);
  if (!fs.existsSync(fullPath)) {
    throw new Error('Missing required patch asset: ' + fullPath);
  }
  return fs.readFileSync(fullPath, 'utf8').replace(/\r\n/g, '\n').trimEnd();
}

function resolveExtractDir() {
  const cliArg = process.argv[2];
  if (cliArg && !cliArg.startsWith('-')) {
    return path.resolve(cliArg);
  }
  const candidates = [
    path.resolve(process.cwd(), 'app-extracted'),
    path.resolve(process.cwd(), 'extracted'),
    path.resolve(__dirname, '..', 'app-extracted'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'dist', 'ipcHandlers.js'))) {
      return dir;
    }
  }
  return '';
}

function patchIpcHandlers(ipcPath, ipcBlock) {
  let code = fs.readFileSync(ipcPath, 'utf8');
  code = code.replace(/\s*\/\/ === TELEMETRY_MOD_IPC_START ===[\s\S]*?\/\/ === TELEMETRY_MOD_IPC_END ===\r?\n?/g, '\n');

  const wcvAnchor = '    (0, wcvIpcHandlers_1.registerWcvIpcHandlers)';
  const anchorIdx = code.lastIndexOf(wcvAnchor);
  if (anchorIdx !== -1) {
    code = code.slice(0, anchorIdx) + '\n' + ipcBlock + '\n' + code.slice(anchorIdx);
  } else {
    const lastBrace = code.lastIndexOf('}');
    if (lastBrace === -1) {
      throw new Error('Could not find insertion point in dist/ipcHandlers.js');
    }
    code = code.slice(0, lastBrace) + '\n' + ipcBlock + '\n}\n';
  }

  new vm.Script(code, { filename: 'dist/ipcHandlers.js' });
  fs.writeFileSync(ipcPath, code, 'utf8');
  console.log('[OK] Patched dist/ipcHandlers.js');
}

function patchPreload(preloadPath, preloadBlock) {
  let code = fs.readFileSync(preloadPath, 'utf8');
  code = code.replace(/\s*\/\/ === TELEMETRY_MOD_PRELOAD_START ===[\s\S]*?(?:\/\/\s*=== TELEMETRY_MOD_PRELOAD_END ===\s*)+/g, '\n');

  const fnIdx = code.indexOf('function installTelemetryBar()');
  if (fnIdx !== -1) {
    code = code.slice(0, fnIdx).trimEnd();
  }

  code = code.trimEnd() + '\n' + preloadBlock + '\n';
  new vm.Script(code, { filename: 'dist/preload.js' });
  fs.writeFileSync(preloadPath, code, 'utf8');
  console.log('[OK] Patched dist/preload.js');
}

function main() {
  const extractDir = resolveExtractDir();
  if (!extractDir || !fs.existsSync(extractDir)) {
    console.error('Usage: node src/patch-asar.js <extracted-app-asar-dir>');
    process.exit(1);
  }

  const ipcPath = path.join(extractDir, 'dist', 'ipcHandlers.js');
  const preloadPath = path.join(extractDir, 'dist', 'preload.js');
  if (!fs.existsSync(ipcPath) || !fs.existsSync(preloadPath)) {
    console.error('Missing dist/ipcHandlers.js or dist/preload.js inside:', extractDir);
    process.exit(1);
  }

  const ipcBlock = loadBlock('ipc-block.js');
  const preloadBlock = [
    loadBlock('preload-part1.js'),
    loadBlock('preload-part2.js'),
    loadBlock('preload-part3.js'),
  ].join('\n');

  patchIpcHandlers(ipcPath, ipcBlock);
  patchPreload(preloadPath, preloadBlock);
  console.log('[DONE] All patches applied cleanly.');
}

main();
