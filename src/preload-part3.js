}, 5000);
}
function toggleActivityModal() {
if (activityModalOpen) {
closeActivityModal();
}
else {
openActivityModal();
}
}
const FIXED_MAX_TOKENS = 1000000; // 统一固定 1M 上下文窗口
function createBarElement() {
const el = g.document.createElement('div');
el.className = BAR_CLASS;
el.setAttribute('data-testid', 'agy-custom-telemetry-bar');
el.title = '点击查看 Token 活动看板 (日/周/月消耗与热力图)';
el.innerHTML = `
<span class="agy-tm-item">
<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="flex-shrink:0; margin-right:5px; color:#91919C;">
<path d="M9.2 1.5L3.2 8.8H7.5L6.8 14.5L12.8 7.2H8.5L9.2 1.5Z" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
<span class="agy-tm-pri" data-role="speed-val">--</span>
<span class="agy-tm-sec" style="margin-left:3px;">t/s</span>
</span>
<span class="agy-tm-dot">·</span>
<span class="agy-tm-item">
<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="flex-shrink:0; margin-right:5px;">
<circle cx="8" cy="8" r="6" stroke="#52535E" stroke-opacity="0.85" stroke-width="1.5"/>
<circle data-role="ring-arc" cx="8" cy="8" r="6" stroke="#91919C" stroke-width="1.55" stroke-linecap="round" stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(2)}" stroke-dashoffset="${RING_CIRCUMFERENCE.toFixed(2)}" transform="rotate(-90 8 8)" style="transition: stroke-dashoffset 0.25s ease;"/>
</svg>
<span class="agy-tm-pri" data-role="ctx-val">0 / 1M</span>
<span class="agy-tm-sec" data-role="ctx-pct" style="margin-left:5px;">0%</span>
</span>
<span class="agy-tm-dot">·</span>
<span class="agy-tm-item">
<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="flex-shrink:0; margin-right:5px;">
<path d="M8 2.2L14 5.2L8 8.2L2 5.2L8 2.2Z" stroke="#91919C" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M2 8.4L8 11.4L14 8.4" stroke="#91919C" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M2 11.4L8 14.4L14 11.4" stroke="#91919C" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
<span class="agy-tm-pri" data-role="cache-val">0%</span>
</span>
<span class="agy-tm-dot">·</span>
<span class="agy-tm-item agy-tm-activity-trigger" data-role="activity-trigger">
<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="flex-shrink:0; margin-right:5px;">
<path d="M12.5 2.5H3.5L8.3 8L3.5 13.5H12.5" stroke="#91919C" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
<span class="agy-tm-pri" data-role="total-val">0</span>
</span>
`;
el.addEventListener('mousedown', (e) => {
e.stopPropagation();
});
el.addEventListener('click', (e) => {
e.preventDefault();
e.stopPropagation();
toggleActivityModal();
});
return el;
}
function ensureBarsMounted() {
ensureStyles();
const footers = g.document.querySelectorAll('.agy-composer-footer');
for (const footer of footers) {
const leftGroup = footer.firstElementChild;
if (!leftGroup)
continue;
let bar = leftGroup.querySelector(`.${BAR_CLASS}`);
if (!bar) {
bar = createBarElement();
leftGroup.appendChild(bar);
}
else if (leftGroup.lastElementChild !== bar) {
leftGroup.appendChild(bar);
}
}
}
const FIBER_EXTRACTOR_SCRIPT = `(() => {
try {
const w = window;
if (!w.__agyStreamTrackers) {
w.__agyStreamTrackers = {};
}
const footers = Array.from(document.querySelectorAll('.agy-composer-footer'));
return footers.map((footer) => {
const inputEl = footer.querySelector('.no-focus-agent-input');
if (!inputEl) return null;
const domModelText = (inputEl.textContent || '').trim();
const triggerBtn = inputEl.querySelector('[data-testid="model-selector-trigger"]');
const domCtxWin = triggerBtn ? triggerBtn.getAttribute('data-context-window') : null;
const fiberKey = Object.keys(inputEl).find(k => k.startsWith('__reactFiber$'));
if (!fiberKey) return { conversationId: null, modelLabel: domModelText, selectedContextWindow: domCtxWin };
let curr = inputEl[fiberKey];
let conversationId = null;
let modelLabel = domModelText;
let selectedContextWindow = domCtxWin;
let isRunning = false;
let agentStateProvider = null;
let trajectoriesManager = null;
if (curr.child && curr.child.memoizedProps) {
const cp = curr.child.memoizedProps;
if (cp.selectedModel && cp.selectedModel.label) modelLabel = cp.selectedModel.label;
if (cp.contextWindow && cp.contextWindow.selected) selectedContextWindow = cp.contextWindow.selected;
}
let depth = 0;
while (curr && depth < 90) {
const mp = curr.memoizedProps;
if (mp && typeof mp === 'object') {
if (!conversationId && (typeof mp.conversationId === 'string' || typeof mp.cascadeId === 'string')) {
const cid = mp.conversationId || mp.cascadeId;
if (cid && cid !== '_new') {
conversationId = cid;
}
}
if (typeof mp.isRunning === 'boolean') {
isRunning = mp.isRunning;
}
if (!modelLabel && mp.currentModelConfig && mp.currentModelConfig.label) {
modelLabel = mp.currentModelConfig.label;
}
const val = mp.value;
if (val && typeof val === 'object') {
if (!agentStateProvider && val.cascadeContext && val.cascadeContext.state && val.cascadeContext.state.agentStateProvider) {
agentStateProvider = val.cascadeContext.state.agentStateProvider;
}
if (!trajectoriesManager && typeof val.peek === 'function' && typeof val.getAgentStates === 'function') {
trajectoriesManager = val;
}
}
}
curr = curr.return;
depth++;
}
if (!conversationId) {
return {
conversationId: null,
modelLabel,
selectedContextWindow,
isRunning: false,
usedTokens: 0,
maxTokens: 0,
cacheHitRate: 0,
cumulativeTokens: 0,
serverTps: 0,
liveTps: 0
};
}
if (!agentStateProvider && trajectoriesManager) {
agentStateProvider = trajectoriesManager.peek(conversationId) ||
(trajectoriesManager.getAgentStates().get(conversationId) || {}).provider;
}
const state = agentStateProvider && typeof agentStateProvider.getState === 'function'
? agentStateProvider.getState()
: null;
let usedTokens = 0;
let maxTokens = 0;
if (state && state.contextWindowUsage) {
usedTokens = Number(state.contextWindowUsage.estimatedTokensUsed) || 0;
maxTokens = Number(state.contextWindowUsage.maxContextTokens) || 0;
}
let cacheHitRate = null;
let cumulativePromptTokens = 0;
let cumulativeTokens = 0;
let latestStreamTps = 0;
const genMetas = state && state.trajectorySlice && Array.isArray(state.trajectorySlice.generatorMetadatasInSlice)
? state.trajectorySlice.generatorMetadatasInSlice
: [];
if (genMetas.length > 0) {
let sumGenTokens = 0;
let sumGenIn = 0;
let sumGenCacheRead = 0;
for (const gm of genMetas) {
const cm = gm && gm.metadata && gm.metadata.case === 'chatModel'
? gm.metadata.value
: (gm && gm.chatModel ? gm.chatModel : null);
if (!cm) continue;
const cw = cm.chatStartMetadata && cm.chatStartMetadata.contextWindowMetadata
? cm.chatStartMetadata.contextWindowMetadata
: null;
if (cw && !usedTokens && Number(cw.estimatedTokensUsed) > 0) {
usedTokens = Number(cw.estimatedTokensUsed);
}
const u = cm.usage;
if (u) {
const inTok = Number(u.inputTokens || 0);
const outTok = Number(u.outputTokens || 0);
const cacheReadTok = Number(u.cacheReadTokens || 0);
const cacheWriteTok = Number(u.cacheWriteTokens || 0);
sumGenIn += inTok;
sumGenCacheRead += cacheReadTok;
sumGenTokens += inTok + outTok + cacheReadTok + cacheWriteTok;
if (inTok + cacheReadTok + outTok > 0) {
usedTokens = inTok + cacheReadTok + outTok;
}
if (outTok > 0 && cm.streamingDuration) {
const durSec = Number(cm.streamingDuration.seconds || 0) + Number(cm.streamingDuration.nanos || 0) / 1e9;
if (durSec >= 0.2 && durSec <= 300) {
const stepTps = outTok / durSec;
if (stepTps >= 5 && stepTps <= 500) {
latestStreamTps = Math.max(1, Math.min(350, Math.round(stepTps)));
}
}
}
}
}
if (sumGenIn + sumGenCacheRead > 0) {
cumulativePromptTokens = sumGenIn + sumGenCacheRead;
cacheHitRate = Math.round((sumGenCacheRead / cumulativePromptTokens) * 100);
}
if (sumGenTokens > 0) {
cumulativeTokens = sumGenTokens;
}
}
if (state && state.costSummary) {
const cs = state.costSummary;
const cum = cs.total && cs.total.cumulativeTotal ? cs.total.cumulativeTotal : null;
if (cum) {
const cIn = Number(cum.input && cum.input.tokens ? cum.input.tokens : 0);
const cCache = Number(cum.cacheRead && cum.cacheRead.tokens ? cum.cacheRead.tokens : 0);
const cOut = Number(cum.output && cum.output.tokens ? cum.output.tokens : 0);
if (cIn + cCache + cOut > cumulativeTokens) {
cumulativeTokens = cIn + cCache + cOut;
}
if (cIn + cCache >= cumulativePromptTokens && (cIn + cCache > 0)) {
cumulativePromptTokens = cIn + cCache;
cacheHitRate = Math.round((cCache / cumulativePromptTokens) * 100);
}
}
if (cs.turnCosts && typeof cs.turnCosts === 'object') {
const keys = Object.keys(cs.turnCosts);
if (keys.length > 0) {
let sumTurnIn = 0;
let sumTurnCache = 0;
for (const k of keys) {
const tc = cs.turnCosts[k];
const t = tc && tc.turn ? tc.turn : null;
if (t) {
sumTurnIn += Number(t.input && t.input.tokens ? t.input.tokens : 0);
sumTurnCache += Number(t.cacheRead && t.cacheRead.tokens ? t.cacheRead.tokens : 0);
}
}
if (sumTurnIn + sumTurnCache > cumulativePromptTokens && (sumTurnIn + sumTurnCache > 0)) {
cumulativePromptTokens = sumTurnIn + sumTurnCache;
cacheHitRate = Math.round((sumTurnCache / cumulativePromptTokens) * 100);
}
const lastTurn = cs.turnCosts[keys[keys.length - 1]];
const lt = lastTurn && lastTurn.turn ? lastTurn.turn : null;
if (lt && !usedTokens) {
const ltIn = Number(lt.input && lt.input.tokens ? lt.input.tokens : 0);
const ltCache = Number(lt.cacheRead && lt.cacheRead.tokens ? lt.cacheRead.tokens : 0);
const ltOut = Number(lt.output && lt.output.tokens ? lt.output.tokens : 0);
if (ltIn + ltCache + ltOut > 0) {
usedTokens = ltIn + ltCache + ltOut;
}
}
}
}
}
const toSec = (ts) => ts ? (Number(ts.seconds || 0) + Number(ts.nanos || 0) / 1e9) : 0;
const steps = state && state.trajectorySlice && Array.isArray(state.trajectorySlice.stepsInSlice)
? state.trajectorySlice.stepsInSlice
: [];
if (latestStreamTps === 0 && steps.length > 0) {
for (let si = 0; si < steps.length; si++) {
const st = steps[si];
const md = st && st.metadata ? st.metadata : null;
if (!md) continue;
const mu = md.modelUsage;
const outTok = mu ? Number(mu.outputTokens || 0) : 0;
const tStart = toSec(md.startedAt) || toSec(md.createdAt);
const nextMd = steps[si + 1] && steps[si + 1].metadata ? steps[si + 1].metadata : null;
const tEnd = toSec(md.finishedGeneratingAt) || toSec(md.lastCompletedChunkAt) || toSec(md.completedAt) || (nextMd ? toSec(nextMd.createdAt) : 0);
if (outTok > 0 && tStart > 0 && tEnd > tStart) {
const dur = tEnd - tStart;
if (dur >= 0.2 && dur <= 300) {
const stepTps = outTok / dur;
if (stepTps >= 5 && stepTps <= 500) {
latestStreamTps = Math.max(1, Math.min(350, Math.round(stepTps)));
}
}
}
}
}
const serverTps = latestStreamTps;
if (steps.length > 0) {
for (let si = steps.length - 1; si >= 0; si--) {
const st = steps[si];
const sCase = st && st.step ? st.step.case : '';
if (sCase === 'plannerResponse') {
break;
}
if (sCase === 'checkpoint' && !(st.step.value && st.step.value.intentOnly)) {
let instrTokens = 16000;
if (state && state.contextWindowUsage && Array.isArray(state.contextWindowUsage.tokenGroups)) {
const est = Number(state.contextWindowUsage.estimatedTokensUsed) || 0;
const chatTok = state.contextWindowUsage.tokenGroups
.filter(g => g && g.type === 1)
.reduce((acc, g) => acc + (Number(g.numTokens) || 0), 0);
if (est > chatTok && (est - chatTok) > 1000) {
instrTokens = est - chatTok;
}
}
const cpOut = Number(st.metadata && st.metadata.modelUsage && st.metadata.modelUsage.outputTokens) || 4000;
usedTokens = instrTokens + cpOut;
break;
}
}
}
let liveTps = 0;
const storageKey = 'agy_tps_' + conversationId;
let savedTps = 0;
try {
savedTps = Number(w.sessionStorage.getItem(storageKey)) || 0;
} catch {}
if (serverTps > 0) {
try { w.sessionStorage.setItem(storageKey, String(serverTps)); } catch {}
}
if (steps.length > 0) {
if (!w.__agyStreamTrackers[conversationId]) {
w.__agyStreamTrackers[conversationId] = {
stepKey: null,
startMs: 0,
lastChangeMs: 0,
startChars: 0,
prevChars: 0,
avgTps: savedTps
};
}
const tracker = w.__agyStreamTrackers[conversationId];
const lastStep = steps[steps.length - 1];
const stepVal = lastStep && lastStep.step ? lastStep.step.value : null;
const chars = stepVal
? String(stepVal.thinking || '').length + String(stepVal.response || '').length
: 0;
const stepKey = conversationId + ':' + String(steps.length);
const now = performance.now();
if (chars > 0) {
if (tracker.stepKey !== stepKey) {
tracker.stepKey = stepKey;
tracker.startMs = now;
tracker.lastChangeMs = now;
tracker.startChars = chars;
tracker.prevChars = chars;
} else if (chars > tracker.prevChars) {
tracker.lastChangeMs = now;
tracker.prevChars = chars;
}
const curDeltaChars = Math.max(0, tracker.prevChars - tracker.startChars);
const curElapsedSec = Math.max(0, (tracker.lastChangeMs - tracker.startMs) / 1000);
if (curDeltaChars > 24 && curElapsedSec >= 0.5) {
const rawTps = Math.max(5, Math.min(350, Math.round((curDeltaChars / 3.6) / curElapsedSec)));
tracker.avgTps = rawTps;
try { w.sessionStorage.setItem(storageKey, String(tracker.avgTps)); } catch {}
}
}
liveTps = tracker.avgTps || savedTps || 0;
}
return {
conversationId,
modelLabel,
selectedContextWindow,
isRunning: Boolean(isRunning || (state && state.status === 1)),
usedTokens,
maxTokens,
cacheHitRate,
cumulativePromptTokens,
cumulativeTokens,
serverTps,
liveTps
};
});
} catch {
return null;
}
})()`;
let isPolling = false;
async function updateTelemetry() {
if (isPolling)
return;
isPolling = true;
try {
ensureBarsMounted();
const footers = Array.from(g.document.querySelectorAll('.agy-composer-footer'));
if (footers.length === 0)
return;
let reactDataList = null;
if (electronObj.webFrame && typeof electronObj.webFrame.executeJavaScript === 'function') {
reactDataList = await electronObj.webFrame.executeJavaScript(FIBER_EXTRACTOR_SCRIPT).catch(() => null);
}
for (let i = 0; i < footers.length; i++) {
const footer = footers[i];
const bar = footer.querySelector(`.${BAR_CLASS}`);
if (!bar)
continue;
const reactData = Array.isArray(reactDataList) ? reactDataList[i] : null;
const convId = reactData && typeof reactData.conversationId === 'string' && reactData.conversationId
? reactData.conversationId
: null;
const maxTokens = FIXED_MAX_TOKENS; // 统一固定 1M 上下文窗口
if (!convId) {
const elSpeed = bar.querySelector('[data-role="speed-val"]');
if (elSpeed)
elSpeed.textContent = '--';
const elCtxVal = bar.querySelector('[data-role="ctx-val"]');
if (elCtxVal)
elCtxVal.textContent = '0 / 1M';
const elCtxPct = bar.querySelector('[data-role="ctx-pct"]');
if (elCtxPct)
elCtxPct.textContent = '0%';
const elRing = bar.querySelector('[data-role="ring-arc"]');
if (elRing)
elRing.setAttribute('stroke-dashoffset', RING_CIRCUMFERENCE.toFixed(2));
const elCache = bar.querySelector('[data-role="cache-val"]');
if (elCache)
elCache.textContent = '0%';
const elTotal = bar.querySelector('[data-role="total-val"]');
if (elTotal)
elTotal.textContent = '0';
continue;
}
const ipcStats = await electronObj.ipcRenderer
.invoke('telemetry:get-stats', convId)
.catch(() => null);
const speed = (reactData && reactData.serverTps > 0)
? reactData.serverTps
: (ipcStats && ipcStats.tokensPerSecond > 0)
? ipcStats.tokensPerSecond
: (reactData && reactData.liveTps > 0)
? reactData.liveTps
: 0;
const usedTokens = (ipcStats && ipcStats.latestContextUsed > 0)
? ipcStats.latestContextUsed
: (reactData && reactData.usedTokens > 0)
? reactData.usedTokens
: 0;
const pct = maxTokens > 0 ? Math.max(0, Math.min(100, Math.round((usedTokens / maxTokens) * 100))) : 0;
const dashOffset = RING_CIRCUMFERENCE * (1 - pct / 100);
const reactPromptTok = Number(reactData?.cumulativePromptTokens || 0);
const ipcPromptTok = Number(ipcStats?.cumulativePromptTokens || 0);
const cacheHit = (ipcPromptTok > reactPromptTok && typeof ipcStats?.cacheHitRate === 'number')
? ipcStats.cacheHitRate
: (reactData && reactData.cacheHitRate !== null && reactData.cacheHitRate !== undefined)
? reactData.cacheHitRate
: (ipcStats && typeof ipcStats.cacheHitRate === 'number')
? ipcStats.cacheHitRate
: 0;
const totalTokens = Math.max(Number(reactData?.cumulativeTokens || 0), Number(ipcStats?.cumulativeTokens || 0));
const elSpeed = bar.querySelector('[data-role="speed-val"]');
if (elSpeed)
elSpeed.textContent = speed > 0 ? String(speed) : '--';
const elCtxVal = bar.querySelector('[data-role="ctx-val"]');
if (elCtxVal)
elCtxVal.textContent = `${formatCompactTokens(usedTokens)} / ${formatCompactTokens(maxTokens)}`;
const elCtxPct = bar.querySelector('[data-role="ctx-pct"]');
if (elCtxPct)
elCtxPct.textContent = `${pct}%`;
const elRing = bar.querySelector('[data-role="ring-arc"]');
if (elRing)
elRing.setAttribute('stroke-dashoffset', dashOffset.toFixed(2));
const elCache = bar.querySelector('[data-role="cache-val"]');
if (elCache)
elCache.textContent = `${cacheHit}%`;
const elTotal = bar.querySelector('[data-role="total-val"]');
if (elTotal)
elTotal.textContent = formatCompactTokens(totalTokens);
}
}
catch {
}
finally {
isPolling = false;
}
}
let mountScheduled = false;
const scheduleMount = () => {
if (mountScheduled)
return;
mountScheduled = true;
const run = () => {
mountScheduled = false;
ensureBarsMounted();
void updateTelemetry();
};
if (typeof g.requestAnimationFrame === 'function') {
g.requestAnimationFrame(run);
}
else {
setTimeout(run, 50);
}
};
const startObserver = () => {
const root = g.document.documentElement || g.document.body;
if (!root || typeof g.MutationObserver !== 'function')
return;
new g.MutationObserver((mutations) => {
for (const m of mutations) {
if (m.target && m.target.closest && (m.target.closest(`.${BAR_CLASS}`) || m.target.closest(`#${MODAL_ID}`))) {
continue;
}
if (m.target === g.document.body || m.target === g.document.head || m.target === g.document.documentElement) {
const changed = [...(m.addedNodes || []), ...(m.removedNodes || [])];
if (changed.length > 0 && changed.every((n) => n && (n.id === MODAL_ID || n.id === STYLE_ID || n.id === MODAL_STYLE_ID))) {
continue;
}
}
scheduleMount();
break;
}
}).observe(root, { childList: true, subtree: true });
scheduleMount();
};
if (g.document.readyState === 'loading') {
g.document.addEventListener('DOMContentLoaded', startObserver);
}
else {
startObserver();
}
setInterval(() => {
void updateTelemetry();
}, 1000);
}
installTelemetryBar();
// === TELEMETRY_MOD_PRELOAD_END ===
