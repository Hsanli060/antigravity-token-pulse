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
let accountsSyncInFlight = null;
let accountsSwitchInFlight = false;
let accountsDeleteInFlight = false;
let activeAddSession = null;
let switchCliCapsCache = { key: '', caps: new Set() };

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
    argonWeekly: { pct: null, resetTime: '' },
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
    const argonGroup =
      groups.find((g) => g && g !== primaryGroup && g !== secondaryGroup && /argon/i.test(String(g.display_name || ''))) ||
      groups.find((g) => g && g !== primaryGroup && g !== secondaryGroup && Array.isArray(g.buckets) && g.buckets.some((b) => b && /argon/i.test(String(b.bucket_id || '')))) ||
      null;
    const fiveRe = /(?:^|[_-])5h(?:$|[_-])|five.?hour/i;
    const weekRe = /week/i;
    const out = {
      fiveHour: primaryGroup ? extractBucketWindowSummary(primaryGroup.buckets, fiveRe) : { pct: null, resetTime: '' },
      weekly: primaryGroup ? extractBucketWindowSummary(primaryGroup.buckets, weekRe) : { pct: null, resetTime: '' },
      secondaryLabel: secondaryGroup ? sanitizeSafeText(secondaryGroup.display_name, 32) : '',
      secondaryFiveHour: secondaryGroup ? extractBucketWindowSummary(secondaryGroup.buckets, fiveRe) : { pct: null, resetTime: '' },
      secondaryWeekly: secondaryGroup ? extractBucketWindowSummary(secondaryGroup.buckets, weekRe) : { pct: null, resetTime: '' },
      argonWeekly: argonGroup ? extractBucketWindowSummary(argonGroup.buckets, weekRe) : { pct: null, resetTime: '' },
    };
    if (out.fiveHour.pct !== null || out.weekly.pct !== null || out.secondaryFiveHour.pct !== null || out.secondaryWeekly.pct !== null || out.argonWeekly.pct !== null) {
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

async function probeSwitchCliCapabilities(cliPath) {
  try {
    const st = fsTelemetry.statSync(cliPath);
    const cacheKey = `${cliPath}:${st.mtimeMs}:${st.size}`;
    if (switchCliCapsCache.key === cacheKey) {
      return switchCliCapsCache.caps;
    }
    const res = await runSwitchCliJson(cliPath, ['--version', '--json'], 2500);
    const caps = new Set();
    if (res.ok && res.data && Array.isArray(res.data.capabilities)) {
      for (const item of res.data.capabilities) {
        if (typeof item === 'string' && item.trim()) {
          caps.add(item.trim().toLowerCase());
        }
      }
    }
    switchCliCapsCache = { key: cacheKey, caps };
    return caps;
  } catch {
    return new Set();
  }
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
  const caps = await probeSwitchCliCapabilities(cliPath);
  const listRes = await fetchSanitizedAccountsList(cliPath);
  return {
    ...listRes,
    capabilities: Array.from(caps),
  };
});

