#!/usr/bin/env node
// === TELEMETRY_MOD_CLI_STATUSLINE ===
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fileURLToPath } = require('url');

const FIXED_MAX_TOKENS = 1000000; // 统一固定 1M 上下文窗口
const SPEED_CACHE_PATH = path.join(os.tmpdir(), 'agy-cli-telemetry-cache.json');
const ACTIVITY_CACHE_PATH = path.join(os.homedir(), '.gemini', 'telemetry-activity-cache.json');

function formatCompactTokens(num) {
  if (num == null || !Number.isFinite(Number(num)) || Number(num) <= 0) {
    return '0';
  }
  const n = Number(num);
  if (n >= 1000000) {
    return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (n >= 1000) {
    return Math.round(n / 1000) + 'k';
  }
  return String(Math.round(n));
}

function getRingChar(pct) {
  if (pct <= 0) return '○';
  if (pct < 30) return '◔';
  if (pct < 60) return '◑';
  if (pct < 90) return '◕';
  return '●';
}

function normalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  const trimmed = p.trim();
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return trimmed.replace(/^file:\/\/\/?/, '');
    }
  }
  return trimmed;
}

function normalizeModelName(rawDisplay, rawInternal) {
  const d = String(rawDisplay || '').trim();
  if (d && !/^[0-9a-f]{16,64}$/i.test(d)) {
    let name = d.replace(/\s*\((?:XHigh|High|Medium|Low|Max|Thinking|Fast|Slow|Standard|Preview|Experimental)\)\s*$/i, '').trim();
    if (/^Orchestrator\s*\(([^)]+)\)$/i.test(name)) {
      name = 'Gemini 4 ' + name.match(/^Orchestrator\s*\(([^)]+)\)$/i)[1].trim();
    }
    return name;
  }
  const intern = String(rawInternal || '').trim();
  if (intern && !/^[0-9a-f]{16,64}$/i.test(intern)) {
    if (/^gemini-pro-orchestrator-g1-pro$/i.test(intern)) return 'Gemini 4 Argon';
    let s = intern.replace(/(\d)-(\d)/g, '$1.$2');
    const suffixRe = /-(?:tiered|trial|preview|exp|latest|high|medium|low|xhigh|max|thinking|control|n|h|a|b|c|worker-agy|orchestrator-g1-pro)$/gi;
    s = s.replace(suffixRe, '').replace(suffixRe, '');
    const parts = s.split('-').filter(Boolean).map((w) => {
      if (/^gpt$/i.test(w)) return 'GPT';
      if (/^\d/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
    const res = parts.join(' ').trim();
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
      if (!fs.existsSync(filePath)) continue;
      stat = fs.statSync(filePath);
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
      fd = fs.openSync(filePath, 'r');
      const chunkBuf = Buffer.allocUnsafe(stat.size <= CHUNK_SIZE ? stat.size : (CHUNK_SIZE + KEEP));
      let filePos = 0;
      let carryLen = 0;
      while (filePos < stat.size) {
        const maxRead = Math.min(CHUNK_SIZE, stat.size - filePos, chunkBuf.length - carryLen);
        if (maxRead <= 0) break;
        const bytesRead = fs.readSync(fd, chunkBuf, carryLen, maxRead, filePos);
        if (bytesRead <= 0) break;
        filePos += bytesRead;
        const totalLen = carryLen + bytesRead;
        const isLast = filePos >= stat.size;
        const scanEnd = isLast ? totalLen : totalLen - MARGIN;
        let offset = carryLen > 0 ? Math.max(0, carryLen - MARGIN) : 0;
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
                const intStart = Math.max(0, idx - 650);
                for (let k = intStart; k <= idx - 3; k++) {
                  if (chunkBuf[k] === 0x9a && chunkBuf[k + 1] === 0x01) {
                    const mlen = chunkBuf[k + 2];
                    if (mlen >= 4 && mlen <= 64 && k + 3 + mlen <= idx) {
                      const s = chunkBuf.slice(k + 3, k + 3 + mlen).toString('utf8');
                      if (/^[a-z][a-z0-9._-]+$/i.test(s) && !/^[0-9a-f]{16,64}$/i.test(s)) {
                        rawInternal = s;
                      }
                    }
                  }
                }
                let rawDisplay = '';
                const winEnd = Math.min(totalLen, idx + 650);
                for (let k = idx + needleLsi.length; k <= winEnd - 3; k++) {
                  if (chunkBuf[k] === 0xaa && chunkBuf[k + 1] === 0x01) {
                    const dlen = chunkBuf[k + 2];
                    if (dlen >= 4 && dlen <= 64 && k + 3 + dlen <= winEnd) {
                      const s = chunkBuf.slice(k + 3, k + 3 + dlen).toString('utf8');
                      if (/^[A-Za-z][A-Za-z0-9 ._()\-+/]+$/.test(s) && !/^[0-9a-f]{16,64}$/i.test(s)) {
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
          offset = idx + needleLsi.length;
        }
        if (isLast) break;
        carryLen = Math.min(KEEP, totalLen);
        chunkBuf.copy(chunkBuf, 0, totalLen - carryLen, totalLen);
      }
    } catch {
      continue;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
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
  return (modelInfo && modelInfo.defaultModel) || fallbackModel || '其他模型';
}

function resolveTranscriptPath(rawPath, convId) {
  const normalized = normalizePath(rawPath);
  if (normalized && fs.existsSync(normalized)) {
    return normalized;
  }
  if (!convId) return '';
  const candidates = [
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl'),
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

function toLocalDayKey(dt) {
  return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function addDailyBucket(dailyBuckets, row, inTok, cacheTok, outTok, fallbackMs, modelName) {
  const rowTotal = inTok + cacheTok + outTok;
  if (rowTotal <= 0) return;
  let dt = row.created_at ? new Date(row.created_at) : new Date(fallbackMs);
  if (Number.isNaN(dt.getTime())) {
    dt = new Date(fallbackMs);
  }
  const dayKey = toLocalDayKey(dt);
  if (!dailyBuckets[dayKey]) {
    dailyBuckets[dayKey] = { in: 0, cache: 0, out: 0, total: 0, steps: 0, models: {} };
  }
  dailyBuckets[dayKey].in += inTok;
  dailyBuckets[dayKey].cache += cacheTok;
  dailyBuckets[dayKey].out += outTok;
  dailyBuckets[dayKey].total += rowTotal;
  dailyBuckets[dayKey].steps += 1;

  const mName = modelName || '其他模型';
  if (!dailyBuckets[dayKey].models) {
    dailyBuckets[dayKey].models = {};
  }
  if (!dailyBuckets[dayKey].models[mName]) {
    dailyBuckets[dayKey].models[mName] = { in: 0, cache: 0, out: 0, total: 0, steps: 0 };
  }
  dailyBuckets[dayKey].models[mName].in += inTok;
  dailyBuckets[dayKey].models[mName].cache += cacheTok;
  dailyBuckets[dayKey].models[mName].out += outTok;
  dailyBuckets[dayKey].models[mName].total += rowTotal;
  dailyBuckets[dayKey].models[mName].steps += 1;
}

function parseTranscriptStats(transcriptPath, convId, fallbackModel) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return null;
    }
    const stat = fs.statSync(transcriptPath);
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n');
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // ignore malformed line
      }
    }

    let modelInfo = null;
    const resolvedConvId = typeof convId === 'string' && /^[a-zA-Z0-9_-]+$/.test(convId) ? convId : null;
    if (resolvedConvId) {
      const cliConvDbPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations', `${resolvedConvId}.db`);
      modelInfo = extractConvModelMap(cliConvDbPath);
    }

    let sumInputTokens = 0;
    let sumCacheTokens = 0;
    let sumOutputTokens = 0;
    let latestStepTps = 0;
    let baseInstructionTokens = 16000;
    let firstPlannerSeen = false;
    let latestPlanner = null;
    let compactedContextUsed = null;
    const dailyBuckets = {};

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
        const stepIdx = Number(row.step_index) || 0;
        const modelName = resolveStepModel(stepIdx, modelInfo, fallbackModel);
        addDailyBucket(dailyBuckets, row, inTok, cacheTok, outTok, stat.mtimeMs, modelName);

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
        };
        compactedContextUsed = null;
      } else if (row.type === 'CHECKPOINT') {
        const cpIn = Number(row.input_tokens) || 0;
        const cpCache = Number(row.cache_read_tokens) || 0;
        const cpOut = Number(row.output_tokens) || 0;
        sumInputTokens += cpIn;
        sumCacheTokens += cpCache;
        sumOutputTokens += cpOut;
        const stepIdx = Number(row.step_index) || 0;
        const modelName = resolveStepModel(stepIdx, modelInfo, fallbackModel);
        addDailyBucket(dailyBuckets, row, cpIn, cpCache, cpOut, stat.mtimeMs, modelName);
        const summaryTokens = cpOut > 0
          ? cpOut
          : Math.round(String(row.content || '').length / 3.6);
        compactedContextUsed = baseInstructionTokens + summaryTokens;
      }
    }

    const tokensPerSecond = latestStepTps;
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
    } else if (compactedContextUsed !== null) {
      latestContextUsed = compactedContextUsed;
    }

    return {
      tokensPerSecond,
      cacheHitRate,
      cumulativePromptTokens,
      cumulativeTokens: sumInputTokens + sumCacheTokens + sumOutputTokens,
      latestContextUsed,
      compactedJustNow: compactedContextUsed !== null,
      dailyBuckets,
      statMtimeMs: stat.mtimeMs,
      statSize: stat.size,
      dbSize: modelInfo ? modelInfo.dbSize : 0,
    };
  } catch {
    return null;
  }
}

