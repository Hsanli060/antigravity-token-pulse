#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const patchAsar = require(path.join(SRC_DIR, 'patch-asar.js'));

function readSrc(name) {
  return fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDirSafe(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function loadIpcBlockSandbox({ homeDir, envOverrides, execFileImpl, spawnImpl, shellOpenImpl }) {
  const handlers = new Map();
  const fakeIpcMain = {
    removeHandler(ch) {
      handlers.delete(ch);
    },
    handle(ch, fn) {
      handlers.set(ch, fn);
    },
  };
  const fakeElectron = {
    ipcMain: fakeIpcMain,
    shell: {
      openExternal: shellOpenImpl || (async () => {}),
    },
  };
  const fakeOs = {
    ...os,
    homedir: () => homeDir,
  };
  const fakeChildProcess = {
    execFile: execFileImpl,
    spawn: spawnImpl,
  };
  const fakeProcess = {
    ...process,
    env: {
      ...process.env,
      ...envOverrides,
    },
  };
  const sandboxRequire = (modName) => {
    if (modName === 'electron') return fakeElectron;
    if (modName === 'os') return fakeOs;
    if (modName === 'child_process') return fakeChildProcess;
    return require(modName);
  };
  const ipcCode = readSrc('ipc-block.js');
  const context = vm.createContext({
    require: sandboxRequire,
    process: fakeProcess,
    Buffer,
    URL,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Array,
    Object,
    Number,
    String,
    Boolean,
    RegExp,
    Error,
  });
  new vm.Script(ipcCode, { filename: 'src/ipc-block.js' }).runInContext(context);
  return handlers;
}

const TRUSTED_EVENT = {
  senderFrame: {
    url: 'http://127.0.0.1:41234/index.html',
    parent: null,
  },
};

const SAMPLE_LIST_PAYLOAD = {
  schema_version: 1,
  current_target: 'app',
  accounts: [
    {
      id: 'acct_main_01',
      email: 'alpha@example.com',
      name: 'Alpha User',
      custom_label: 'Main Pro',
      disabled: false,
      validation_blocked: false,
      last_used: 1763500000,
      is_current: true,
      // Decoy credential fields that must never pass allowlist sanitization
      token: { access_token: 'SECRET_ACCESS', refresh_token: 'SECRET_REFRESH' },
      refresh_token: 'SECRET_TOP_LEVEL',
      quota: {
        last_updated: 1763500100,
        subscription_tier: 'Google AI Pro',
        is_forbidden: false,
        models: [],
        quota_groups: [
          {
            display_name: 'Gemini',
            buckets: [
              {
                bucket_id: 'gemini-5h',
                window: '5h',
                remaining_fraction: 0.78,
                remaining_fraction_known: true,
                reset_time: '2026-11-20T05:00:00Z',
              },
              {
                bucket_id: 'gemini-weekly',
                window: 'weekly',
                remaining_fraction: 0.42,
                remaining_fraction_known: true,
                reset_time: '2026-11-24T00:00:00Z',
              },
            ],
          },
          {
            display_name: 'Claude and GPT',
            buckets: [
              {
                bucket_id: '3p-5h',
                window: '5h',
                remaining_fraction: 0.9,
                remaining_fraction_known: true,
                reset_time: '2026-11-20T05:00:00Z',
              },
              {
                bucket_id: '3p-weekly',
                window: 'weekly',
                remaining_fraction: 0.65,
                remaining_fraction_known: true,
                reset_time: '2026-11-24T00:00:00Z',
              },
            ],
          },
          {
            display_name: 'Gemini 4 Argon',
            buckets: [
              {
                bucket_id: 'gemini-argon-wtu-weekly',
                window: 'weekly',
                remaining_fraction: 0.982,
                remaining_fraction_known: true,
                reset_time: '2026-11-25T01:37:15Z',
              },
            ],
          },
        ],
      },
    },
    {
      id: 'acct_backup_02',
      email: 'beta@example.com',
      name: 'Beta User',
      custom_label: null,
      disabled: false,
      validation_blocked: false,
      last_used: 1763400000,
      is_current: false,
      quota: {
        last_updated: 1763490000,
        subscription_tier: 'Google AI Ultra',
        is_forbidden: false,
        models: [
          {
            name: 'gemini-4-hydrogen',
            percentage: 95,
            percentage_known: true,
            reset_time: '2026-11-20T06:00:00Z',
          },
          {
            name: 'gemini-4-neon',
            percentage: 88,
            percentage_known: true,
            reset_time: '2026-11-20T05:30:00Z',
          },
        ],
        quota_groups: null,
      },
    },
    {
      id: 'acct_disabled_03',
      email: 'disabled@example.com',
      name: 'Disabled User',
      custom_label: null,
      disabled: true,
      validation_blocked: false,
      last_used: 0,
      is_current: false,
      quota: null,
    },
  ],
};

async function runTests() {
  let passed = 0;
  const runCase = async (name, fn) => {
    await fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  };

  await runCase('1. Patcher & Installer marker and syntax validation', async () => {
    const ipcRaw = readSrc('ipc-block.js');
    const p1 = readSrc('preload-part1.js');
    const p2 = readSrc('preload-part2.js');
    const p3 = readSrc('preload-part3.js');
    const cliStatus = readSrc('agy-statusline.js');

    assert(ipcRaw.length >= 500 && ipcRaw.includes('TELEMETRY_MOD_IPC_START') && ipcRaw.includes('TELEMETRY_MOD_IPC_END'));
    assert(p1.length >= 500 && p1.includes('TELEMETRY_MOD_PRELOAD_START') && p1.includes('installTelemetryBar'));
    assert(p2.length >= 500 && p2.includes('refreshActivityModal'));
    assert(p3.length >= 500 && p3.includes('TELEMETRY_MOD_PRELOAD_END'));
    assert(cliStatus.startsWith('#!/usr/bin/env node') && cliStatus.includes('TELEMETRY_MOD_CLI_STATUSLINE'));

    const patchedIpc = patchAsar.applyIpcPatch(
      'const electron_1 = require("electron");\nregisterWcvIpcHandlers();\n//# sourceMappingURL=ipcHandlers.js.map\n',
      ipcRaw
    );
    assert(patchedIpc.includes('telemetry:accounts-list'));
    assert(patchedIpc.includes('telemetry:accounts-sync'));
    assert(patchedIpc.includes('telemetry:accounts-refresh'));
    assert(patchedIpc.includes('telemetry:accounts-switch'));
    assert(patchedIpc.includes('telemetry:accounts-add'));
    assert(patchedIpc.includes('telemetry:accounts-add-status'));
    assert(patchedIpc.includes('telemetry:accounts-add-cancel'));
    assert(patchedIpc.includes('telemetry:accounts-add-open'));
    assert(patchedIpc.includes('telemetry:accounts-delete'));

    const preloadCombined = [p1, p2, p3].join('\n');
    const patchedPreload = patchAsar.applyPreloadPatch(
      'const electron_1 = require("electron");\n//# sourceMappingURL=preload.js.map\n',
      preloadCombined
    );
    assert(patchedPreload.includes('ta-tab-accounts'));
    assert(patchedPreload.includes('telemetry:accounts-sync'));
    assert(patchedPreload.includes('telemetry:accounts-switch'));
    assert(patchedPreload.includes('telemetry:accounts-add'));
    assert(patchedPreload.includes('telemetry:accounts-add-status'));
    assert(patchedPreload.includes('telemetry:accounts-add-cancel'));
    assert(patchedPreload.includes('telemetry:accounts-add-open'));
    assert(patchedPreload.includes('telemetry:accounts-delete'));
  });

  await runCase('2. CLI absent degrades gracefully to available=false', async () => {
    const tmpHome = createTempDir('agy-tp-absent-');
    try {
      let called = false;
      const handlers = loadIpcBlockSandbox({
        homeDir: tmpHome,
        envOverrides: {
          ANTIGRAVITY_SWITCH_CLI: '',
          LOCALAPPDATA: path.join(tmpHome, 'localappdata'),
          ProgramFiles: path.join(tmpHome, 'progfiles'),
          PATH: '',
        },
        execFileImpl: () => {
          called = true;
        },
        spawnImpl: () => {
          called = true;
        },
      });
      const res = await handlers.get('telemetry:accounts-list')(TRUSTED_EVENT);
      assert.strictEqual(res.available, false);
      assert.strictEqual(res.reason, 'not_installed');
      assert.strictEqual(Array.from(res.accounts).length, 0);
      assert.strictEqual(called, false);
    } finally {
      removeDirSafe(tmpHome);
    }
  });

  await runCase('3. Untrusted senderFrame is rejected on all account IPC handlers', async () => {
    const tmpHome = createTempDir('agy-tp-sec-');
    const fakeCli = path.join(tmpHome, process.platform === 'win32' ? 'agy-switch.exe' : 'agy-switch');
    fs.writeFileSync(fakeCli, 'dummy');
    try {
      let invoked = false;
      const handlers = loadIpcBlockSandbox({
        homeDir: tmpHome,
        envOverrides: { ANTIGRAVITY_SWITCH_CLI: fakeCli, PATH: '' },
        execFileImpl: () => { invoked = true; },
        spawnImpl: () => { invoked = true; },
      });
      const badEvents = [
        null,
        { senderFrame: null },
        { senderFrame: { url: 'https://evil.example.com/', parent: null } },
        { senderFrame: { url: 'http://127.0.0.1:41234/', parent: {} } },
        { senderFrame: { url: 'file:///C:/temp/x.html', parent: null } },
      ];
      for (const evt of badEvents) {
        const r1 = await handlers.get('telemetry:accounts-list')(evt);
        assert.strictEqual(r1.available, false);
        const r1s = await handlers.get('telemetry:accounts-sync')(evt);
        assert.strictEqual(r1s.available, false);
        const r2 = await handlers.get('telemetry:accounts-refresh')(evt);
        assert.strictEqual(r2.refreshed, false);
        const r3 = await handlers.get('telemetry:accounts-switch')(evt, 'acct_backup_02');
        assert.strictEqual(r3.ok, false);
        const r4 = await handlers.get('telemetry:accounts-add')(evt);
        assert.strictEqual(r4.ok, false);
        const r4s = await handlers.get('telemetry:accounts-add-status')(evt);
        assert.strictEqual(r4s.active, false);
        const r4c = await handlers.get('telemetry:accounts-add-cancel')(evt);
        assert.strictEqual(r4c.ok, false);
        const r4o = await handlers.get('telemetry:accounts-add-open')(evt);
        assert.strictEqual(r4o.ok, false);
        const r5 = await handlers.get('telemetry:accounts-delete')(evt, 'acct_backup_02');
        assert.strictEqual(r5.ok, false);
      }
      assert.strictEqual(invoked, false);
    } finally {
      removeDirSafe(tmpHome);
    }
  });

  await runCase('4. accounts-list parses groups/models, resolves config dir, and strips credentials', async () => {
    const tmpHome = createTempDir('agy-tp-list-');
    const toolDir = path.join(tmpHome, 'cli-bin');
    fs.mkdirSync(toolDir, { recursive: true });
    const fakeCli = path.join(toolDir, process.platform === 'win32' ? 'agy-switch.exe' : 'agy-switch');
    fs.writeFileSync(fakeCli, 'dummy');
    fs.mkdirSync(path.join(tmpHome, '.gemini'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.gemini', 'telemetry-switch-cli.json'),
      JSON.stringify({ cliPath: toolDir })
    );
    try {
      const calls = [];
      const handlers = loadIpcBlockSandbox({
        homeDir: tmpHome,
        envOverrides: { ANTIGRAVITY_SWITCH_CLI: '', PATH: '' },
        execFileImpl: (file, args, opts, cb) => {
          calls.push({ file, args, opts });
          if (args[0] === '--version') {
            cb(null, JSON.stringify({ name: 'agy-switch', version: '4.10.18' }), '');
            return;
          }
          cb(null, JSON.stringify(SAMPLE_LIST_PAYLOAD), '');
        },
        spawnImpl: () => { throw new Error('unexpected spawn'); },
      });

      const res = await handlers.get('telemetry:accounts-list')(TRUSTED_EVENT);
      assert.strictEqual(res.available, true);
      assert.strictEqual(res.error, null);
      assert.strictEqual(res.currentId, 'acct_main_01');
      assert.strictEqual(res.accounts.length, 3);
      assert.deepStrictEqual(Array.from(res.capabilities), []);
      const listCall = calls.find((c) => c.args[0] === 'accounts');
      assert(listCall, 'expected accounts list call');
      assert.strictEqual(path.resolve(listCall.file), path.resolve(fakeCli));
      assert.deepStrictEqual(Array.from(listCall.args), ['accounts', 'list', '--json']);
      assert.strictEqual(listCall.opts.shell, false);
      assert.strictEqual(listCall.opts.windowsHide, true);

      const main = res.accounts[0];
      assert.strictEqual(main.plan, 'PRO');
      assert.strictEqual(main.label, 'Main Pro');
      assert.strictEqual(main.quota.fiveHour.pct, 78);
      assert.strictEqual(main.quota.weekly.pct, 42);
      assert.strictEqual(main.quota.secondaryFiveHour.pct, 90);
      assert.strictEqual(main.quota.secondaryWeekly.pct, 65);
      assert.strictEqual(main.quota.argonWeekly.pct, 98);
      // Verify dynamic groups[] preserve all pools & sort buckets shortest -> longest
      assert(Array.isArray(main.quota.groups) && main.quota.groups.length === 3);
      assert.strictEqual(main.quota.groups[0].shortName, 'Gemini');
      assert.strictEqual(main.quota.groups[0].buckets.length, 2);
      assert.strictEqual(main.quota.groups[0].buckets[0].label, '5h');
      assert.strictEqual(main.quota.groups[0].buckets[0].pct, 78);
      assert.strictEqual(main.quota.groups[0].buckets[1].label, '周');
      assert.strictEqual(main.quota.groups[0].buckets[1].pct, 42);
      assert.strictEqual(main.quota.groups[1].shortName, 'Claude / GPT');
      assert.strictEqual(main.quota.groups[2].shortName, 'Argon');
      assert.strictEqual(main.quota.groups[2].buckets.length, 1);
      assert.strictEqual(main.quota.groups[2].buckets[0].label, '周');
      // Verify zero credential leakage
      const serialized = JSON.stringify(res);
      assert(!serialized.includes('SECRET_ACCESS'));
      assert(!serialized.includes('SECRET_REFRESH'));
      assert(!serialized.includes('SECRET_TOP_LEVEL'));
      assert.strictEqual(main.token, undefined);
      assert.strictEqual(main.refresh_token, undefined);

      // Verify legacy models[] fallback synthesizes dynamic groups on acct_backup_02
      const backup = res.accounts[1];
      assert.strictEqual(backup.plan, 'ULTRA');
      assert.strictEqual(backup.quota.fiveHour.pct, 88);
      assert(Array.isArray(backup.quota.groups) && backup.quota.groups.length === 1);
      assert.strictEqual(backup.quota.groups[0].shortName, 'Gemini');
      assert.strictEqual(backup.quota.groups[0].buckets[0].pct, 88);
    } finally {
      removeDirSafe(tmpHome);
    }
  });

  await runCase('5. accounts-refresh calls refresh --json then list --json with single-flight dedup', async () => {
    const tmpHome = createTempDir('agy-tp-refresh-');
    const fakeCli = path.join(tmpHome, process.platform === 'win32' ? 'agy-switch.exe' : 'agy-switch');
    fs.writeFileSync(fakeCli, 'dummy');
    try {
      const seqArgs = [];
      const handlers = loadIpcBlockSandbox({
        homeDir: tmpHome,
        envOverrides: { ANTIGRAVITY_SWITCH_CLI: fakeCli, PATH: '' },
        execFileImpl: (_file, args, _opts, cb) => {
          seqArgs.push(args.join(' '));
          setTimeout(() => {
            if (args[0] === 'refresh') {
              cb(null, JSON.stringify({ schema_version: 1, total: 2, success: 2, failed: 0, details: [] }), '');
            } else {
              cb(null, JSON.stringify(SAMPLE_LIST_PAYLOAD), '');
            }
          }, 25);
        },
        spawnImpl: () => { throw new Error('unexpected spawn'); },
      });

      const [r1, r2] = await Promise.all([
        handlers.get('telemetry:accounts-refresh')(TRUSTED_EVENT),
        handlers.get('telemetry:accounts-refresh')(TRUSTED_EVENT),
      ]);
      assert.strictEqual(r1.refreshed, true);
      assert.strictEqual(r2.refreshed, true);
      assert.strictEqual(r1.refreshSummary.success, 2);
      assert.deepStrictEqual(seqArgs, ['refresh --json', 'accounts list --json']);
    } finally {
      removeDirSafe(tmpHome);
    }
  });

  await runCase('6. accounts-switch blocks invalid/disabled IDs and spawns detached switch cleanly', async () => {
    const tmpHome = createTempDir('agy-tp-switch-');
    const fakeCli = path.join(tmpHome, process.platform === 'win32' ? 'agy-switch.exe' : 'agy-switch');
    fs.writeFileSync(fakeCli, 'dummy');
    try {
      const spawns = [];
      const handlers = loadIpcBlockSandbox({
        homeDir: tmpHome,
        envOverrides: { ANTIGRAVITY_SWITCH_CLI: fakeCli, PATH: '' },
        execFileImpl: (_file, _args, _opts, cb) => {
          cb(null, JSON.stringify(SAMPLE_LIST_PAYLOAD), '');
        },
        spawnImpl: (file, args, opts) => {
          const child = new EventEmitter();
          let unrefCalled = false;
          child.unref = () => { unrefCalled = true; };
          spawns.push({ file, args, opts, getUnref: () => unrefCalled });
          setImmediate(() => child.emit('spawn'));
          return child;
        },
      });

      // Injection & malformed IDs must fail immediately
      for (const badId of ['', '   ', '../evil', 'acct_backup_02 && calc', 'a b', 'x'.repeat(129)]) {
        const res = await handlers.get('telemetry:accounts-switch')(TRUSTED_EVENT, badId);
        assert.strictEqual(res.ok, false);
      }
      // Disabled account must be rejected
      const disabledRes = await handlers.get('telemetry:accounts-switch')(TRUSTED_EVENT, 'acct_disabled_03');
      assert.strictEqual(disabledRes.ok, false);
      // Unknown account must be rejected
      const missingRes = await handlers.get('telemetry:accounts-switch')(TRUSTED_EVENT, 'acct_nonexistent');
      assert.strictEqual(missingRes.ok, false);
      assert.strictEqual(spawns.length, 0);

      // Valid healthy inactive account triggers detached spawn
      const okRes = await handlers.get('telemetry:accounts-switch')(TRUSTED_EVENT, 'acct_backup_02');
      assert.strictEqual(okRes.ok, true);
      assert.strictEqual(okRes.switching, true);
      assert.strictEqual(okRes.accountId, 'acct_backup_02');
      assert.strictEqual(spawns.length, 1);
      assert.deepStrictEqual(Array.from(spawns[0].args), ['switch', 'acct_backup_02', '--target', 'app', '--json']);
      assert.strictEqual(spawns[0].opts.detached, true);
      assert.strictEqual(spawns[0].opts.stdio, 'ignore');
      assert.strictEqual(spawns[0].opts.windowsHide, true);
      assert.strictEqual(spawns[0].opts.shell, false);
      assert.strictEqual(spawns[0].getUnref(), true);
    } finally {
      removeDirSafe(tmpHome);
    }
  });

  await runCase('7. Privacy audit: zero hardcoded user paths, personal emails, or OAuth secrets in src/ & tools/', async () => {
    const files = ['ipc-block.js', 'preload-part1.js', 'preload-part2.js', 'preload-part3.js'].map((f) => path.join(SRC_DIR, f));
    const liteSrcDir = path.join(REPO_ROOT, 'tools', 'agy-switch-lite', 'src');
    if (fs.existsSync(liteSrcDir)) {
      for (const f of fs.readdirSync(liteSrcDir).filter((x) => x.endsWith('.rs'))) {
        files.push(path.join(liteSrcDir, f));
      }
    }
    const oauthRe = new RegExp('GOCSPX' + '-|apps\\.googleusercontent\\.com', 'i');
    for (const full of files) {
      const content = fs.readFileSync(full, 'utf8');
      const rel = path.relative(REPO_ROOT, full);
      assert(!/[A-Za-z]:[\\/]+Users[\\/]+[^\\/'"`\s$%]+/i.test(content), `Found hardcoded user path in ${rel}`);
      assert(!oauthRe.test(content), `Found Google OAuth secret/client in ${rel}`);
      assert(!/@qq\.com|@gmail\.com/i.test(content), `Found personal email in ${rel}`);
    }
  });

  await runCase('8. Patcher round-trip idempotency and clean restore', async () => {
    const ipcRaw = readSrc('ipc-block.js');
    const preloadRaw = [readSrc('preload-part1.js'), readSrc('preload-part2.js'), readSrc('preload-part3.js')].join('\n');
    const origIpc = 'const electron_1 = require("electron");\nregisterWcvIpcHandlers();\n';
    const origPreload = 'const electron_1 = require("electron");\nconsole.log("orig");\n';

    const ipcOnce = patchAsar.applyIpcPatch(origIpc, ipcRaw);
    const ipcTwice = patchAsar.applyIpcPatch(ipcOnce, ipcRaw);
    assert.strictEqual(ipcOnce, ipcTwice);
    assert.strictEqual(patchAsar.stripIpcPatch(ipcOnce).trim(), origIpc.trim());

    const preOnce = patchAsar.applyPreloadPatch(origPreload, preloadRaw);
    const preTwice = patchAsar.applyPreloadPatch(preOnce, preloadRaw);
    assert.strictEqual(preOnce, preTwice);
    assert.strictEqual(patchAsar.stripPreloadPatch(preOnce).trim(), origPreload.trim());
  });

  await runCase('9. Preload UI helpers, XSS escaping, and default-hidden account switcher markup', async () => {
    const combined = [readSrc('preload-part1.js'), readSrc('preload-part2.js'), readSrc('preload-part3.js')].join('\n');
    // Verify modal template defaults account tab, header pill, and accounts section to hidden
    assert(combined.includes('data-tab="accounts" data-role="ta-tab-accounts" hidden'));
    assert(combined.includes('data-role="ta-acct-pill" hidden'));
    assert(combined.includes('data-role="ta-accounts-section" hidden'));
    // Verify inline two-step confirmation, sync-live, and silent browser OAuth controls exist
    assert(combined.includes('data-action="acct-add"'));
    assert(combined.includes('data-action="acct-add-open"'));
    assert(combined.includes('data-action="acct-add-copy"'));
    assert(combined.includes('data-action="acct-add-cancel"'));
    assert(combined.includes('data-action="acct-sync-live" hidden'));
    assert(combined.includes('data-action="acct-switch"'));
    assert(combined.includes('data-action="acct-confirm"'));
    assert(combined.includes('data-action="acct-delete"'));
    assert(combined.includes('data-action="acct-delete-confirm"'));
    assert(combined.includes('data-action="acct-cancel"'));
    // Verify compact 1-line summary bar + 2-column grid + dynamic pool rows + animated SVG ring classes
    assert(combined.includes('agy-ta-acct-summary-bar'));
    assert(combined.includes('grid-template-columns: repeat(2, minmax(0, 1fr));'));
    assert(combined.includes('agy-ta-pool-row'));
    assert(combined.includes('agy-ta-ring-arc'));
    assert(combined.includes('agy-ta-pool-only-tag'));
    // Verify unified fixed panel geometry anchored to Daily view
    assert(combined.includes('width: min(860px, 94vw);'));
    assert(combined.includes('height: min(656px, 90vh);'));
    assert(combined.includes('scrollbar-gutter: stable;'));
    assert(combined.includes('data-role="acct-kpi-current-val"'));
    assert(combined.includes('@media (max-height: 540px)'));
    // Verify renderer never references raw token fields
    assert(!combined.includes('refresh_token'));
    assert(!combined.includes('access_token'));
    // Verify helper functions execute cleanly in an isolated VM context
    const fnStart = combined.indexOf('function escHtml(');
    const fnEnd = combined.indexOf('function calcCachePct(');
    const qStart = combined.indexOf('function formatResetCountdown(');
    const qEnd = combined.indexOf('function syncAccountsChromeAndVisibility(');
    assert(fnStart > 0 && fnEnd > fnStart && qStart > 0 && qEnd > qStart);
    const helperCtx = vm.createContext({ Date, Math, Number, String, Array, Map });
    new vm.Script(combined.slice(fnStart, fnEnd) + '\n' + combined.slice(qStart, qEnd)).runInContext(helperCtx);
    // XSS escaping check
    const html = helperCtx.renderQuotaBarHtml('<img src=x onerror=1>', { pct: 65, resetTime: new Date(Date.now() + 7500000).toISOString() });
    assert(html.includes('&lt;img src=x onerror=1&gt;'));
    assert(!html.includes('<img '));
    assert(html.includes('65%'));
    // Dual-window pool renders left short bar + right animated SVG ring with XX% inside & W1 3-o'clock weekly reset
    const futureShort = new Date(Date.now() + 17400000).toISOString();
    const futureWeek = new Date(Date.now() + 4 * 86400000).toISOString();
    const dualHtml = helperCtx.renderPoolRowHtml('acct1', {
      name: 'Gemini Models',
      shortName: 'Gemini',
      buckets: [
        { window: '5h', label: '5h', pct: 78, resetTime: futureShort },
        { window: 'weekly', label: '周', pct: 93, resetTime: futureWeek },
      ],
    }, 0, new Map(), new Map(), true);
    assert(dualHtml.includes('agy-ta-pool-row'));
    assert(dualHtml.includes('agy-ta-ring-arc'));
    assert(dualHtml.includes('data-target-offset='));
    assert(dualHtml.includes('>93%<'));
    assert(dualHtml.includes('agy-ta-pool-reset')); // < 100% shows short countdown
    assert(dualHtml.includes('agy-ta-pool-long-reset')); // W1 shows weekly reset at 3 o'clock when < 100%
    assert(dualHtml.includes('4d'));
    // Full 100% hides countdowns (both short & long); 100% inside ring gets .is-full-pct
    const fullBothHtml = helperCtx.renderPoolRowHtml('acct2', {
      name: 'Claude and GPT models',
      shortName: 'Claude / GPT',
      buckets: [
        { window: '5h', label: '5h', pct: 100, resetTime: futureShort },
        { window: 'weekly', label: '周', pct: 100, resetTime: futureWeek },
      ],
    }, 1, new Map(), new Map(), true);
    assert(!fullBothHtml.includes('agy-ta-pool-reset'));
    assert(fullBothHtml.includes('is-full-pct'));
    assert(fullBothHtml.includes('>100%<'));
    assert(fullBothHtml.includes('<span class="agy-ta-pool-long-reset"></span>'));
    // Depleted 0% weekly marks long-reset column with is-depleted
    const depletedWeekHtml = helperCtx.renderPoolRowHtml('acct2b', {
      name: 'Claude and GPT models',
      shortName: 'Claude / GPT',
      buckets: [
        { window: 'daily', label: '日', pct: 100, resetTime: futureShort },
        { window: 'weekly', label: '周', pct: 0, resetTime: futureWeek },
      ],
    }, 1, new Map(), new Map(), true);
    assert(depletedWeekHtml.includes('agy-ta-pool-long-reset is-depleted'));
    // Plan A single-window pool renders left bar + centered muted tag (e.g. 仅周) with is-single-window
    const singleHtml = helperCtx.renderPoolRowHtml('acct3', {
      name: 'Gemini 4 Argon',
      shortName: 'Argon',
      buckets: [{ window: 'weekly', label: '周', pct: 98, resetTime: futureWeek }],
    }, 2, new Map(), new Map(), true);
    assert(singleHtml.includes('is-single-window'));
    assert(singleHtml.includes('agy-ta-pool-only-tag'));
    assert(singleHtml.includes('仅周'));
    assert(!singleHtml.includes('agy-ta-ring-arc'));
    assert.strictEqual(helperCtx.getQuotaBarColor(75), 'var(--agy-ta-q-good)');
    assert.strictEqual(helperCtx.getQuotaBarColor(30), 'var(--agy-ta-q-warn)');
    assert.strictEqual(helperCtx.getQuotaBarColor(10), 'var(--agy-ta-q-low)');
  });

  await runCase('10. Silent background ConPTY/PTY accounts-add lifecycle (auth_url -> open -> success & cancel)', async () => {
    const tmpHome = createTempDir('agy-tp-add-');
    const fakeCli = path.join(tmpHome, process.platform === 'win32' ? 'agy-switch.exe' : 'agy-switch');
    fs.writeFileSync(fakeCli, 'dummy');
    const sampleAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Foauth-callback&state=test-state-123';
    try {
      let listCallCount = 0;
      const spawns = [];
      const openedUrls = [];
      const makeMockChild = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killed = false;
        const writes = [];
        child.stdin = {
          destroyed: false,
          write(txt) { writes.push(String(txt)); },
          end() { this.destroyed = true; },
        };
        child.kill = () => { child.killed = true; };
        child._writes = writes;
        return child;
      };

      const handlers = loadIpcBlockSandbox({
        homeDir: tmpHome,
        envOverrides: { ANTIGRAVITY_SWITCH_CLI: fakeCli, PATH: '' },
        shellOpenImpl: async (u) => { openedUrls.push(u); },
        execFileImpl: (_file, args, _opts, cb) => {
          if (args[0] === '--version') {
            cb(null, JSON.stringify({ name: 'agy-switch', version: '4.10.18' }), '');
            return;
          }
          listCallCount += 1;
          const accounts = listCallCount <= 1
            ? [SAMPLE_LIST_PAYLOAD.accounts[0]]
            : [SAMPLE_LIST_PAYLOAD.accounts[0], SAMPLE_LIST_PAYLOAD.accounts[1]];
          cb(null, JSON.stringify({ schema_version: 1, current_target: 'app', accounts }), '');
        },
        spawnImpl: (file, args, opts) => {
          const child = makeMockChild();
          spawns.push({ file, args, opts, child });
          setTimeout(() => {
            child.stdout.emit('data', JSON.stringify({ event: 'auth_url', url: sampleAuthUrl }) + '\n');
          }, 15);
          return child;
        },
      });

      // 1) Start silent add -> receives auth_url with windowsHide=true and shell=false
      const startRes = await handlers.get('telemetry:accounts-add')(TRUSTED_EVENT);
      assert.strictEqual(startRes.ok, true);
      assert.strictEqual(startRes.state, 'waiting_browser');
      assert.strictEqual(startRes.authUrl, sampleAuthUrl);
      assert.strictEqual(spawns.length, 1);
      assert.strictEqual(spawns[0].opts.windowsHide, true);
      assert.strictEqual(spawns[0].opts.shell, false);
      assert.strictEqual(path.resolve(spawns[0].opts.env.AGY_SWITCH_BIN), path.resolve(fakeCli));

      // Duplicate add while active reuses existing session (no second spawn)
      const dupRes = await handlers.get('telemetry:accounts-add')(TRUSTED_EVENT);
      assert.strictEqual(dupRes.ok, true);
      assert.strictEqual(spawns.length, 1);

      // Reopen browser opens only the captured trusted Google OAuth URL
      const openRes = await handlers.get('telemetry:accounts-add-open')(TRUSTED_EVENT);
      assert.strictEqual(openRes.ok, true);
      assert.deepStrictEqual(openedUrls, [sampleAuthUrl]);

      // Driver emits success -> status transitions to done with newly added account
      spawns[0].child.stdout.emit('data', JSON.stringify({ event: 'success' }) + '\n');
      await new Promise((r) => setTimeout(r, 40));
      const doneSt = await handlers.get('telemetry:accounts-add-status')(TRUSTED_EVENT);
      assert.strictEqual(doneSt.active, false);
      assert.strictEqual(doneSt.state, 'done');
      assert.strictEqual(doneSt.accounts.length, 2);
      assert.strictEqual(doneSt.addedLabel, 'beta@example.com');
      assert(spawns[0].child._writes.some((w) => w.includes('CANCEL')));

      // 2) Start second session and cancel -> sends CANCEL\n and clears active session
      const start2 = await handlers.get('telemetry:accounts-add')(TRUSTED_EVENT);
      assert.strictEqual(start2.ok, true);
      assert.strictEqual(spawns.length, 2);
      const cancelRes = await handlers.get('telemetry:accounts-add-cancel')(TRUSTED_EVENT);
      assert.strictEqual(cancelRes.ok, true);
      assert.strictEqual(cancelRes.cancelled, true);
      assert(spawns[1].child._writes.some((w) => w.includes('CANCEL')));
      const idleSt = await handlers.get('telemetry:accounts-add-status')(TRUSTED_EVENT);
      assert.strictEqual(idleSt.active, false);
      assert.strictEqual(idleSt.state, 'idle');
    } finally {
      removeDirSafe(tmpHome);
    }
  });

  await runCase('11. accounts-delete atomically updates accounts.json, removes file, and blocks bad IDs', async () => {
    const tmpHome = createTempDir('agy-tp-del-');
    const dataDir = path.join(tmpHome, '.antigravity_tools');
    const accountsDir = path.join(dataDir, 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    const fakeCli = path.join(tmpHome, process.platform === 'win32' ? 'agy-switch.exe' : 'agy-switch');
    fs.writeFileSync(fakeCli, 'dummy');

    const initialIndex = {
      version: '2.0',
      accounts: [
        { id: 'acct_main_01', email: 'alpha@example.com', name: 'Alpha', disabled: false, created_at: 1, last_used: 2 },
        { id: 'acct_backup_02', email: 'beta@example.com', name: 'Beta', disabled: false, created_at: 1, last_used: 1 },
      ],
      current_account_id: 'acct_main_01',
      current_target_ide: null,
      current_ide_account_id: 'acct_main_01',
      current_vscode_account_id: 'acct_main_01',
    };
    const indexPath = path.join(dataDir, 'accounts.json');
    fs.writeFileSync(indexPath, '\uFEFF' + JSON.stringify(initialIndex, null, 2), 'utf8');
    const mainFile = path.join(accountsDir, 'acct_main_01.json');
    const backupFile = path.join(accountsDir, 'acct_backup_02.json');
    fs.writeFileSync(mainFile, JSON.stringify({ id: 'acct_main_01', email: 'alpha@example.com' }), 'utf8');
    fs.writeFileSync(backupFile, JSON.stringify({ id: 'acct_backup_02', email: 'beta@example.com' }), 'utf8');

    try {
      const handlers = loadIpcBlockSandbox({
        homeDir: tmpHome,
        envOverrides: { ANTIGRAVITY_SWITCH_CLI: fakeCli, ABV_DATA_DIR: '', PATH: '' },
        execFileImpl: (_file, args, _opts, cb) => {
          if (args[0] === '--version') {
            cb(null, JSON.stringify({ name: 'agy-switch', version: '4.10.18' }), '');
            return;
          }
          const curIdx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
          cb(null, JSON.stringify({
            schema_version: 1,
            current_target: null,
            accounts: curIdx.accounts.map((a) => ({
              id: a.id,
              email: a.email,
              name: a.name,
              is_current: a.id === curIdx.current_account_id,
              disabled: false,
              validation_blocked: false,
              last_used: a.last_used,
              quota: null,
            })),
          }), '');
        },
        spawnImpl: () => { throw new Error('unexpected spawn'); },
      });

      // Invalid / traversal IDs rejected
      for (const badId of ['', '../accounts', 'acct_main_01/../../x', 'bad id']) {
        const badRes = await handlers.get('telemetry:accounts-delete')(TRUSTED_EVENT, badId);
        assert.strictEqual(badRes.ok, false);
      }
      // Missing account ID rejected
      const missingRes = await handlers.get('telemetry:accounts-delete')(TRUSTED_EVENT, 'acct_does_not_exist');
      assert.strictEqual(missingRes.ok, false);

      // Delete current account -> promotes next remaining account & clears ide/vscode selections & deletes json file
      const delRes = await handlers.get('telemetry:accounts-delete')(TRUSTED_EVENT, 'acct_main_01');
      assert.strictEqual(delRes.ok, true);
      assert.strictEqual(delRes.deletedId, 'acct_main_01');
      assert.strictEqual(delRes.accounts.length, 1);
      assert.strictEqual(delRes.accounts[0].id, 'acct_backup_02');
      assert.strictEqual(delRes.currentId, 'acct_backup_02');

      const updatedIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      assert.strictEqual(updatedIndex.accounts.length, 1);
      assert.strictEqual(updatedIndex.current_account_id, 'acct_backup_02');
      assert.strictEqual(updatedIndex.current_ide_account_id, undefined);
      assert.strictEqual(updatedIndex.current_vscode_account_id, undefined);
      assert.strictEqual(fs.existsSync(mainFile), false);
      assert.strictEqual(fs.existsSync(backupFile), true);
    } finally {
      removeDirSafe(tmpHome);
    }
  });

  await runCase('12. Native agy-switch-lite capabilities (sync single-flight, native add --json, native delete --json)', async () => {
    const tmpHome = createTempDir('agy-tp-lite-');
    const fakeCli = path.join(tmpHome, process.platform === 'win32' ? 'agy-switch.exe' : 'agy-switch');
    fs.writeFileSync(fakeCli, 'dummy-lite');
    const sampleAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A54322%2Foauth-callback&state=lite-state';
    try {
      const execArgs = [];
      const spawns = [];
      let currentAccounts = [SAMPLE_LIST_PAYLOAD.accounts[0], SAMPLE_LIST_PAYLOAD.accounts[1]];

      const handlers = loadIpcBlockSandbox({
        homeDir: tmpHome,
        envOverrides: { ANTIGRAVITY_SWITCH_CLI: fakeCli, PATH: '' },
        execFileImpl: (_file, args, _opts, cb) => {
          execArgs.push(args.join(' '));
          setTimeout(() => {
            if (args[0] === '--version') {
              cb(null, JSON.stringify({
                name: 'agy-switch',
                version: '4.10.18-lite',
                schema_version: 1,
                capabilities: ['sync', 'add', 'delete', 'refresh', 'switch'],
              }), '');
              return;
            }
            if (args[0] === 'sync') {
              cb(null, JSON.stringify({
                schema_version: 1,
                synced: true,
                imported: true,
                changed: true,
                email: 'alpha@example.com',
                account_id: 'acct_main_01',
              }), '');
              return;
            }
            if (args[0] === 'delete') {
              const delId = args[1];
              currentAccounts = currentAccounts.filter((a) => a.id !== delId);
              cb(null, JSON.stringify({ schema_version: 1, deleted: true, account_id: delId }), '');
              return;
            }
            cb(null, JSON.stringify({ schema_version: 1, current_target: 'app', accounts: currentAccounts }), '');
          }, 15);
        },
        spawnImpl: (file, args, opts) => {
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.killed = false;
          child.stdin = { destroyed: false, write() {}, end() { this.destroyed = true; } };
          child.kill = () => { child.killed = true; };
          spawns.push({ file, args, opts, child });
          setTimeout(() => {
            child.stdout.emit('data', JSON.stringify({ event: 'auth_url', url: sampleAuthUrl }) + '\n');
          }, 10);
          return child;
        },
      });

      // 1) accounts-list reports native capabilities
      const listRes = await handlers.get('telemetry:accounts-list')(TRUSTED_EVENT);
      assert.strictEqual(listRes.available, true);
      assert(Array.isArray(listRes.capabilities) && listRes.capabilities.includes('sync'));
      assert(listRes.capabilities.includes('add') && listRes.capabilities.includes('delete'));

      // 2) accounts-sync deduplicates concurrent calls via single-flight
      execArgs.length = 0;
      const [s1, s2] = await Promise.all([
        handlers.get('telemetry:accounts-sync')(TRUSTED_EVENT),
        handlers.get('telemetry:accounts-sync')(TRUSTED_EVENT),
      ]);
      assert.strictEqual(s1.synced, true);
      assert.strictEqual(s1.imported, true);
      assert.strictEqual(s1.changed, true);
      assert.strictEqual(s1.syncedEmail, 'alpha@example.com');
      assert.strictEqual(s2.synced, true);
      assert.deepStrictEqual(execArgs, ['sync --json', 'accounts list --json']);

      // 3) accounts-add spawns agy-switch directly with ['add', '--json'] (zero PowerShell/PTY)
      const addRes = await handlers.get('telemetry:accounts-add')(TRUSTED_EVENT);
      assert.strictEqual(addRes.ok, true);
      assert.strictEqual(addRes.state, 'waiting_browser');
      assert.strictEqual(spawns.length, 1);
      assert.strictEqual(path.resolve(spawns[0].file), path.resolve(fakeCli));
      assert.deepStrictEqual(Array.from(spawns[0].args), ['add', '--json']);
      assert.strictEqual(spawns[0].opts.windowsHide, true);
      assert.strictEqual(spawns[0].opts.shell, false);
      await handlers.get('telemetry:accounts-add-cancel')(TRUSTED_EVENT);

      // 4) accounts-delete uses native `delete <id> --json` directly
      execArgs.length = 0;
      const delRes = await handlers.get('telemetry:accounts-delete')(TRUSTED_EVENT, 'acct_backup_02');
      assert.strictEqual(delRes.ok, true);
      assert.strictEqual(delRes.deletedId, 'acct_backup_02');
      assert.strictEqual(delRes.accounts.length, 1);
      assert.deepStrictEqual(execArgs, ['delete acct_backup_02 --json', 'accounts list --json']);
    } finally {
      removeDirSafe(tmpHome);
    }
  });

  console.log(`\nAll ${passed} tests passed!`);
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