electronMain.removeHandler?.('telemetry:accounts-sync');
electronMain.handle('telemetry:accounts-sync', async (event) => {
  if (!isTrustedLocalSender(event)) {
    return { available: false, synced: false, accounts: [], currentId: null, error: '拒绝非本地来源请求' };
  }
  const cliPath = resolveSwitchCliPath();
  if (!cliPath) {
    return { available: false, synced: false, accounts: [], currentId: null, error: '未检测到 agy-switch CLI' };
  }
  const caps = await probeSwitchCliCapabilities(cliPath);
  if (!caps.has('sync')) {
    const listRes = await fetchSanitizedAccountsList(cliPath);
    return {
      ...listRes,
      capabilities: Array.from(caps),
      synced: false,
      imported: false,
      changed: false,
      syncedEmail: '',
    };
  }
  if (!accountsSyncInFlight) {
    accountsSyncInFlight = (async () => {
      const syncRes = await runSwitchCliJson(cliPath, ['sync', '--json'], 20000);
      const listRes = await fetchSanitizedAccountsList(cliPath);
      if (!syncRes.ok) {
        return {
          ...listRes,
          capabilities: Array.from(caps),
          synced: false,
          imported: false,
          changed: false,
          syncedEmail: '',
          error: syncRes.error || listRes.error,
        };
      }
      return {
        ...listRes,
        capabilities: Array.from(caps),
        synced: Boolean(syncRes.data && syncRes.data.synced),
        imported: Boolean(syncRes.data && syncRes.data.imported),
        changed: Boolean(syncRes.data && syncRes.data.changed),
        syncedEmail: sanitizeSafeText(syncRes.data && syncRes.data.email, 160),
        error: listRes.error,
      };
    })().finally(() => {
      accountsSyncInFlight = null;
    });
  }
  return await accountsSyncInFlight;
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
  if (activeAddSession) {
    const prevAdd = activeAddSession;
    activeAddSession = null;
    prevAdd.state = 'cancelled';
    terminateAddSession(prevAdd);
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

function resolveSwitchDataDir(homeDir) {
  const envDir = typeof process.env.ABV_DATA_DIR === 'string' ? process.env.ABV_DATA_DIR.trim() : '';
  if (envDir) {
    return pathTelemetry.resolve(envDir);
  }
  return pathTelemetry.join(homeDir, '.antigravity_tools');
}

function isSwitchLockBusy(dataDir) {
  try {
    const lockPath = pathTelemetry.join(dataDir, 'account-switch.lock');
    if (!fsTelemetry.existsSync(lockPath)) {
      return false;
    }
    const fd = fsTelemetry.openSync(lockPath, 'r+');
    try {
      fsTelemetry.closeSync(fd);
    } catch {}
    return false;
  } catch (err) {
    const code = err && err.code;
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
  }
}

const SILENT_GOOGLE_AUTH_URL_RE = /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s\u0000-\u001f\u007f]+$/;

const SILENT_WIN_CONPTY_CS = String.raw`
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class AgySilentAddDriver {
    const uint PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const int STARTF_USESTDHANDLES = 0x00000100;
    static volatile bool _cancelled = false;

    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle hReadPipe, out SafeFileHandle hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, int nSize);
    [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC);
    [DllImport("kernel32.dll", SetLastError = true)] static extern void ClosePseudoConsole(IntPtr hPC);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);
    [DllImport("kernel32.dll", SetLastError = true)] static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    static void Emit(string json) {
        Console.WriteLine(json);
        Console.Out.Flush();
    }

    static string JsonEscape(string s) {
        if (s == null) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "");
    }

    public static void Run(string exePath) {
        _cancelled = false;
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = 0 };
        SafeFileHandle ptyInRead, ptyInWrite, ptyOutRead, ptyOutWrite;
        if (!CreatePipe(out ptyInRead, out ptyInWrite, ref sa, 0)) throw new Exception("CreatePipe in failed");
        if (!CreatePipe(out ptyOutRead, out ptyOutWrite, ref sa, 0)) throw new Exception("CreatePipe out failed");

        IntPtr hPC;
        int hr = CreatePseudoConsole(new COORD { X = 512, Y = 36 }, ptyInRead, ptyOutWrite, 0, out hPC);
        if (hr != 0) throw new Exception("CreatePseudoConsole failed: 0x" + hr.ToString("X"));
        ptyInRead.Dispose();
        ptyOutWrite.Dispose();

        IntPtr attrSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
        IntPtr attrList = Marshal.AllocHGlobal(attrSize);
        if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize)) throw new Exception("InitAttr failed");
        if (!UpdateProcThreadAttribute(attrList, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new Exception("UpdateAttr failed");

        STARTUPINFOEX si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.lpAttributeList = attrList;

        PROCESS_INFORMATION pi;
        StringBuilder cmd = new StringBuilder("\"" + exePath + "\"");
        bool ok = CreateProcessW(exePath, cmd, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, null, ref si, out pi);
        DeleteProcThreadAttributeList(attrList);
        Marshal.FreeHGlobal(attrList);
        if (!ok) {
            ClosePseudoConsole(hPC);
            throw new Exception("CreateProcessW failed: " + Marshal.GetLastWin32Error());
        }

        var stdinThread = new Thread(() => {
            try {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    if (line.Trim().Equals("CANCEL", StringComparison.OrdinalIgnoreCase)) {
                        _cancelled = true;
                        break;
                    }
                }
                _cancelled = true;
            } catch { _cancelled = true; }
        });
        stdinThread.IsBackground = true;
        stdinThread.Start();

        var outStream = new FileStream(ptyOutRead, FileAccess.Read);
        var inStream = new FileStream(ptyInWrite, FileAccess.Write);
        var sb = new StringBuilder();
        var readerThread = new Thread(() => {
            byte[] buf = new byte[4096];
            try {
                int n;
                while ((n = outStream.Read(buf, 0, buf.Length)) > 0) {
                    string chunk = Encoding.UTF8.GetString(buf, 0, n);
                    lock (sb) { sb.Append(chunk); }
                }
            } catch {}
        });
        readerThread.IsBackground = true;
        readerThread.Start();

        try {
            bool sent4 = false;
            bool sent1 = false;
            bool sentUrl = false;
            var ansiRe = new Regex(@"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)");
            var urlRe = new Regex(@"https://accounts\.google\.com/o/oauth2/v2/auth\?[^\s\x00-\x1f\x7f]+");
            var deadline = DateTime.UtcNow.AddSeconds(310);
            while (!_cancelled && DateTime.UtcNow < deadline) {
                string cur;
                lock (sb) { cur = sb.ToString(); }
                string plain = ansiRe.Replace(cur, "");
                if (!sent4 && (plain.Contains("添加账号") || plain.Contains("Add Account"))) {
                    byte[] b = Encoding.ASCII.GetBytes("4");
                    inStream.Write(b, 0, b.Length);
                    inStream.Flush();
                    sent4 = true;
                } else if (sent4 && !sent1 && (plain.Contains("浏览器一键授权") || plain.Contains("Browser authorization"))) {
                    byte[] b = Encoding.ASCII.GetBytes("1");
                    inStream.Write(b, 0, b.Length);
                    inStream.Flush();
                    sent1 = true;
                } else if (sent1) {
                    if (!sentUrl && (plain.Contains("等待浏览器授权") || plain.Contains("Waiting for browser"))) {
                        var m = urlRe.Match(plain);
                        if (m.Success && m.Value.Contains("state=")) {
                            sentUrl = true;
                            Emit("{\"event\":\"auth_url\",\"url\":\"" + JsonEscape(m.Value) + "\"}");
                        }
                    }
                    if (plain.Contains("账号添加成功") || plain.Contains("Account added successfully")) {
                        Thread.Sleep(80);
                        Emit("{\"event\":\"success\"}");
                        break;
                    }
                    if (plain.Contains("无法启动授权服务") || plain.Contains("Could not start authorization")) {
                        Emit("{\"event\":\"error\",\"message\":\"无法启动本地授权服务，请检查网络代理后重试\"}");
                        break;
                    }
                    if (plain.Contains("授权未完成") || plain.Contains("Authorization did not complete")) {
                        Emit("{\"event\":\"error\",\"message\":\"浏览器授权未完成或已超时，请重试\"}");
                        break;
                    }
                    if (plain.Contains("未能获取到 Refresh Token") || plain.Contains("Failed to obtain Refresh Token")) {
                        Emit("{\"event\":\"error\",\"message\":\"未能获取到 Refresh Token，请先撤销旧授权后重试\"}");
                        break;
                    }
                    if (plain.Contains("无法添加账号") || plain.Contains("Could not add the account")) {
                        Emit("{\"event\":\"error\",\"message\":\"授权回调后添加账号失败，请检查网络代理后重试\"}");
                        break;
                    }
                }
                if (WaitForSingleObject(pi.hProcess, 0) == 0) break;
                Thread.Sleep(40);
            }
            if (_cancelled) Emit("{\"event\":\"cancelled\"}");
        } finally {
            try { TerminateProcess(pi.hProcess, 0); } catch {}
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            ClosePseudoConsole(hPC);
            try { inStream.Dispose(); } catch {}
            try { outStream.Dispose(); } catch {}
        }
    }
}
`;

const SILENT_UNIX_PTY_PY = String.raw`
import json, os, pty, re, select, signal, subprocess, sys, time
exe = os.environ.get('AGY_SWITCH_BIN', '')
master, slave = pty.openpty()
proc = subprocess.Popen([exe], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
buf = ''
sent4 = False
sent1 = False
sent_url = False
ansi_re = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')
url_re = re.compile(r'https://accounts\.google\.com/o/oauth2/v2/auth\?[^\s\x00-\x1f\x7f]+')
deadline = time.time() + 310
def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()
try:
    while time.time() < deadline:
        rlist, _, _ = select.select([master, sys.stdin], [], [], 0.05)
        if sys.stdin in rlist:
            line = sys.stdin.readline()
            if not line or line.strip().upper() == 'CANCEL':
                emit({'event': 'cancelled'})
                break
        if master in rlist:
            try:
                data = os.read(master, 4096)
            except OSError:
                break
            if not data:
                break
            buf += data.decode('utf-8', errors='ignore')
            plain = ansi_re.sub('', buf)
            if not sent4 and ('添加账号' in plain or 'Add Account' in plain):
                os.write(master, b'4')
                sent4 = True
            elif sent4 and not sent1 and ('浏览器一键授权' in plain or 'Browser authorization' in plain):
                os.write(master, b'1')
                sent1 = True
            elif sent1:
                if not sent_url and ('等待浏览器授权' in plain or 'Waiting for browser' in plain):
                    m = url_re.search(plain)
                    if m and 'state=' in m.group(0):
                        sent_url = True
                        emit({'event': 'auth_url', 'url': m.group(0)})
                if '账号添加成功' in plain or 'Account added successfully' in plain:
                    time.sleep(0.08)
                    emit({'event': 'success'})
                    break
                if '无法启动授权服务' in plain or 'Could not start authorization' in plain:
                    emit({'event': 'error', 'message': '无法启动本地授权服务，请检查网络代理后重试'})
                    break
                if '授权未完成' in plain or 'Authorization did not complete' in plain:
                    emit({'event': 'error', 'message': '浏览器授权未完成或已超时，请重试'})
                    break
                if '未能获取到 Refresh Token' in plain or 'Failed to obtain Refresh Token' in plain:
                    emit({'event': 'error', 'message': '未能获取到 Refresh Token，请先撤销旧授权后重试'})
                    break
                if '无法添加账号' in plain or 'Could not add the account' in plain:
                    emit({'event': 'error', 'message': '授权回调后添加账号失败，请检查网络代理后重试'})
                    break
        if proc.poll() is not None:
            break
finally:
    try:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=0.5)
            except Exception:
                proc.kill()
    except Exception:
        pass
    try:
        os.close(master)
    except Exception:
        pass
`;

function terminateAddSession(session) {
  if (!session) return;
  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
    session.timeoutTimer = null;
  }
  const child = session.child;
  session.child = null;
  if (!child) return;
  try {
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.write('CANCEL\n');
      child.stdin.end();
    }
  } catch {}
  const killTimer = setTimeout(() => {
    try {
      if (!child.killed) {
        child.kill();
      }
    } catch {}
  }, 500);
  if (killTimer && typeof killTimer.unref === 'function') {
    killTimer.unref();
  }
}

