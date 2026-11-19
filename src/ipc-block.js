// === TELEMETRY_MOD_IPC_START ===
{
const osTelemetry = require('os');
const pathTelemetry = require('path');
const fsTelemetry = require('fs');
const electronMain = (typeof electron_1 !== 'undefined' && electron_1.ipcMain) ? electron_1.ipcMain : require('electron').ipcMain;
const telemetryCache = new Map();

function stripBom(text) {
  return String(text == null ? '' : text).replace(/^\uFEFF/, '');
}

function getCliHomeDir(homeDir) {
  const envCliHome = typeof process.env.ANTIGRAVITY_CLI_HOME === 'string'
    ? process.env.ANTIGRAVITY_CLI_HOME.trim()
    : '';
  if (envCliHome) {
    return pathTelemetry.resolve(envCliHome);
  }
  return pathTelemetry.join(homeDir, '.gemini', 'antigravity-cli');
}

function isHexOrUuid(s) {
  return /^[0-9a-f]{16,64}$/i.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

const MODEL_PAREN_SUFFIX_RE = /\s*\((?:Extra\s+Low|Very\s+High|XHigh|High|Medium|Low|Max|Thinking|Fast|Slow|Standard|Preview|Experimental|MaaS|\d+(?:\.\d+)?\s*[KM](?:\s*context)?)\)\s*$/i;
const MODEL_SLUG_SUFFIX_RE = /-(?:maas|extra[-_]low|very[-_]high|xhigh|high|medium|low|max|thinking|tiered|trial|preview|exp|latest|control|worker-agy|orchestrator-g1-pro|1m|2m|128k|200k|256k|512k|1000k|\d{4}-\d{2}-\d{2}|\d{8}|[nhabc])$/i;

function stripModelParenSuffixes(raw) {
  let name = String(raw || '').trim();
  let prev;
  do {
    prev = name;
    name = name.replace(MODEL_PAREN_SUFFIX_RE, '').trim();
  } while (name !== prev);
  return name;
}

function normalizeModelSlug(raw) {
  let s = stripModelParenSuffixes(raw);
  if (!s || isHexOrUuid(s)) return '';
  s = s.replace(/^(?:[a-z0-9._-]+\/)+/i, '');
  s = s.replace(/@.*$/, '').trim();
  if (!s || isHexOrUuid(s)) return '';
  if (/^gemini-pro-orchestrator-g1-pro$/i.test(s)) return 'Gemini 4 Argon';
  let prev;
  do {
    prev = s;
    s = s.replace(MODEL_SLUG_SUFFIX_RE, '');
  } while (s !== prev);
  s = s.replace(/(\d)[-_](\d)/g, '$1.$2').replace(/(\d)[-_](\d)/g, '$1.$2');
  const parts = s.split(/[-_]+/).filter(Boolean).map((w) => {
    if (/^gpt$/i.test(w)) return 'GPT';
    if (/^oss$/i.test(w)) return 'OSS';
    if (/^\d+(?:\.\d+)?[bk]$/i.test(w)) return w.toUpperCase();
    if (/^\d/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  return parts.join(' ').trim();
}

function normalizeModelName(rawDisplay, rawInternal) {
  const d = String(rawDisplay || '').trim();
  if (d && !isHexOrUuid(d)) {
    let name = stripModelParenSuffixes(d);
    const looksLikeSlug = name && !/\s/.test(name) && (
      name.includes('/') ||
      name.includes('@') ||
      /-(?:maas|extra[-_]low|very[-_]high|xhigh|high|medium|low|max|thinking|tiered|trial|preview|exp|latest|control|worker-agy|orchestrator-g1-pro)$/i.test(name) ||
      (/^[a-z0-9._-]+$/.test(name) && name.includes('-'))
    );
    if (looksLikeSlug) {
      const slugRes = normalizeModelSlug(name);
      if (slugRes) return slugRes;
    }
    name = name.replace(/^(?:[a-z0-9._-]+\/)+/i, '').replace(/@[^\s()]*$/, '').trim();
    if (/^Orchestrator\s*\(([^)]+)\)$/i.test(name)) {
      name = 'Gemini 4 ' + name.match(/^Orchestrator\s*\(([^)]+)\)$/i)[1].trim();
    }
    if (name && !isHexOrUuid(name)) return name;
  }
  const intern = String(rawInternal || '').trim();
  if (intern && !isHexOrUuid(intern)) {
    const res = normalizeModelSlug(intern);
    if (res) return res;
  }
  return '';
}

const needleLsi = Buffer.from('\x0flast_step_index\x12', 'latin1');

function extractConvModelMap(convDbPath) {
  const stepMap = {};
  let defaultModel = '';
  let dbSize = 0;
  if (!convDbPath || typeof convDbPath !== 'string') {
    return { stepMap, sortedSteps: [], defaultModel, dbSize };
  }

  const filesToCheck = [convDbPath, `${convDbPath}-wal`];
  for (const filePath of filesToCheck) {
    let stat;
    try {
      if (!fsTelemetry.existsSync(filePath)) continue;
      stat = fsTelemetry.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat || !stat.isFile()) continue;
    dbSize += stat.size;
    if (stat.size > 512 * 1024 * 1024 || stat.size === 0) {
      continue;
    }
    const CHUNK_SIZE = 8 * 1024 * 1024;
    const MARGIN = 700;
    const KEEP = MARGIN * 2;
    let fd = null;
    try {
      fd = fsTelemetry.openSync(filePath, 'r');
      const chunkBuf = Buffer.allocUnsafe(stat.size <= CHUNK_SIZE ? stat.size : (CHUNK_SIZE + KEEP));
      let filePos = 0;
      let carryLen = 0;
      while (filePos < stat.size) {
        const maxRead = Math.min(CHUNK_SIZE, stat.size - filePos, chunkBuf.length - carryLen);
        if (maxRead <= 0) break;
        const bytesRead = fsTelemetry.readSync(fd, chunkBuf, carryLen, maxRead, filePos);
        if (bytesRead <= 0) break;
        filePos += bytesRead;
        const totalLen = carryLen + bytesRead;
        const isLast = filePos >= stat.size;
        const scanEnd = isLast ? totalLen : totalLen - MARGIN;
        let offset = carryLen > 0 ? Math.max(0, carryLen - MARGIN) : 0;
        let prevLsiEnd = offset;
        while (offset < scanEnd) {
          const idx = chunkBuf.indexOf(needleLsi, offset);
          if (idx === -1 || idx >= scanEnd) break;
          const pos = idx + needleLsi.length;
          if (pos < totalLen) {
            const vlen = chunkBuf[pos];
            if (vlen >= 1 && vlen <= 8 && pos + 1 + vlen <= totalLen) {
              const stepStr = chunkBuf.slice(pos + 1, pos + 1 + vlen).toString('latin1');
              if (/^\d+$/.test(stepStr)) {
                let rawInternal = '';
                const intStart = Math.max(prevLsiEnd, idx - 650);
                for (let k = intStart; k <= idx - 3; k++) {
                  if (chunkBuf[k] === 0x9a && chunkBuf[k + 1] === 0x01) {
                    const mlen = chunkBuf[k + 2];
                    if (mlen >= 4 && mlen <= 120 && k + 3 + mlen <= idx) {
                      const s = chunkBuf.slice(k + 3, k + 3 + mlen).toString('utf8');
                      if (/^[a-z][a-z0-9._/@-]+$/i.test(s) && !isHexOrUuid(s)) {
                        rawInternal = s;
                      }
                    }
                  }
                }
                let rawDisplay = '';
                const nextIdx = chunkBuf.indexOf(needleLsi, pos);
                const winEnd = Math.min(totalLen, idx + 650, nextIdx !== -1 ? nextIdx : totalLen);
                for (let k = pos; k <= winEnd - 3; k++) {
                  if (chunkBuf[k] === 0xaa && chunkBuf[k + 1] === 0x01) {
                    const dlen = chunkBuf[k + 2];
                    if (dlen >= 4 && dlen <= 120 && k + 3 + dlen <= winEnd) {
                      const s = chunkBuf.slice(k + 3, k + 3 + dlen).toString('utf8');
                      if (/^[A-Za-z][A-Za-z0-9 ._()\-+/]+$/.test(s) && !isHexOrUuid(s)) {
                        rawDisplay = s;
                        break;
                      }
                    }
                  }
                }
                const norm = normalizeModelName(rawDisplay, rawInternal);
                if (norm) {
                  stepMap[Number(stepStr)] = norm;
                  defaultModel = norm;
                }
              }
            }
          }
          prevLsiEnd = pos;
          offset = pos;
        }
        if (isLast) break;
        carryLen = Math.min(KEEP, totalLen);
        chunkBuf.copy(chunkBuf, 0, totalLen - carryLen, totalLen);
      }
    } catch {
      continue;
    } finally {
      if (fd !== null) {
        try { fsTelemetry.closeSync(fd); } catch {}
      }
    }
  }

  const sortedSteps = Object.keys(stepMap).map(Number).sort((a, b) => a - b);
  return { stepMap, sortedSteps, defaultModel, dbSize };
}

function resolveStepModel(stepIdx, modelInfo, fallbackModel) {
  if (modelInfo && modelInfo.stepMap && modelInfo.stepMap[stepIdx]) {
    return modelInfo.stepMap[stepIdx];
  }
  if (modelInfo && modelInfo.sortedSteps && modelInfo.sortedSteps.length > 0) {
    const steps = modelInfo.sortedSteps;
    if (stepIdx < steps[0]) {
      return modelInfo.stepMap[steps[0]];
    }
    let chosen = steps[0];
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i] <= stepIdx) {
        chosen = steps[i];
        break;
      }
    }
    return modelInfo.stepMap[chosen];
  }
  const fb = fallbackModel ? (normalizeModelName(fallbackModel, '') || String(fallbackModel).trim()) : '';
  return (modelInfo && modelInfo.defaultModel) || fb || '其他模型';
}

