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
}
// === TELEMETRY_MOD_IPC_END ===