function updateAndReadSpeedCache(convId, totalOutTokens, transcriptSpeed) {
  if (!convId) return transcriptSpeed || 0;
  try {
    let cache = {};
    if (fs.existsSync(SPEED_CACHE_PATH)) {
      cache = JSON.parse(fs.readFileSync(SPEED_CACHE_PATH, 'utf8')) || {};
    }
    const now = Date.now();
    const prev = cache[convId] || {};
    let speed = transcriptSpeed > 0 ? transcriptSpeed : (prev.speed || 0);

    if (totalOutTokens > 0 && prev.outTokens > 0 && totalOutTokens > prev.outTokens && prev.ts > 0) {
      const dt = (now - prev.ts) / 1000;
      const dOut = totalOutTokens - prev.outTokens;
      if (dt >= 0.3 && dt <= 60) {
        const liveTps = Math.round(dOut / dt);
        if (liveTps >= 5 && liveTps <= 350 && !(transcriptSpeed > 0)) {
          speed = liveTps;
        }
      }
    }

    if (transcriptSpeed > 0) {
      speed = transcriptSpeed;
    }

    cache[convId] = {
      outTokens: totalOutTokens || prev.outTokens || 0,
      ts: totalOutTokens !== prev.outTokens ? now : (prev.ts || now),
      speed,
    };
    fs.writeFileSync(SPEED_CACHE_PATH, JSON.stringify(cache), 'utf8');
    return speed;
  } catch {
    return transcriptSpeed || 0;
  }
}