function getElectronShellSafe() {
  try {
    if (typeof electron_1 !== 'undefined' && electron_1.shell) {
      return electron_1.shell;
    }
    return require('electron').shell || null;
  } catch {
    return null;
  }
}

function startSilentAddSession(cliPath, baselineIds, useNativeAdd) {
  let cmd = '';
  let args = [];
  let env = { ...process.env, AGY_SWITCH_BIN: cliPath };
  if (useNativeAdd) {
    cmd = cliPath;
    args = ['add', '--json'];
  } else if (process.platform === 'win32') {
    const sysRoot = typeof process.env.SystemRoot === 'string' ? process.env.SystemRoot.trim() : '';
    const psCandidate = sysRoot
      ? pathTelemetry.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : '';
    cmd = psCandidate && fsTelemetry.existsSync(psCandidate) ? psCandidate : 'powershell.exe';
    const psCmd = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AGY_SWITCH_CS_B64)); Add-Type -TypeDefinition $s -Language CSharp; [AgySilentAddDriver]::Run($env:AGY_SWITCH_BIN)";
    args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCmd];
    env.AGY_SWITCH_CS_B64 = Buffer.from(SILENT_WIN_CONPTY_CS, 'utf8').toString('base64');
  } else {
    cmd = 'python3';
    args = ['-u', '-c', SILENT_UNIX_PTY_PY];
  }

  let child;
  try {
    child = childProcessTelemetry.spawn(cmd, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
  } catch {
    return null;
  }

  const session = {
    cliPath,
    child,
    state: 'starting', // 'starting' | 'waiting_browser' | 'finalizing' | 'done' | 'error' | 'cancelled'
    authUrl: '',
    error: '',
    addedLabel: '',
    accounts: null,
    currentId: null,
    baselineIds: new Set(baselineIds || []),
    startedAt: Date.now(),
    timeoutTimer: null,
    readyWaiters: [],
  };

  const notifyReady = () => {
    const waiters = session.readyWaiters.splice(0, session.readyWaiters.length);
    for (const fn of waiters) {
      try { fn(); } catch {}
    }
  };

  let lineBuf = '';
  const handleDriverEvent = async (evt) => {
    if (!evt || typeof evt !== 'object') return;
    if (evt.event === 'auth_url' && typeof evt.url === 'string' && SILENT_GOOGLE_AUTH_URL_RE.test(evt.url.trim())) {
      session.authUrl = evt.url.trim();
      if (session.state === 'starting') {
        session.state = 'waiting_browser';
      }
      notifyReady();
    } else if (evt.event === 'success') {
      if (session.state === 'done' || session.state === 'finalizing' || session.state === 'cancelled') return;
      session.state = 'finalizing';
      terminateAddSession(session);
      const listRes = await fetchSanitizedAccountsList(cliPath);
      const nextAccounts = Array.isArray(listRes.accounts) ? listRes.accounts : [];
      const addedObj = nextAccounts.find((a) => a && !session.baselineIds.has(a.id)) || null;
      session.accounts = nextAccounts;
      session.currentId = listRes.currentId || null;
      session.addedLabel = addedObj ? (addedObj.label || addedObj.email || addedObj.name || addedObj.id) : '';
      session.error = listRes.error || '';
      session.state = 'done';
      notifyReady();
    } else if (evt.event === 'error') {
      if (session.state === 'done' || session.state === 'finalizing' || session.state === 'cancelled') return;
      session.state = 'error';
      session.error = sanitizeSafeText(evt.message, 180) || '后台授权添加账号失败，请重试';
      terminateAddSession(session);
      notifyReady();
    } else if (evt.event === 'cancelled') {
      if (session.state !== 'done' && session.state !== 'finalizing' && session.state !== 'error') {
        session.state = 'cancelled';
      }
      notifyReady();
    }
  };

  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      lineBuf += String(chunk || '');
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() || '';
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        try {
          void handleDriverEvent(JSON.parse(trimmed));
        } catch {}
      }
    });
  }

  child.once('error', () => {
    if (session.state === 'starting' || session.state === 'waiting_browser') {
      session.state = 'error';
      session.error = '无法启动后台静默授权进程，请确认系统环境正常';
      terminateAddSession(session);
      notifyReady();
    }
  });

  child.once('close', () => {
    if (session.timeoutTimer) {
      clearTimeout(session.timeoutTimer);
      session.timeoutTimer = null;
    }
    session.child = null;
    if (session.state === 'starting' || session.state === 'waiting_browser') {
      session.state = 'error';
      session.error = '后台授权流程已中断，请重试';
      notifyReady();
    }
  });

  session.timeoutTimer = setTimeout(() => {
    if (session.state === 'starting' || session.state === 'waiting_browser') {
      session.state = 'error';
      session.error = '浏览器授权超时，请重新点击添加账号';
      terminateAddSession(session);
      notifyReady();
    }
  }, 315000);
  if (session.timeoutTimer && typeof session.timeoutTimer.unref === 'function') {
    session.timeoutTimer.unref();
  }

  return session;
}