function isConvEntryNewer(candidate, current) {
  if (!candidate || typeof candidate !== 'object' || typeof candidate.mtimeMs !== 'number') {
    return false;
  }
  if (!current || typeof current !== 'object' || typeof current.mtimeMs !== 'number') {
    return true;
  }
  if (candidate.mtimeMs !== current.mtimeMs) {
    return candidate.mtimeMs > current.mtimeMs;
  }
  const candSize = Number(candidate.size) || 0;
  const curSize = Number(current.size) || 0;
  if (candSize !== curSize) {
    return candSize > curSize;
  }
  return (Number(candidate.dbSize) || 0) > (Number(current.dbSize) || 0);
}

function sleepAsyncMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFileLockAsync(lockPath, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = fsTelemetry.openSync(lockPath, 'wx');
      try {
        fsTelemetry.writeSync(fd, `${process.pid}`);
      } finally {
        fsTelemetry.closeSync(fd);
      }
      return true;
    } catch (err) {
      const code = err && err.code;
      if (code === 'EEXIST') {
        try {
          const st = fsTelemetry.statSync(lockPath);
          if (Date.now() - st.mtimeMs > 5000) {
            fsTelemetry.unlinkSync(lockPath);
            continue;
          }
        } catch {}
      } else if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
        return false;
      }
      await sleepAsyncMs(12 + Math.floor(Math.random() * 14));
    }
  }
  return false;
}

function releaseFileLockSync(lockPath) {
  try {
    if (fsTelemetry.existsSync(lockPath)) {
      fsTelemetry.unlinkSync(lockPath);
    }
  } catch {}
}