function syncActivityLedgerCache(convId, tStats) {
  if (!convId || typeof convId !== 'string' || !tStats || !tStats.dailyBuckets) {
    return;
  }
  try {
    let cache = { version: 4, conversations: {} };
    if (fs.existsSync(ACTIVITY_CACHE_PATH)) {
      const raw = fs.readFileSync(ACTIVITY_CACHE_PATH, 'utf8');
      if (raw && raw.trim()) {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        if (parsed && typeof parsed === 'object' && parsed.version === 4 && parsed.conversations && typeof parsed.conversations === 'object') {
          cache = { version: 4, conversations: parsed.conversations };
        }
      }
    }

    const key = `cli:${convId}`;
    const prev = cache.conversations[key];
    const targetDbSize = Number(tStats.dbSize) || 0;
    if (
      prev &&
      prev.mtimeMs === tStats.statMtimeMs &&
      prev.size === tStats.statSize &&
      prev.dbSize === targetDbSize &&
      prev.daily &&
      typeof prev.daily === 'object'
    ) {
      return;
    }

    cache.conversations[key] = {
      mtimeMs: tStats.statMtimeMs,
      size: tStats.statSize,
      dbSize: targetDbSize,
      source: 'cli',
      daily: tStats.dailyBuckets,
    };

    const cacheDir = path.dirname(ACTIVITY_CACHE_PATH);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    const payload = JSON.stringify(cache);
    const tmpPath = `${ACTIVITY_CACHE_PATH}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, payload, 'utf8');
      try {
        fs.renameSync(tmpPath, ACTIVITY_CACHE_PATH);
      } catch {
        fs.writeFileSync(ACTIVITY_CACHE_PATH, payload, 'utf8');
      }
    } finally {
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // ignore cleanup error
      }
    }
  } catch {
    // non-blocking
  }
}

function resolveModelLabel(data) {
  let displayName = (data.model && data.model.display_name) || '';
  let effort = (data.model && data.model.effort) || '';

  if (!displayName) {
    try {
      const settingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (typeof s.model === 'string') {
          displayName = s.model;
        }
      }
    } catch {
      // ignore
    }
  }
  if (!displayName) {
    displayName = 'Gemini 4 Argon';
  }

  const match = displayName.match(/^(.*?)\s*\((Low|Medium|High|Max)\)\s*$/i);
  if (match) {
    displayName = match[1].trim();
    if (!effort) {
      effort = match[2].toLowerCase();
    }
  }

  const cleanEffort = String(effort || '').trim().toLowerCase();
  return cleanEffort ? `${displayName} · ${cleanEffort}` : displayName;
}

function resolveLeftHint(data) {
  const state = String(data.agent_state || 'idle').toLowerCase();
  if (state && state !== 'idle') {
    return 'esc to cancel';
  }
  return '? for shortcuts';
}

function renderSingleLine(data, speed, usedTokens, pct, cacheHit, totalTokens) {
  const FG = '\x1b[38;2;145;145;156m';       // #91919C 指标文字与单色图标
  const DOT = '\x1b[38;2;118;120;134m';      // #767886 分隔圆点
  const NATIVE = '\x1b[38;2;118;118;118m';   // #767676 原生快捷键提示与模型名
  const RST = '\x1b[0m';

  const leftText = resolveLeftHint(data);
  const modelText = resolveModelLabel(data);

  const speedStr = speed > 0 ? `${speed} t/s` : '-- t/s';
  const ringChar = getRingChar(pct);
  const ctxStr = `${formatCompactTokens(usedTokens)} / 1M ${pct}%`;
  const cacheStr = `${cacheHit}%`;
  const totalStrPadded = formatCompactTokens(totalTokens).padEnd(5, ' ');

  const telemetryPlain =
    `↯ ${speedStr}  ·  ` +
    `${ringChar} ${ctxStr}  ·  ` +
    `◈ ${cacheStr}  ·  ` +
    `∑ ${totalStrPadded}`;

  const telemetryAnsi =
    `${FG}↯ ${speedStr}${DOT}  ·  ` +
    `${FG}${ringChar} ${ctxStr}${DOT}  ·  ` +
    `${FG}◈ ${cacheStr}${DOT}  ·  ` +
    `${FG}∑ ${totalStrPadded}${RST}`;

  const gapBeforeModel = '   ';
  const rightVisibleCols = telemetryPlain.length + gapBeforeModel.length + modelText.length;

  const termWidth = Number(data.terminal_width) || Number(process.stdout.columns) || 120;
  const centerSpaces = Math.max(2, termWidth - leftText.length - rightVisibleCols);

  return (
    `${NATIVE}${leftText}${RST}` +
    ' '.repeat(centerSpaces) +
    telemetryAnsi +
    gapBeforeModel +
    `${NATIVE}${modelText}${RST}`
  );
}

function runWithInput(rawInput) {
  const input = String(rawInput || '').replace(/^\uFEFF/, '').trim();
  let data = {};
  if (input) {
    try {
      data = JSON.parse(input);
    } catch {
      data = {};
    }
  }

  const convId = data.conversation_id || data.session_id || '';
  const rawDisplayName = (data.model && data.model.display_name) || '';
  const rawModelId = (data.model && data.model.id) || '';
  let fallbackDisplay = rawDisplayName;
  if (!fallbackDisplay && !rawModelId) {
    try {
      const settingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (typeof s.model === 'string') {
          fallbackDisplay = s.model;
        }
      }
    } catch {}
  }
  const mainModelFallback = normalizeModelName(fallbackDisplay, rawModelId);

  const transcriptPath = resolveTranscriptPath(data.transcript_path, convId);
  const tStats = parseTranscriptStats(transcriptPath, convId, mainModelFallback);

  const cw = data.context_window || {};
  const cu = cw.current_usage || {};

  const cuIn = Number(cu.input_tokens) || 0;
  const cuCacheRead = Number(cu.cache_read_input_tokens) || 0;
  const cuCacheCreate = Number(cu.cache_creation_input_tokens) || 0;
  const cuOut = Number(cu.output_tokens) || 0;
  const cuUsed = cuIn + cuCacheRead + cuCacheCreate + cuOut;

  const totalOutTokens = Math.max(Number(cw.total_output_tokens) || 0, cuOut);

  // 1. Speed (t/s)
  const rawSpeed = tStats && tStats.tokensPerSecond > 0 ? tStats.tokensPerSecond : 0;
  const speed = updateAndReadSpeedCache(convId, totalOutTokens, rawSpeed);

  // 2. Context Window (used / 1M & pct%): prefer unified API token count from transcript.jsonl, fallback to stdin current_usage
  const usedTokens = (tStats && tStats.latestContextUsed > 0)
    ? tStats.latestContextUsed
    : cuUsed > 0
      ? cuUsed
      : 0;
  const pct = Math.max(0, Math.min(100, Math.round((usedTokens / FIXED_MAX_TOKENS) * 100)));

  // 3. Cumulative Cache Hit Rate (%)
  let cacheHit = 0;
  if (tStats && tStats.cumulativePromptTokens > 0) {
    cacheHit = tStats.cacheHitRate;
  } else if (cuIn + cuCacheRead > 0) {
    cacheHit = Math.round((cuCacheRead / (cuIn + cuCacheRead)) * 100);
  }

  // 4. Cumulative Total Tokens (∑)
  const cwTotal = (Number(cw.total_input_tokens) || 0) + (Number(cw.total_output_tokens) || 0);
  const totalTokens = Math.max(
    tStats ? tStats.cumulativeTokens : 0,
    cwTotal,
    cuUsed
  );

  process.stdout.write(renderSingleLine(data, speed, usedTokens, pct, cacheHit, totalTokens) + '\n');
  syncActivityLedgerCache(convId, tStats);
}

if (process.stdin.isTTY) {
  runWithInput('');
} else {
  let chunks = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    chunks += chunk;
  });
  process.stdin.on('end', () => {
    runWithInput(chunks);
  });
  process.stdin.on('error', () => {
    runWithInput(chunks);
  });
}