electronMain.removeHandler?.('telemetry:accounts-add');
electronMain.handle('telemetry:accounts-add', async (event) => {
  if (!isTrustedLocalSender(event)) {
    return { ok: false, error: '拒绝非本地来源请求' };
  }
  if (accountsSwitchInFlight || accountsDeleteInFlight) {
    return { ok: false, error: '当前正在执行账号操作，请稍后再添加' };
  }
  if (activeAddSession && (activeAddSession.state === 'starting' || activeAddSession.state === 'waiting_browser' || activeAddSession.state === 'finalizing')) {
    return {
      ok: true,
      state: activeAddSession.state,
      authUrl: activeAddSession.authUrl || '',
      startedAt: activeAddSession.startedAt,
    };
  }
  const cliPath = resolveSwitchCliPath();
  if (!cliPath || !isValidSwitchCliBinary(cliPath)) {
    return { ok: false, error: '未检测到 agy-switch CLI' };
  }
  const caps = await probeSwitchCliCapabilities(cliPath);
  const curList = await fetchSanitizedAccountsList(cliPath);
  const baselineIds = (curList.accounts || []).map((a) => a && a.id).filter(Boolean);
  const session = startSilentAddSession(cliPath, baselineIds, caps.has('add'));
  if (!session) {
    return { ok: false, error: '无法启动后台静默授权进程' };
  }
  activeAddSession = session;

  await new Promise((resolve) => {
    if (session.state !== 'starting') {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 6000);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    session.readyWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });

  if (session.state === 'error') {
    const err = session.error || '后台授权启动失败';
    if (activeAddSession === session) {
      activeAddSession = null;
    }
    return { ok: false, error: err };
  }
  if (session.state === 'cancelled') {
    if (activeAddSession === session) {
      activeAddSession = null;
    }
    return { ok: false, cancelled: true, error: '' };
  }
  return {
    ok: true,
    state: session.state,
    authUrl: session.authUrl || '',
    startedAt: session.startedAt,
  };
});