async function atomicWriteFileAsync(targetPath, payload) {
  const dir = pathTelemetry.dirname(targetPath);
  if (!fsTelemetry.existsSync(dir)) {
    fsTelemetry.mkdirSync(dir, { recursive: true });
  }
  const rand = Math.random().toString(36).slice(2, 8);
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${rand}.tmp`;
  try {
    fsTelemetry.writeFileSync(tmpPath, payload, 'utf8');
    const retryDelays = [15, 30, 50, 80];
    let renamed = false;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        fsTelemetry.renameSync(tmpPath, targetPath);
        renamed = true;
        break;
      } catch (err) {
        const code = err && err.code;
        const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
        if (retryable && attempt < retryDelays.length) {
          await sleepAsyncMs(retryDelays[attempt]);
          continue;
        }
        break;
      }
    }
    if (!renamed) {
      fsTelemetry.writeFileSync(targetPath, payload, 'utf8');
    }
  } finally {
    try {
      if (fsTelemetry.existsSync(tmpPath)) {
        fsTelemetry.unlinkSync(tmpPath);
      }
    } catch {}
  }
}

electronMain.removeHandler?.('telemetry:get-stats');
electronMain.handle('telemetry:get-stats', async (_event, conversationId) => {
try {
const homeDir = osTelemetry.homedir();
const cliHomeDir = getCliHomeDir(homeDir);
const candidateDirs = [
pathTelemetry.join(cliHomeDir, 'brain'),
pathTelemetry.join(homeDir, '.gemini', 'antigravity', 'brain'),
];
let targetTranscriptPath = null;
const resolvedConvId = typeof conversationId === 'string' && /^[a-zA-Z0-9_-]+$/.test(conversationId)
? conversationId
: null;
if (!resolvedConvId) {
return null;
}
for (const baseDir of candidateDirs) {
const p = pathTelemetry.join(baseDir, resolvedConvId, '.system_generated', 'logs', 'transcript.jsonl');
if (fsTelemetry.existsSync(p)) {
targetTranscriptPath = p;
break;
}
}
if (!targetTranscriptPath) {
return null;
}
const stat = fsTelemetry.statSync(targetTranscriptPath);
const cacheKey = `${targetTranscriptPath}:${stat.mtimeMs}:${stat.size}`;
if (telemetryCache.has(cacheKey)) {
return telemetryCache.get(cacheKey);
}
const fileContent = stripBom(await fsTelemetry.promises.readFile(targetTranscriptPath, 'utf-8'));
const lines = fileContent.split(/\r?\n/).filter(Boolean);
const rows = [];
for (const line of lines) {
try {
rows.push(JSON.parse(stripBom(line)));
}
catch {
}
}
let sumInputTokens = 0;
let sumCacheTokens = 0;
let sumOutputTokens = 0;
let latestStepTps = 0;
let baseInstructionTokens = 16000;
let firstPlannerSeen = false;
let latestPlanner = null;
let compactedContextUsed = null;
for (let i = 0; i < rows.length; i++) {
const row = rows[i];
if (row.type === 'PLANNER_RESPONSE') {
const inTok = Number(row.input_tokens) || 0;
const cacheTok = Number(row.cache_read_tokens) || 0;
const outTok = Number(row.output_tokens) || 0;
if (!firstPlannerSeen && (inTok + cacheTok > 0)) {
firstPlannerSeen = true;
baseInstructionTokens = Math.min(25000, inTok + cacheTok);
}
sumInputTokens += inTok;
sumCacheTokens += cacheTok;
sumOutputTokens += outTok;
if (row.created_at && outTok > 0) {
const t0 = new Date(row.created_at).getTime();
const nextRow = rows[i + 1];
const t1 = (nextRow && nextRow.created_at && nextRow.type !== 'USER_INPUT')
? new Date(nextRow.created_at).getTime()
: (i === rows.length - 1 ? stat.mtimeMs : 0);
if (t1 > t0) {
const elapsed = (t1 - t0) / 1000;
if (elapsed >= 0.4 && elapsed <= 180) {
const stepTps = outTok / elapsed;
if (stepTps >= 5 && stepTps <= 350) {
latestStepTps = Math.max(1, Math.min(350, Math.round(stepTps)));
}
}
}
}
latestPlanner = {
inputTokens: inTok,
cacheReadTokens: cacheTok,
outputTokens: outTok,
createdAt: row.created_at,
};
compactedContextUsed = null;
}
else if (row.type === 'CHECKPOINT') {
const cpIn = Number(row.input_tokens) || 0;
const cpCache = Number(row.cache_read_tokens) || 0;
const cpOut = Number(row.output_tokens) || 0;
sumInputTokens += cpIn;
sumCacheTokens += cpCache;
sumOutputTokens += cpOut;
const summaryTokens = cpOut > 0
? cpOut
: Math.round(String(row.content || '').length / 3.6);
compactedContextUsed = baseInstructionTokens + summaryTokens;
}
}
const calculatedTokensPerSec = latestStepTps;
const cumulativePromptTokens = sumInputTokens + sumCacheTokens;
const cacheHitRate = cumulativePromptTokens > 0
? Math.round((sumCacheTokens / cumulativePromptTokens) * 100)
: 0;
let latestContextUsed = 0;
if (latestPlanner) {
const promptSum = latestPlanner.inputTokens + latestPlanner.cacheReadTokens;
latestContextUsed = compactedContextUsed !== null
? compactedContextUsed
: (promptSum + latestPlanner.outputTokens);
}
else if (compactedContextUsed !== null) {
latestContextUsed = compactedContextUsed;
}
const cumulativeTokens = sumInputTokens + sumCacheTokens + sumOutputTokens;
const result = {
conversationId: resolvedConvId,
tokensPerSecond: calculatedTokensPerSec,
cacheHitRate,
cumulativePromptTokens,
cumulativeTokens,
latestContextUsed,
compactedJustNow: compactedContextUsed !== null,
latestInputTokens: latestPlanner?.inputTokens ?? 0,
latestCacheTokens: latestPlanner?.cacheReadTokens ?? 0,
latestOutputTokens: latestPlanner?.outputTokens ?? 0,
};
if (telemetryCache.size >= 20) {
const oldestKey = telemetryCache.keys().next().value;
if (oldestKey !== undefined) {
telemetryCache.delete(oldestKey);
}
}
telemetryCache.set(cacheKey, result);
return result;
}
catch {
return null;
}
});
electronMain.removeHandler?.('telemetry:get-activity-stats');
electronMain.handle('telemetry:get-activity-stats', async () => {
const makeEmptyBucket = () => ({ in: 0, cache: 0, out: 0, total: 0, desktop: 0, cli: 0, steps: 0, models: {} });
const makeEmptySummary = () => ({ in: 0, cache: 0, out: 0, total: 0, desktop: 0, cli: 0, steps: 0, activeDays: 0, models: {} });
const mergeModelBuckets = (targetModels, srcModels, fallbackTotalObj) => {
if (!targetModels || typeof targetModels !== 'object') return;
if (srcModels && typeof srcModels === 'object' && Object.keys(srcModels).length > 0) {
for (const [mName, mVal] of Object.entries(srcModels)) {
if (!mVal || typeof mVal !== 'object') continue;
if (!targetModels[mName]) {
targetModels[mName] = { in: 0, cache: 0, out: 0, total: 0, steps: 0 };
}
targetModels[mName].in += Number(mVal.in) || 0;
targetModels[mName].cache += Number(mVal.cache) || 0;
targetModels[mName].out += Number(mVal.out) || 0;
targetModels[mName].total += Number(mVal.total) || 0;
targetModels[mName].steps += Number(mVal.steps) || 0;
}
} else if (fallbackTotalObj && (Number(fallbackTotalObj.total) || 0) > 0) {
const fbName = '其他模型';
if (!targetModels[fbName]) {
targetModels[fbName] = { in: 0, cache: 0, out: 0, total: 0, steps: 0 };
}
targetModels[fbName].in += Number(fallbackTotalObj.in) || 0;
targetModels[fbName].cache += Number(fallbackTotalObj.cache) || 0;
targetModels[fbName].out += Number(fallbackTotalObj.out) || 0;
targetModels[fbName].total += Number(fallbackTotalObj.total) || 0;
targetModels[fbName].steps += Number(fallbackTotalObj.steps) || 0;
}
};
const toLocalDayKey = (dt) => new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const formatYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const now = new Date();
const todayKey = toLocalDayKey(now);
try {
const homeDir = osTelemetry.homedir();
const cliHomeDir = getCliHomeDir(homeDir);
const sources = [
{ source: 'desktop', dir: pathTelemetry.join(homeDir, '.gemini', 'antigravity', 'brain'), convDir: pathTelemetry.join(homeDir, '.gemini', 'antigravity', 'conversations') },
{ source: 'cli', dir: pathTelemetry.join(cliHomeDir, 'brain'), convDir: pathTelemetry.join(cliHomeDir, 'conversations') },
];
const cachePath = pathTelemetry.join(homeDir, '.gemini', 'telemetry-activity-cache.json');
let cache = { version: 4, conversations: {} };
try {
if (fsTelemetry.existsSync(cachePath)) {
const rawCache = stripBom(await fsTelemetry.promises.readFile(cachePath, 'utf-8'));
const parsed = JSON.parse(rawCache);
if (parsed && typeof parsed === 'object' && parsed.version === 4 && parsed.conversations && typeof parsed.conversations === 'object') {
cache = { version: 4, conversations: parsed.conversations };
}
}
}
catch {
cache = { version: 4, conversations: {} };
}
let cacheDirty = false;
const updatedKeys = new Set();
for (const srcObj of sources) {
if (!fsTelemetry.existsSync(srcObj.dir)) {
continue;
}
let entries = [];
try {
entries = fsTelemetry.readdirSync(srcObj.dir, { withFileTypes: true });
}
catch {
continue;
}
for (const entry of entries) {
if (!entry.isDirectory()) {
continue;
}
const convId = entry.name;
const p = pathTelemetry.join(srcObj.dir, convId, '.system_generated', 'logs', 'transcript.jsonl');
let stat;
try {
stat = fsTelemetry.statSync(p);
}
catch {
continue;
}
if (!stat.isFile()) {
continue;
}
const key = `${srcObj.source}:${convId}`;
const existing = cache.conversations[key];
const dbPath = pathTelemetry.join(srcObj.convDir, `${convId}.db`);
let dbSize = 0;
try {
if (fsTelemetry.existsSync(dbPath)) {
const s = fsTelemetry.statSync(dbPath);
if (s.isFile()) dbSize += s.size;
}
const walPath = `${dbPath}-wal`;
if (fsTelemetry.existsSync(walPath)) {
const ws = fsTelemetry.statSync(walPath);
if (ws.isFile()) dbSize += ws.size;
}
} catch {}

if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size && existing.dbSize === dbSize && existing.daily && typeof existing.daily === 'object') {
continue;
}
let fileContent = '';
try {
fileContent = stripBom(await fsTelemetry.promises.readFile(p, 'utf-8'));
}
catch {
continue;
}
const modelInfo = extractConvModelMap(dbPath);
const daily = {};
const lines = fileContent.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
const line = stripBom(lines[i]).trim();
if (!line) {
continue;
}
let row;
try {
row = JSON.parse(line);
}
catch {
continue;
}
if (!row || (row.type !== 'PLANNER_RESPONSE' && row.type !== 'CHECKPOINT')) {
continue;
}
const inTok = Number(row.input_tokens) || 0;
const cacheTok = Number(row.cache_read_tokens) || 0;
const outTok = Number(row.output_tokens) || 0;
const rowTotal = inTok + cacheTok + outTok;
if (rowTotal > 0) {
let dt = row.created_at ? new Date(row.created_at) : new Date(stat.mtimeMs);
if (Number.isNaN(dt.getTime())) {
dt = new Date(stat.mtimeMs);
}
const dayKey = toLocalDayKey(dt);
if (!daily[dayKey]) {
daily[dayKey] = { in: 0, cache: 0, out: 0, total: 0, steps: 0, models: {} };
}
const stepIdx = Number(row.step_index) || 0;
const modelName = resolveStepModel(stepIdx, modelInfo, '');
if (!daily[dayKey].models) {
daily[dayKey].models = {};
}
if (!daily[dayKey].models[modelName]) {
daily[dayKey].models[modelName] = { in: 0, cache: 0, out: 0, total: 0, steps: 0 };
}
daily[dayKey].in += inTok;
daily[dayKey].cache += cacheTok;
daily[dayKey].out += outTok;
daily[dayKey].total += rowTotal;
daily[dayKey].steps += 1;

daily[dayKey].models[modelName].in += inTok;
daily[dayKey].models[modelName].cache += cacheTok;
daily[dayKey].models[modelName].out += outTok;
daily[dayKey].models[modelName].total += rowTotal;
daily[dayKey].models[modelName].steps += 1;
}
}
cache.conversations[key] = {
mtimeMs: stat.mtimeMs,
size: stat.size,
dbSize: modelInfo ? modelInfo.dbSize : dbSize,
source: srcObj.source,
daily,
};
cacheDirty = true;
updatedKeys.add(key);
}
}
if (cacheDirty) {
const cacheDir = pathTelemetry.dirname(cachePath);
if (!fsTelemetry.existsSync(cacheDir)) {
fsTelemetry.mkdirSync(cacheDir, { recursive: true });
}
const lockPath = `${cachePath}.lock`;
const hasLock = await acquireFileLockAsync(lockPath, 1000);
try {
try {
if (fsTelemetry.existsSync(cachePath)) {
const latestRaw = stripBom(await fsTelemetry.promises.readFile(cachePath, 'utf-8'));
const latestParsed = JSON.parse(latestRaw);
if (latestParsed && typeof latestParsed === 'object' && latestParsed.version === 4 && latestParsed.conversations && typeof latestParsed.conversations === 'object') {
for (const [k, v] of Object.entries(latestParsed.conversations)) {
if (!updatedKeys.has(k) && v && typeof v === 'object') {
cache.conversations[k] = v;
}
else if (updatedKeys.has(k) && isConvEntryNewer(v, cache.conversations[k])) {
cache.conversations[k] = v;
}
}
}
}
}
catch {
}
await atomicWriteFileAsync(cachePath, JSON.stringify(cache));
}
catch {
}
finally {
if (hasLock) {
releaseFileLockSync(lockPath);
}
}
}
const days = {};
let totalConversations = 0;
for (const [key, conv] of Object.entries(cache.conversations)) {
if (!conv || !conv.daily || typeof conv.daily !== 'object') {
continue;
}
const source = conv.source === 'cli' || (!conv.source && key.startsWith('cli:')) ? 'cli' : 'desktop';
let convHasTokens = false;
for (const [dayKey, d] of Object.entries(conv.daily)) {
if (!d || typeof d !== 'object') {
continue;
}
const dIn = Number(d.in) || 0;
const dCache = Number(d.cache) || 0;
const dOut = Number(d.out) || 0;
const dTotal = Number(d.total) || (dIn + dCache + dOut);
const dSteps = Number(d.steps) || 0;
if (dTotal <= 0 && dSteps <= 0) {
continue;
}
convHasTokens = true;
if (!days[dayKey]) {
days[dayKey] = makeEmptyBucket();
}
days[dayKey].in += dIn;
days[dayKey].cache += dCache;
days[dayKey].out += dOut;
days[dayKey].total += dTotal;
days[dayKey].steps += dSteps;
if (source === 'cli') {
days[dayKey].cli += dTotal;
}
else {
days[dayKey].desktop += dTotal;
}
mergeModelBuckets(days[dayKey].models, d.models, d);
}
if (convHasTokens) {
totalConversations += 1;
}
}
const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const diffToMonday = (localMidnight.getDay() + 6) % 7;
const weekStart = new Date(localMidnight.getFullYear(), localMidnight.getMonth(), localMidnight.getDate() - diffToMonday);
const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6);
const weekStartKey = formatYmd(weekStart);
const weekEndKey = formatYmd(weekEnd);
const monthPrefix = todayKey.slice(0, 7);
const today = makeEmptySummary();
const thisWeek = makeEmptySummary();
const thisMonth = makeEmptySummary();
const allTime = { ...makeEmptySummary(), totalConversations };
const addDayToSummary = (summary, bucket) => {
summary.in += bucket.in;
summary.cache += bucket.cache;
summary.out += bucket.out;
summary.total += bucket.total;
summary.desktop += bucket.desktop;
summary.cli += bucket.cli;
summary.steps += bucket.steps;
if (bucket.total > 0) {
summary.activeDays += 1;
}
mergeModelBuckets(summary.models, bucket.models, bucket);
};
for (const [dayKey, bucket] of Object.entries(days)) {
addDayToSummary(allTime, bucket);
if (dayKey === todayKey) {
addDayToSummary(today, bucket);
}
if (dayKey >= weekStartKey && dayKey <= weekEndKey) {
addDayToSummary(thisWeek, bucket);
}
if (dayKey.startsWith(monthPrefix)) {
addDayToSummary(thisMonth, bucket);
}
}
return { todayKey, today, thisWeek, thisMonth, allTime, days };
}
catch {
return {
todayKey,
today: makeEmptySummary(),
thisWeek: makeEmptySummary(),
thisMonth: makeEmptySummary(),
allTime: { ...makeEmptySummary(), totalConversations: 0 },
days: {},
};
}
});

// --- External Account Switcher CLI Bridge (Optional, Capability-Gated, Zero Credentials) ---
const childProcessTelemetry = require('child_process');
const SWITCH_ACCOUNT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const SWITCH_CLI_CONFIG_FILE = 'telemetry-switch-cli.json';
let accountsRefreshInFlight = null;
let accountsSwitchInFlight = false;

function isTrustedLocalSender(event) {
  try {
    const frame = event && event.senderFrame;
    if (!frame || frame.parent) {
      return false;
    }
    const rawUrl = typeof frame.url === 'string' ? frame.url : '';
    if (!rawUrl) {
      return false;
    }
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = (parsed.hostname || '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function sanitizeSafeText(val, maxLen) {
  if (typeof val !== 'string') {
    return '';
  }
  const cleaned = val.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function isValidSwitchCliBinary(candidatePath) {
  try {
    if (typeof candidatePath !== 'string') {
      return false;
    }
    const trimmed = candidatePath.trim();
    if (!trimmed || /[\u0000-\u001f]/.test(trimmed)) {
      return false;
    }
    const resolved = pathTelemetry.resolve(trimmed);
    if (!pathTelemetry.isAbsolute(resolved)) {
      return false;
    }
    if (process.platform === 'win32' && !/\.exe$/i.test(resolved)) {
      return false;
    }
    const st = fsTelemetry.statSync(resolved);
    return st.isFile();
  } catch {
    return false;
  }
}

function readConfiguredSwitchCliPath(homeDir) {
  try {
    const cfgPath = pathTelemetry.join(homeDir, '.gemini', SWITCH_CLI_CONFIG_FILE);
    if (!fsTelemetry.existsSync(cfgPath)) {
      return '';
    }
    const raw = stripBom(fsTelemetry.readFileSync(cfgPath, 'utf-8'));
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.cliPath === 'string' ? parsed.cliPath.trim() : '';
  } catch {
    return '';
  }
}

function resolveSwitchCliPath() {
  const homeDir = osTelemetry.homedir();
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'agy-switch.exe' : 'agy-switch';
  const explicitCandidates = [];
  if (typeof process.env.ANTIGRAVITY_SWITCH_CLI === 'string' && process.env.ANTIGRAVITY_SWITCH_CLI.trim()) {
    explicitCandidates.push(process.env.ANTIGRAVITY_SWITCH_CLI.trim());
  }
  const cfgPath = readConfiguredSwitchCliPath(homeDir);
  if (cfgPath) {
    explicitCandidates.push(cfgPath);
  }
  for (const cand of explicitCandidates) {
    if (isValidSwitchCliBinary(cand)) {
      return pathTelemetry.resolve(cand);
    }
    try {
      const resolvedDir = pathTelemetry.resolve(cand);
      if (fsTelemetry.statSync(resolvedDir).isDirectory()) {
        const nested = pathTelemetry.join(resolvedDir, binName);
        if (isValidSwitchCliBinary(nested)) {
          return nested;
        }
      }
    } catch {}
  }

  const knownCandidates = [];
  if (isWin) {
    const localAppData = typeof process.env.LOCALAPPDATA === 'string' ? process.env.LOCALAPPDATA.trim() : '';
    const programFiles = typeof process.env.ProgramFiles === 'string' ? process.env.ProgramFiles.trim() : '';
    if (localAppData) {
      knownCandidates.push(
        pathTelemetry.join(localAppData, 'agy-switch', binName),
        pathTelemetry.join(localAppData, 'Programs', 'agy-switch', binName),
        pathTelemetry.join(localAppData, 'AntiGravity Switch', binName),
        pathTelemetry.join(localAppData, 'Programs', 'AntiGravity Switch', binName)
      );
    }
    if (programFiles) {
      knownCandidates.push(
        pathTelemetry.join(programFiles, 'agy-switch', binName),
        pathTelemetry.join(programFiles, 'AntiGravity Switch', binName)
      );
    }
    knownCandidates.push(
      pathTelemetry.join(homeDir, '.gemini', 'tools', 'agy-switch', binName),
      pathTelemetry.join(homeDir, '.gemini', 'tools', binName)
    );
  } else {
    knownCandidates.push(
      '/Applications/AntiGravity Switch.app/Contents/MacOS/agy-switch',
      '/usr/local/bin/agy-switch',
      '/opt/homebrew/bin/agy-switch',
      '/usr/bin/agy-switch',
      pathTelemetry.join(homeDir, '.local', 'bin', 'agy-switch')
    );
  }
  for (const cand of knownCandidates) {
    if (isValidSwitchCliBinary(cand)) {
      return pathTelemetry.resolve(cand);
    }
  }

  const rawPathEnv = typeof process.env.PATH === 'string' ? process.env.PATH : '';
  if (rawPathEnv) {
    const dirs = rawPathEnv.split(pathTelemetry.delimiter).map((d) => d.trim().replace(/^"+|"+$/g, '')).filter(Boolean);
    for (const dir of dirs) {
      const cand = pathTelemetry.join(dir, binName);
      if (isValidSwitchCliBinary(cand)) {
        return pathTelemetry.resolve(cand);
      }
    }
  }
  return null;
}

function parseCliJsonOutput(rawText) {
  const cleaned = stripBom(String(rawText || '')).trim();
  if (!cleaned) {
    return null;
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function runSwitchCliJson(cliPath, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      childProcessTelemetry.execFile(
        cliPath,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          shell: false,
        },
        (err, stdout, stderr) => {
          const parsedOut = parseCliJsonOutput(stdout);
          const parsedErr = parseCliJsonOutput(stderr);
          if (!err && parsedOut && typeof parsedOut === 'object') {
            resolve({ ok: true, data: parsedOut, error: null });
            return;
          }
          const errMsg = (parsedErr && parsedErr.error && typeof parsedErr.error.message === 'string')
            ? sanitizeSafeText(parsedErr.error.message, 180)
            : (parsedOut && parsedOut.error && typeof parsedOut.error.message === 'string')
              ? sanitizeSafeText(parsedOut.error.message, 180)
              : (err && err.killed)
                ? '外部 CLI 执行超时，请稍后重试'
                : '外部 CLI 返回异常，请检查 agy-switch 状态';
          resolve({ ok: false, data: null, error: errMsg });
        }
      );
    } catch {
      resolve({ ok: false, data: null, error: '无法启动外部 CLI 进程' });
    }
  });
}

function normalizePlanBadge(rawTier) {
  const s = sanitizeSafeText(rawTier, 64);
  if (!s) {
    return 'UNKNOWN';
  }
  if (/ultra/i.test(s)) return 'ULTRA';
  if (/pro/i.test(s)) return 'PRO';
  if (/enterprise|business|pay/i.test(s)) return 'GCP';
  if (/free|standard/i.test(s)) return 'FREE';
  return s.length > 12 ? s.slice(0, 12).toUpperCase() : s.toUpperCase();
}

function extractBucketWindowSummary(buckets, matcherRe) {
  let chosenPct = null;
  let chosenReset = '';
  for (const b of buckets || []) {
    if (!b || typeof b !== 'object') continue;
    const win = String(b.window || b.bucket_id || '').toLowerCase();
    if (!matcherRe.test(win)) continue;
    if (b.remaining_fraction_known === false) continue;
    const frac = Number(b.remaining_fraction);
    if (!Number.isFinite(frac)) continue;
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    const reset = sanitizeSafeText(b.reset_time, 64);
    if (chosenPct === null || pct < chosenPct) {
      chosenPct = pct;
      chosenReset = reset;
    }
  }
  return { pct: chosenPct, resetTime: chosenReset };
}

function extractAccountQuotaSummary(rawQuota) {
  const empty = {
    fiveHour: { pct: null, resetTime: '' },
    weekly: { pct: null, resetTime: '' },
    secondaryLabel: '',
    secondaryFiveHour: { pct: null, resetTime: '' },
    secondaryWeekly: { pct: null, resetTime: '' },
  };
  if (!rawQuota || typeof rawQuota !== 'object') {
    return empty;
  }
  const groups = Array.isArray(rawQuota.quota_groups) ? rawQuota.quota_groups : [];
  if (groups.length > 0) {
    const primaryGroup =
      groups.find((g) => g && /gemini/i.test(String(g.display_name || '')) && !/argon|carbon/i.test(String(g.display_name || ''))) ||
      groups.find((g) => g && /gemini/i.test(String(g.display_name || ''))) ||
      groups[0];
    const secondaryGroup =
      groups.find((g) => g && g !== primaryGroup && /claude|gpt|partner|third|\b3p\b/i.test(String(g.display_name || ''))) ||
      groups.find((g) => g && g !== primaryGroup && Array.isArray(g.buckets) && g.buckets.some((b) => b && /^3p[-_]/i.test(String(b.bucket_id || '')))) ||
      null;
    const fiveRe = /(?:^|[_-])5h(?:$|[_-])|five.?hour/i;
    const weekRe = /week/i;
    const out = {
      fiveHour: primaryGroup ? extractBucketWindowSummary(primaryGroup.buckets, fiveRe) : { pct: null, resetTime: '' },
      weekly: primaryGroup ? extractBucketWindowSummary(primaryGroup.buckets, weekRe) : { pct: null, resetTime: '' },
      secondaryLabel: secondaryGroup ? sanitizeSafeText(secondaryGroup.display_name, 32) : '',
      secondaryFiveHour: secondaryGroup ? extractBucketWindowSummary(secondaryGroup.buckets, fiveRe) : { pct: null, resetTime: '' },
      secondaryWeekly: secondaryGroup ? extractBucketWindowSummary(secondaryGroup.buckets, weekRe) : { pct: null, resetTime: '' },
    };
    if (out.fiveHour.pct !== null || out.weekly.pct !== null || out.secondaryFiveHour.pct !== null || out.secondaryWeekly.pct !== null) {
      return out;
    }
  }

  const models = Array.isArray(rawQuota.models) ? rawQuota.models : [];
  if (models.length > 0) {
    const geminiModels = models.filter((m) => m && /gemini/i.test(String(m.name || '')) && !/argon|carbon/i.test(String(m.name || '')));
    const pool = geminiModels.length > 0 ? geminiModels : models;
    let minPct = null;
    let reset = '';
    for (const m of pool) {
      if (!m || m.percentage_known === false) continue;
      const pctNum = Number(m.percentage);
      if (!Number.isFinite(pctNum)) continue;
      const pct = Math.max(0, Math.min(100, Math.round(pctNum)));
      if (minPct === null || pct < minPct) {
        minPct = pct;
        reset = sanitizeSafeText(m.reset_time, 64);
      }
    }
    return {
      ...empty,
      fiveHour: { pct: minPct, resetTime: reset },
    };
  }
  return empty;
}

function sanitizeAccountView(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!SWITCH_ACCOUNT_ID_RE.test(id)) {
    return null;
  }
  const q = raw.quota && typeof raw.quota === 'object' ? raw.quota : null;
  return {
    id,
    email: sanitizeSafeText(raw.email, 160),
    name: sanitizeSafeText(raw.name, 80),
    label: sanitizeSafeText(raw.custom_label, 48),
    plan: normalizePlanBadge(q && q.subscription_tier),
    planRaw: sanitizeSafeText(q && q.subscription_tier, 48),
    isCurrent: Boolean(raw.is_current),
    disabled: Boolean(raw.disabled),
    validationBlocked: Boolean(raw.validation_blocked),
    isForbidden: Boolean(q && q.is_forbidden),
    lastUsed: Number(raw.last_used) || 0,
    lastUpdated: Number(q && q.last_updated) || 0,
    quota: extractAccountQuotaSummary(q),
  };
}

async function fetchSanitizedAccountsList(cliPath) {
  const res = await runSwitchCliJson(cliPath, ['accounts', 'list', '--json'], 6000);
  if (!res.ok) {
    return {
      available: true,
      accounts: [],
      currentId: null,
      currentTarget: null,
      error: res.error,
    };
  }
  const rawAccounts = Array.isArray(res.data && res.data.accounts) ? res.data.accounts : [];
  const accounts = [];
  let currentId = null;
  for (const item of rawAccounts) {
    const clean = sanitizeAccountView(item);
    if (!clean) continue;
    if (clean.isCurrent && !currentId) {
      currentId = clean.id;
    }
    accounts.push(clean);
  }
  return {
    available: true,
    accounts,
    currentId,
    currentTarget: sanitizeSafeText(res.data && res.data.current_target, 32) || null,
    error: null,
  };
}

electronMain.removeHandler?.('telemetry:accounts-list');
electronMain.handle('telemetry:accounts-list', async (event) => {
  if (!isTrustedLocalSender(event)) {
    return { available: false, reason: 'untrusted_sender', accounts: [], currentId: null, currentTarget: null, error: null };
  }
  const cliPath = resolveSwitchCliPath();
  if (!cliPath) {
    return { available: false, reason: 'not_installed', accounts: [], currentId: null, currentTarget: null, error: null };
  }
  return await fetchSanitizedAccountsList(cliPath);
});

electronMain.removeHandler?.('telemetry:accounts-refresh');
electronMain.handle('telemetry:accounts-refresh', async (event) => {
  if (!isTrustedLocalSender(event)) {
    return { available: false, refreshed: false, accounts: [], currentId: null, error: '拒绝非本地来源请求' };
  }
  const cliPath = resolveSwitchCliPath();
  if (!cliPath) {
    return { available: false, refreshed: false, accounts: [], currentId: null, error: '未检测到 agy-switch CLI' };
  }
  if (!accountsRefreshInFlight) {
    accountsRefreshInFlight = (async () => {
      const refreshRes = await runSwitchCliJson(cliPath, ['refresh', '--json'], 40000);
      const listRes = await fetchSanitizedAccountsList(cliPath);
      if (!refreshRes.ok) {
        return {
          ...listRes,
          refreshed: false,
          refreshSummary: null,
          error: refreshRes.error || listRes.error,
        };
      }
      return {
        ...listRes,
        refreshed: true,
        refreshSummary: {
          total: Number(refreshRes.data && refreshRes.data.total) || listRes.accounts.length,
          success: Number(refreshRes.data && refreshRes.data.success) || 0,
          failed: Number(refreshRes.data && refreshRes.data.failed) || 0,
        },
        error: listRes.error,
      };
    })().finally(() => {
      accountsRefreshInFlight = null;
    });
  }
  return await accountsRefreshInFlight;
});

electronMain.removeHandler?.('telemetry:accounts-switch');
electronMain.handle('telemetry:accounts-switch', async (event, accountId) => {
  if (!isTrustedLocalSender(event)) {
    return { ok: false, error: '拒绝非本地来源请求' };
  }
  const cleanId = typeof accountId === 'string' ? accountId.trim() : '';
  if (!SWITCH_ACCOUNT_ID_RE.test(cleanId)) {
    return { ok: false, error: '无效的账号标识' };
  }
  if (accountsSwitchInFlight) {
    return { ok: false, error: '正在执行账号切换，请稍候' };
  }
  const cliPath = resolveSwitchCliPath();
  if (!cliPath) {
    return { ok: false, error: '未检测到 agy-switch CLI' };
  }
  accountsSwitchInFlight = true;
  let keepCooldown = false;
  try {
    const listRes = await fetchSanitizedAccountsList(cliPath);
    if (listRes.error) {
      return { ok: false, error: listRes.error };
    }
    const target = listRes.accounts.find((a) => a.id === cleanId);
    if (!target) {
      return { ok: false, error: '未在 agy-switch 索引中找到该账号' };
    }
    if (target.disabled || target.validationBlocked) {
      return { ok: false, error: '该账号当前已禁用或需要重新验证，无法切换' };
    }
    const spawnRes = await new Promise((resolve) => {
      try {
        const child = childProcessTelemetry.spawn(
          cliPath,
          ['switch', cleanId, '--target', 'app', '--json'],
          {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            shell: false,
          }
        );
        let settled = false;
        child.once('error', () => {
          if (!settled) {
            settled = true;
            resolve({ ok: false, error: '无法拉起 agy-switch 切换进程' });
          }
        });
        child.once('spawn', () => {
          if (!settled) {
            settled = true;
            try { child.unref(); } catch {}
            resolve({ ok: true, switching: true, accountId: cleanId });
          }
        });
      } catch {
        resolve({ ok: false, error: '拉起外部切换进程失败' });
      }
    });
    if (spawnRes && spawnRes.ok) {
      keepCooldown = true;
    }
    return spawnRes;
  } finally {
    if (keepCooldown) {
      const cdTimer = setTimeout(() => {
        accountsSwitchInFlight = false;
      }, 3000);
      if (cdTimer && typeof cdTimer.unref === 'function') {
        cdTimer.unref();
      }
    } else {
      accountsSwitchInFlight = false;
    }
  }
});
}
// === TELEMETRY_MOD_IPC_END ===