electronMain.removeHandler?.('telemetry:accounts-add-status');
electronMain.handle('telemetry:accounts-add-status', async (event) => {
  if (!isTrustedLocalSender(event)) {
    return { active: false, state: 'idle' };
  }
  const s = activeAddSession;
  if (!s) {
    return { active: false, state: 'idle' };
  }
  if (s.state === 'done') {
    activeAddSession = null;
    return {
      active: false,
      state: 'done',
      addedLabel: s.addedLabel || '',
      accounts: s.accounts || [],
      currentId: s.currentId || null,
      error: s.error || null,
    };
  }
  if (s.state === 'error') {
    const err = s.error || '添加账号失败';
    activeAddSession = null;
    return { active: false, state: 'error', error: err };
  }
  if (s.state === 'cancelled') {
    activeAddSession = null;
    return { active: false, state: 'cancelled' };
  }
  return {
    active: true,
    state: s.state,
    authUrl: s.authUrl || '',
    startedAt: s.startedAt,
  };
});

electronMain.removeHandler?.('telemetry:accounts-add-cancel');
electronMain.handle('telemetry:accounts-add-cancel', async (event) => {
  if (!isTrustedLocalSender(event)) {
    return { ok: false };
  }
  const s = activeAddSession;
  activeAddSession = null;
  if (s) {
    s.state = 'cancelled';
    terminateAddSession(s);
  }
  return { ok: true, cancelled: true };
});

electronMain.removeHandler?.('telemetry:accounts-add-open');
electronMain.handle('telemetry:accounts-add-open', async (event) => {
  if (!isTrustedLocalSender(event)) {
    return { ok: false, error: '拒绝非本地来源请求' };
  }
  const s = activeAddSession;
  if (!s || !s.authUrl || !SILENT_GOOGLE_AUTH_URL_RE.test(s.authUrl)) {
    return { ok: false, error: '当前没有进行中的授权链接' };
  }
  const shellObj = getElectronShellSafe();
  if (!shellObj || typeof shellObj.openExternal !== 'function') {
    return { ok: false, error: '无法调起系统浏览器，请使用复制链接手动打开' };
  }
  try {
    await shellObj.openExternal(s.authUrl);
    return { ok: true };
  } catch {
    return { ok: false, error: '打开浏览器失败，请复制授权链接手动访问' };
  }
});

electronMain.removeHandler?.('telemetry:accounts-delete');
electronMain.handle('telemetry:accounts-delete', async (event, accountId) => {
  if (!isTrustedLocalSender(event)) {
    return { ok: false, error: '拒绝非本地来源请求' };
  }
  const cleanId = typeof accountId === 'string' ? accountId.trim() : '';
  if (!SWITCH_ACCOUNT_ID_RE.test(cleanId)) {
    return { ok: false, error: '无效的账号标识' };
  }
  if (accountsSwitchInFlight) {
    return { ok: false, error: '正在执行账号切换，请稍后再删除' };
  }
  if (accountsDeleteInFlight) {
    return { ok: false, error: '正在删除其他账号，请稍候' };
  }
  if (activeAddSession) {
    const prevAdd = activeAddSession;
    activeAddSession = null;
    prevAdd.state = 'cancelled';
    terminateAddSession(prevAdd);
  }
  const cliPath = resolveSwitchCliPath();
  if (!cliPath) {
    return { ok: false, error: '未检测到 agy-switch CLI' };
  }
  const caps = await probeSwitchCliCapabilities(cliPath);
  if (caps.has('delete')) {
    accountsDeleteInFlight = true;
    try {
      const delRes = await runSwitchCliJson(cliPath, ['delete', cleanId, '--json'], 8000);
      if (!delRes.ok) {
        return { ok: false, error: delRes.error || '删除账号失败' };
      }
    } finally {
      accountsDeleteInFlight = false;
    }
    const listRes = await fetchSanitizedAccountsList(cliPath);
    return {
      ok: true,
      deletedId: cleanId,
      capabilities: Array.from(caps),
      ...listRes,
    };
  }
  const homeDir = osTelemetry.homedir();
  const dataDir = resolveSwitchDataDir(homeDir);
  if (isSwitchLockBusy(dataDir)) {
    return { ok: false, error: '检测到 agy-switch 正在执行切换，请稍后再删除' };
  }
  accountsDeleteInFlight = true;
  const lockPath = pathTelemetry.join(dataDir, 'accounts.json.telemetry.lock');
  let hasLock = false;
  try {
    const indexPath = pathTelemetry.join(dataDir, 'accounts.json');
    if (!fsTelemetry.existsSync(indexPath)) {
      return { ok: false, error: '未找到本地账号索引文件 (accounts.json)' };
    }
    hasLock = await acquireFileLockAsync(lockPath, 1200);
    if (!hasLock) {
      return { ok: false, error: '账号索引文件正忙，请稍后重试' };
    }
    const rawText = stripBom(await fsTelemetry.promises.readFile(indexPath, 'utf-8')).replace(/^\u0000+/, '');
    let indexData;
    try {
      indexData = JSON.parse(rawText);
    } catch {
      return { ok: false, error: '本地账号索引格式异常，请先在外部 agy-switch 检查' };
    }
    if (!indexData || typeof indexData !== 'object' || !Array.isArray(indexData.accounts)) {
      return { ok: false, error: '本地账号索引结构无效' };
    }
    const origLen = indexData.accounts.length;
    indexData.accounts = indexData.accounts.filter((entry) => entry && entry.id !== cleanId);
    if (indexData.accounts.length === origLen) {
      return { ok: false, error: '未在本地账号索引中找到该账号' };
    }
    if (indexData.current_ide_account_id === cleanId) {
      delete indexData.current_ide_account_id;
    }
    if (indexData.current_vscode_account_id === cleanId) {
      delete indexData.current_vscode_account_id;
    }
    if (indexData.current_account_id === cleanId) {
      indexData.current_account_id = indexData.accounts.length > 0 ? indexData.accounts[0].id : null;
    }
    await atomicWriteFileAsync(indexPath, JSON.stringify(indexData, null, 2));

    const accountsDir = pathTelemetry.resolve(dataDir, 'accounts');
    const accountFile = pathTelemetry.resolve(accountsDir, `${cleanId}.json`);
    if (pathTelemetry.dirname(accountFile) === accountsDir) {
      try {
        const st = fsTelemetry.lstatSync(accountFile);
        if (st.isFile() && !st.isSymbolicLink()) {
          fsTelemetry.unlinkSync(accountFile);
        }
      } catch (err) {
        if (!err || err.code !== 'ENOENT') {
          throw err;
        }
      }
    }
  } catch {
    return { ok: false, error: '删除本地账号记录失败，请检查文件权限' };
  } finally {
    if (hasLock) {
      releaseFileLockSync(lockPath);
    }
    accountsDeleteInFlight = false;
  }
  const listRes = await fetchSanitizedAccountsList(cliPath);
  return {
    ok: true,
    deletedId: cleanId,
    ...listRes,
  };
});
}
// === TELEMETRY_MOD_IPC_END ===
