const th = tt.offsetHeight || 62;
const vw = g.window.innerWidth || 1024;
let left = rect.left + rect.width / 2 - tw / 2;
left = Math.max(12, Math.min(vw - tw - 12, left));
let top = rect.top - th - 8;
if (top < 12) {
top = rect.bottom + 8;
}
tt.style.left = `${Math.round(left)}px`;
tt.style.top = `${Math.round(top)}px`;
tt.style.visibility = 'visible';
}
function buildHeatmapStructure(todayKey) {
if (!activityOverlayEl)
return;
const gridEl = activityOverlayEl.querySelector('[data-role="ta-heatmap-grid"]');
const monthsEl = activityOverlayEl.querySelector('[data-role="ta-months"]');
if (!gridEl || !monthsEl)
return;
const todayDt = parseDateKeyLocal(todayKey);
const monIdx = (todayDt.getDay() + 6) % 7;
const thisWeekMonday = addLocalDays(todayDt, -monIdx);
const startMonday = addLocalDays(thisWeekMonday, -52 * 7);
let gridHtml = '';
const monthMarks = [];
const seenMonths = new Set();
for (let col = 0; col < 53; col++) {
gridHtml += '<div class="agy-ta-week-col">';
for (let row = 0; row < 7; row++) {
const cellDt = addLocalDays(startMonday, col * 7 + row);
const cellKey = formatDateKey(cellDt);
const isFuture = cellKey > todayKey;
if (!isFuture && cellDt.getDate() === 1) {
const ym = `${cellDt.getFullYear()}-${cellDt.getMonth() + 1}`;
if (!seenMonths.has(ym)) {
seenMonths.add(ym);
monthMarks.push({ col, label: `${cellDt.getMonth() + 1}月` });
}
}
gridHtml += isFuture
? `<div class="agy-ta-cell is-future"></div>`
: `<div class="agy-ta-cell" data-date="${cellKey}"></div>`;
}
gridHtml += '</div>';
}
gridEl.innerHTML = gridHtml;
monthsEl.innerHTML = monthMarks
.map((m) => {
const leftPx = Math.min(m.col * 14, 739 - 28);
return `<span class="agy-ta-month-lbl" style="left:${leftPx}px;">${escHtml(m.label)}</span>`;
})
.join('');
activityRenderedTodayKey = todayKey;
}
function buildDualProgressHtml(desktop, cli, total, maxTotal) {
const t = Number(total) || 0;
const d = Number(desktop) || 0;
const c = Number(cli) || 0;
const widthPct = maxTotal > 0 && t > 0 ? Math.max(2, Math.min(100, (t / maxTotal) * 100)) : 0;
const splitTotal = d + c;
const desktopPct = splitTotal > 0 ? (d / splitTotal) * 100 : (t > 0 ? 100 : 0);
const cliPct = splitTotal > 0 ? Math.max(0, 100 - desktopPct) : 0;
return `
<div class="agy-ta-bar-track">
<div class="agy-ta-bar-fill" style="width:${widthPct.toFixed(2)}%;">
<div class="agy-ta-seg-desktop" style="width:${desktopPct.toFixed(2)}%;"></div>
<div class="agy-ta-seg-cli" style="width:${cliPct.toFixed(2)}%;"></div>
</div>
</div>
`;
}
function buildModelProgressHtml(modelsObj, total, maxTotal, palette) {
const t = Number(total) || 0;
const widthPct = maxTotal > 0 && t > 0 ? Math.max(2, Math.min(100, (t / maxTotal) * 100)) : 0;
const entries = getSortedModelEntries(modelsObj);
const modelSum = entries.reduce((sum, [, m]) => sum + (Number(m && m.total) || 0), 0);
let segsHtml = '';
if (modelSum > 0) {
segsHtml = entries.map(([name, m]) => {
const mTot = Number(m && m.total) || 0;
const pct = (mTot / modelSum) * 100;
const col = palette ? palette.getColor(name) : '#64748B';
return `<div class="agy-ta-seg-model" style="width:${pct.toFixed(2)}%; background:${col};" title="${escHtml(name)}: ${formatActivityTokens(mTot)} (${pct.toFixed(1)}%)"></div>`;
}).join('');
}
else {
segsHtml = `<div class="agy-ta-seg-model" style="width:100%; background:#64748B;"></div>`;
}
return `
<div class="agy-ta-bar-track">
<div class="agy-ta-bar-fill" style="width:${widthPct.toFixed(2)}%;">
${segsHtml}
</div>
</div>
`;
}
function buildModelSubHtml(modelsObj, palette) {
const entries = getSortedModelEntries(modelsObj);
if (entries.length === 0) {
return '暂无模型明细';
}
const topItems = entries.slice(0, 3).map(([name, m]) => ({
name,
total: Number(m && m.total) || 0,
color: palette ? palette.getColor(name) : '#64748B',
}));
if (entries.length > 3) {
const otherTotal = entries.slice(3).reduce((sum, [, m]) => sum + (Number(m && m.total) || 0), 0);
if (otherTotal > 0) {
topItems.push({
name: '其他',
total: otherTotal,
color: palette ? palette.getColor('其他') : '#64748B',
});
}
}
return topItems.map(item =>
`<span style="display:inline-flex;align-items:center;gap:4px;"><span class="agy-ta-model-inline-dot" style="background:${item.color};"></span>${escHtml(item.name)} ${formatActivityTokens(item.total)}</span>`
).join(' · ');
}
function buildModelTooltipAttr(periodLabel, modelsObj) {
const entries = getSortedModelEntries(modelsObj);
if (entries.length === 0)
return '';
const total = entries.reduce((s, [, m]) => s + (Number(m && m.total) || 0), 0);
const lines = [`${periodLabel} 模型消耗明细：`];
for (const [name, m] of entries) {
const tot = Number(m && m.total) || 0;
const pct = total > 0 ? ((tot / total) * 100).toFixed(1) : '0.0';
const inTok = Number(m && m.in) || 0;
const cacheTok = Number(m && m.cache) || 0;
const outTok = Number(m && m.out) || 0;
lines.push(`• ${name}: ${formatActivityTokens(tot)} (${pct}%) [输入 ${formatActivityTokens(inTok)} / 缓存 ${formatActivityTokens(cacheTok)} / 输出 ${formatActivityTokens(outTok)}]`);
}
return escHtml(lines.join('\n'));
}
function renderModelLegend(rows, palette) {
if (!rows || rows.length === 0)
return '';
const merged = {};
for (const r of rows) {
if (r.models) {
mergeModelsMap(merged, r.models);
}
}
const allEntries = getSortedModelEntries(merged);
if (allEntries.length === 0)
return '';
const named = allEntries.filter(([name]) => name !== '其他模型' && name !== '其他');
const top4 = named.slice(0, 4);
const top4Names = new Set(top4.map(([n]) => n));
let otherSum = 0;
for (const [name, m] of allEntries) {
if (!top4Names.has(name)) {
otherSum += (Number(m && m.total) || 0);
}
}
const items = top4.map(([name]) => ({
name,
color: palette.getColor(name),
}));
if (otherSum > 0) {
items.push({
name: '其他',
color: palette.getColor('其他'),
});
}
return items.map(it =>
`<span class="agy-ta-src-item"><span class="agy-ta-src-dot" style="background:${it.color};"></span>${escHtml(it.name)}</span>`
).join('');
}
function renderBreakdownSection(stats) {
if (!activityOverlayEl)
return;
const titleEl = activityOverlayEl.querySelector('[data-role="ta-bd-title"]');
const listEl = activityOverlayEl.querySelector('[data-role="ta-bd-list"]');
const controlsEl = activityOverlayEl.querySelector('[data-role="ta-bd-controls"]');
const srcLegendEl = activityOverlayEl.querySelector('[data-role="ta-src-legend"]');
const modeBtns = activityOverlayEl.querySelectorAll('.agy-ta-mode-btn[data-mode]');
if (!titleEl || !listEl)
return;
const prevScroll = listEl.scrollTop;
if (activityActiveTab === 'total') {
if (controlsEl)
controlsEl.style.display = 'none';
}
else {
if (controlsEl)
controlsEl.style.display = 'inline-flex';
for (const btn of modeBtns) {
btn.classList.toggle('is-active', btn.getAttribute('data-mode') === activityBreakdownMode);
}
}
const palette = buildModelColorMap(stats);
const updateLegend = (rows) => {
if (!srcLegendEl)
return;
if (activityBreakdownMode === 'source') {
srcLegendEl.innerHTML = `
<span class="agy-ta-src-item"><span class="agy-ta-src-dot" style="background:var(--agy-ta-desktop-color, #D965B5);"></span>Desktop</span>
<span class="agy-ta-src-item"><span class="agy-ta-src-dot" style="background:var(--agy-ta-cli-color, #60A5FA);"></span>CLI</span>
`;
}
else {
srcLegendEl.innerHTML = renderModelLegend(rows, palette);
}
};
const days = stats.days || {};
const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
if (activityActiveTab === 'daily') {
titleEl.textContent = '每日消耗明细（最近 10 个活跃日）';
const rows = Object.keys(days)
.map((dateStr) => ({ dateStr, ...getDayData(stats, dateStr) }))
.filter((r) => r.total > 0)
.sort((a, b) => (a.dateStr < b.dateStr ? 1 : -1))
.slice(0, 10);
updateLegend(rows);
if (rows.length === 0) {
listEl.innerHTML = `<div class="agy-ta-empty">${activityFetchError ? '无法读取统计数据，请确认主进程已注入最新遥测模块' : '暂无 Token 消耗记录'}</div>`;
return;
}
const maxTotal = rows.reduce((mx, r) => Math.max(mx, r.total), 0);
listEl.innerHTML = rows
.map((r) => {
const dt = parseDateKeyLocal(r.dateStr);
const wd = weekdayNames[dt.getDay()];
const isToday = r.dateStr === stats.todayKey;
const periodLabel = `${r.dateStr} · ${wd}`;
const rowTooltip = buildModelTooltipAttr(periodLabel, r.models);
const titleAttr = rowTooltip ? ` title="${rowTooltip}"` : '';
const barHtml = activityBreakdownMode === 'model'
? buildModelProgressHtml(r.models, r.total, maxTotal, palette)
: buildDualProgressHtml(r.desktop, r.cli, r.total, maxTotal);
const rightSubHtml = activityBreakdownMode === 'model'
? `<span>${buildModelSubHtml(r.models, palette)}</span>`
: `<span>Desktop ${formatActivityTokens(r.desktop)} · CLI ${formatActivityTokens(r.cli)}</span>`;
return `
<div class="agy-ta-row"${titleAttr}>
<div class="agy-ta-row-top">
<span class="agy-ta-row-name">${escHtml(r.dateStr)} · ${wd}${isToday ? '<span class="agy-ta-tag">今天</span>' : ''}</span>
<span class="agy-ta-row-total">${formatActivityTokens(r.total)}</span>
</div>
${barHtml}
<div class="agy-ta-row-sub">
<span>输入 ${formatActivityTokens(r.in)} · 缓存 ${formatActivityTokens(r.cache)} (${calcCachePct(r)}%) · 输出 ${formatActivityTokens(r.out)}</span>
${rightSubHtml}
</div>
</div>
`;
})
.join('');
}
else if (activityActiveTab === 'weekly') {
titleEl.textContent = '每周消耗对比（最近 8 个 ISO 周）';
const weekMap = new Map();
for (const dateStr of Object.keys(days)) {
const d = getDayData(stats, dateStr);
if (d.total <= 0)
continue;
const info = getIsoWeekInfo(dateStr);
let w = weekMap.get(info.key);
if (!w) {
w = { key: info.key, range: info.range, startKey: info.startKey, in: 0, cache: 0, out: 0, total: 0, desktop: 0, cli: 0, activeDays: 0, models: {} };
weekMap.set(info.key, w);
}
w.in += d.in;
w.cache += d.cache;
w.out += d.out;
w.total += d.total;
w.desktop += d.desktop;
w.cli += d.cli;
w.activeDays += 1;
mergeModelsMap(w.models, d.models);
}
const thisWeekInfo = getIsoWeekInfo(stats.todayKey);
const rows = Array.from(weekMap.values())
.sort((a, b) => (a.startKey < b.startKey ? 1 : -1))
.slice(0, 8);
updateLegend(rows);
if (rows.length === 0) {
listEl.innerHTML = `<div class="agy-ta-empty">${activityFetchError ? '无法读取统计数据，请确认主进程已注入最新遥测模块' : '暂无每周消耗记录'}</div>`;
return;
}
const maxTotal = rows.reduce((mx, r) => Math.max(mx, r.total), 0);
listEl.innerHTML = rows
.map((w) => {
const isCur = w.key === thisWeekInfo.key;
const periodLabel = `${w.key} (${w.range})`;
const rowTooltip = buildModelTooltipAttr(periodLabel, w.models);
const titleAttr = rowTooltip ? ` title="${rowTooltip}"` : '';
const barHtml = activityBreakdownMode === 'model'
? buildModelProgressHtml(w.models, w.total, maxTotal, palette)
: buildDualProgressHtml(w.desktop, w.cli, w.total, maxTotal);
const rightSubHtml = activityBreakdownMode === 'model'
? `<span>${buildModelSubHtml(w.models, palette)}</span>`
: `<span>Desktop ${formatActivityTokens(w.desktop)} · CLI ${formatActivityTokens(w.cli)}</span>`;
return `
<div class="agy-ta-row"${titleAttr}>
<div class="agy-ta-row-top">
<span class="agy-ta-row-name">${escHtml(w.key)} (${escHtml(w.range)})${isCur ? '<span class="agy-ta-tag">本周</span>' : ''}</span>
<span class="agy-ta-row-total">${formatActivityTokens(w.total)}</span>
</div>
${barHtml}
<div class="agy-ta-row-sub">
<span>活跃 ${w.activeDays} 天 · 缓存率 ${calcCachePct(w)}% · 输出 ${formatActivityTokens(w.out)}</span>
${rightSubHtml}
</div>
</div>
`;
})
.join('');
}
else if (activityActiveTab === 'monthly') {
titleEl.textContent = '每月消耗对比';
const monthMap = new Map();
for (const dateStr of Object.keys(days)) {
const d = getDayData(stats, dateStr);
if (d.total <= 0)
continue;
const ym = dateStr.slice(0, 7);
let m = monthMap.get(ym);
if (!m) {
m = { ym, in: 0, cache: 0, out: 0, total: 0, desktop: 0, cli: 0, activeDays: 0, models: {} };
monthMap.set(ym, m);
}
m.in += d.in;
m.cache += d.cache;
m.out += d.out;
m.total += d.total;
m.desktop += d.desktop;
m.cli += d.cli;
m.activeDays += 1;
mergeModelsMap(m.models, d.models);
}
const curYm = stats.todayKey.slice(0, 7);
const rows = Array.from(monthMap.values())
.sort((a, b) => (a.ym < b.ym ? 1 : -1))
.slice(0, 12);
updateLegend(rows);
if (rows.length === 0) {
listEl.innerHTML = `<div class="agy-ta-empty">${activityFetchError ? '无法读取统计数据，请确认主进程已注入最新遥测模块' : '暂无每月消耗记录'}</div>`;
return;
}
const maxTotal = rows.reduce((mx, r) => Math.max(mx, r.total), 0);
listEl.innerHTML = rows
.map((m) => {
const [yStr, mStr] = m.ym.split('-');
const label = `${yStr}年${mStr}月`;
const isCur = m.ym === curYm;
const periodLabel = label;
const rowTooltip = buildModelTooltipAttr(periodLabel, m.models);
const titleAttr = rowTooltip ? ` title="${rowTooltip}"` : '';
const barHtml = activityBreakdownMode === 'model'
? buildModelProgressHtml(m.models, m.total, maxTotal, palette)
: buildDualProgressHtml(m.desktop, m.cli, m.total, maxTotal);
const rightSubHtml = activityBreakdownMode === 'model'
? `<span>${buildModelSubHtml(m.models, palette)}</span>`
: `<span>Desktop ${formatActivityTokens(m.desktop)} · CLI ${formatActivityTokens(m.cli)}</span>`;
return `
<div class="agy-ta-row"${titleAttr}>
<div class="agy-ta-row-top">
<span class="agy-ta-row-name">${escHtml(label)}${isCur ? '<span class="agy-ta-tag">本月</span>' : ''}</span>
<span class="agy-ta-row-total">${formatActivityTokens(m.total)}</span>
</div>
${barHtml}
<div class="agy-ta-row-sub">
<span>输入 ${formatActivityTokens(m.in)} · 缓存 ${formatActivityTokens(m.cache)} (${calcCachePct(m)}%) · 输出 ${formatActivityTokens(m.out)} · 活跃 ${m.activeDays} 天</span>
${rightSubHtml}
</div>
</div>
`;
})
.join('');
}
else {
titleEl.textContent = '累计总量概览与构成分布';
const all = stats.allTime || {};
const allIn = Number(all.in) || 0;
const allCache = Number(all.cache) || 0;
const allOut = Number(all.out) || 0;
const compSum = (allIn + allCache + allOut) || Number(all.total) || 0;
const inPct = compSum > 0 ? (allIn / compSum) * 100 : 0;
const cacheCompPct = compSum > 0 ? (allCache / compSum) * 100 : 0;
const outPct = compSum > 0 ? (allOut / compSum) * 100 : 0;
const allDesktop = Number(all.desktop) || 0;
const allCli = Number(all.cli) || 0;
const srcSum = (allDesktop + allCli) || Number(all.total) || 0;
const desktopPct = srcSum > 0 ? (allDesktop / srcSum) * 100 : 0;
const cliPct = srcSum > 0 ? Math.max(0, 100 - desktopPct) : 0;
const convText = Number(all.totalConversations) > 0
? `${Number(all.totalConversations)} 个会话 · ${Number(all.steps) || 0} 步`
: `${Number(all.steps) || 0} 步响应`;

const allModels = all.models || {};
const modelEntries = getSortedModelEntries(allModels);
const totalModelSum = modelEntries.reduce((sum, [, m]) => sum + (Number(m && m.total) || 0), 0) || Number(all.total) || 0;

let modelPanelHtml = '';
if (modelEntries.length === 0) {
modelPanelHtml = `
<div class="agy-ta-panel" style="margin-top:10px;">
<div class="agy-ta-panel-title">各模型累计消耗分布</div>
<div style="color:var(--agy-ta-muted, #7E7E8E);font-size:11.5px;padding:8px 0;text-align:center;">暂无模型消耗明细记录</div>
</div>
`;
}
else {
modelPanelHtml = `
<div class="agy-ta-panel" style="margin-top:10px;">
<div class="agy-ta-panel-title">各模型累计消耗分布（共 ${modelEntries.length} 个模型）</div>
<div class="agy-ta-bar-track" style="height:10px;">
<div class="agy-ta-bar-fill" style="width:100%;">
${modelEntries.map(([name, m]) => {
const mTot = Number(m && m.total) || 0;
const pct = totalModelSum > 0 ? (mTot / totalModelSum) * 100 : 0;
const col = palette.getColor(name);
return `<div class="agy-ta-seg-model" style="width:${pct.toFixed(2)}%; background:${col};" title="${escHtml(name)}: ${formatActivityTokens(mTot)} (${pct.toFixed(1)}%)"></div>`;
}).join('')}
</div>
</div>
<div class="agy-ta-model-list">
${modelEntries.map(([name, m]) => {
const mTot = Number(m && m.total) || 0;
const mIn = Number(m && m.in) || 0;
const mCache = Number(m && m.cache) || 0;
const mOut = Number(m && m.out) || 0;
const pct = totalModelSum > 0 ? (mTot / totalModelSum) * 100 : 0;
const col = palette.getColor(name);
const stepsPart = m.steps ? ` · ${m.steps} 步` : '';
return `
<div class="agy-ta-model-item">
<div class="agy-ta-model-row-head">
<span class="agy-ta-model-name"><span class="agy-ta-model-inline-dot" style="background:${col};"></span>${escHtml(name)}</span>
<span class="agy-ta-comp-val">${formatActivityTokens(mTot)} (${pct.toFixed(1)}%)</span>
</div>
<div class="agy-ta-comp-track">
<div class="agy-ta-comp-fill" style="width:${pct.toFixed(2)}%; background:${col};"></div>
</div>
<div class="agy-ta-model-meta">
输入 ${formatActivityTokens(mIn)} · 缓存 ${formatActivityTokens(mCache)} · 输出 ${formatActivityTokens(mOut)}${stepsPart}
</div>
</div>
`;
}).join('')}
</div>
</div>
`;
}

listEl.innerHTML = `
<div class="agy-ta-total-grid">
<div class="agy-ta-panel">
<div class="agy-ta-panel-title">Token 类型构成（共 ${formatActivityTokens(all.total)}）</div>
<div class="agy-ta-comp-item">
<div class="agy-ta-comp-head">
<span>输入 (Input)</span>
<span class="agy-ta-comp-val">${formatActivityTokens(allIn)} (${inPct.toFixed(1)}%)</span>
</div>
<div class="agy-ta-comp-track">
<div class="agy-ta-comp-fill" style="width:${inPct.toFixed(2)}%; background:var(--agy-ta-tok-in, #A78BFA);"></div>
</div>
</div>
<div class="agy-ta-comp-item">
<div class="agy-ta-comp-head">
<span>缓存读取 (Cache Read)</span>
<span class="agy-ta-comp-val">${formatActivityTokens(allCache)} (${cacheCompPct.toFixed(1)}%)</span>
</div>
<div class="agy-ta-comp-track">
<div class="agy-ta-comp-fill" style="width:${cacheCompPct.toFixed(2)}%; background:var(--agy-ta-desktop-color, #D965B5);"></div>
</div>
</div>
<div class="agy-ta-comp-item">
<div class="agy-ta-comp-head">
<span>输出 (Output)</span>
<span class="agy-ta-comp-val">${formatActivityTokens(allOut)} (${outPct.toFixed(1)}%)</span>
</div>
<div class="agy-ta-comp-track">
<div class="agy-ta-comp-fill" style="width:${outPct.toFixed(2)}%; background:var(--agy-ta-tok-out, #34D399);"></div>
</div>
</div>
</div>
<div class="agy-ta-panel">
<div class="agy-ta-panel-title">端侧来源分布 · ${Number(all.activeDays) || 0} 活跃天</div>
<div class="agy-ta-bar-track" style="height:10px;">
<div class="agy-ta-bar-fill" style="width:${srcSum > 0 ? 100 : 0}%;">
<div class="agy-ta-seg-desktop" style="width:${desktopPct.toFixed(2)}%;"></div>
<div class="agy-ta-seg-cli" style="width:${cliPct.toFixed(2)}%;"></div>
</div>
</div>
<div class="agy-ta-comp-item">
<div class="agy-ta-comp-head">
<span style="display:inline-flex;align-items:center;gap:6px;"><span class="agy-ta-src-dot" style="background:var(--agy-ta-desktop-color, #D965B5);"></span>Desktop (Antigravity 2.0)</span>
<span class="agy-ta-comp-val">${formatActivityTokens(allDesktop)} (${desktopPct.toFixed(1)}%)</span>
</div>
</div>
<div class="agy-ta-comp-item">
<div class="agy-ta-comp-head">
<span style="display:inline-flex;align-items:center;gap:6px;"><span class="agy-ta-src-dot" style="background:var(--agy-ta-cli-color, #60A5FA);"></span>CLI (agy)</span>
<span class="agy-ta-comp-val">${formatActivityTokens(allCli)} (${cliPct.toFixed(1)}%)</span>
</div>
</div>
<div class="agy-ta-row-sub" style="margin-top:auto;padding-top:4px;border-top:1px solid var(--agy-ta-divider, rgba(255,255,255,0.06));">
<span>累计：${escHtml(convText)}</span>
<span>平均缓存率 ${calcCachePct(all)}%</span>
</div>
</div>
</div>
${modelPanelHtml}
`;
}
listEl.scrollTop = prevScroll;
}
function renderActivityModalData() {
if (!activityOverlayEl)
return;
const stats = activityStatsCache || normalizeActivityStats(null);
if (activityRenderedTodayKey !== stats.todayKey) {
buildHeatmapStructure(stats.todayKey);
}
const today = stats.today;
const thisWeek = stats.thisWeek;
const thisMonth = stats.thisMonth;
const allTime = stats.allTime;
const setRoleText = (role, txt) => {
const el = activityOverlayEl.querySelector(`[data-role="${role}"]`);
if (el)
el.textContent = txt;
};
setRoleText('kpi-today-val', formatActivityTokens(today.total));
setRoleText('kpi-today-sub', `Desktop ${formatActivityTokens(today.desktop)} · CLI ${formatActivityTokens(today.cli)}`);
setRoleText('kpi-week-val', formatActivityTokens(thisWeek.total));
setRoleText('kpi-week-sub', `缓存率 ${calcCachePct(thisWeek)}% · 输出 ${formatActivityTokens(thisWeek.out)}`);
setRoleText('kpi-month-val', formatActivityTokens(thisMonth.total));
setRoleText('kpi-month-sub', `活跃 ${Number(thisMonth.activeDays) || 0} 天 · Desktop ${formatActivityTokens(thisMonth.desktop)} / CLI ${formatActivityTokens(thisMonth.cli)}`);
setRoleText('kpi-all-val', formatActivityTokens(allTime.total));
setRoleText('kpi-all-sub', `共 ${Number(allTime.activeDays) || 0} 活跃天 · 缓存率 ${calcCachePct(allTime)}%`);
const light = isLightTheme();
activityOverlayEl.classList.toggle(LIGHT_MODAL_CLASS, light);
activityOverlayEl.setAttribute('data-agy-theme', light ? 'light' : 'dark');
const cells = activityOverlayEl.querySelectorAll('.agy-ta-cell[data-date]');
for (const cell of cells) {
const dateStr = cell.getAttribute('data-date');
const day = getDayData(stats, dateStr);
cell.style.background = getHeatmapColor(day.total, light);
}
if (activityHoveredDate && activityHoveredCell) {
showActivityTooltip(activityHoveredCell, activityHoveredDate);
}
const tabBtns = activityOverlayEl.querySelectorAll('.agy-ta-tab[data-tab]');
for (const btn of tabBtns) {
btn.classList.toggle('is-active', btn.getAttribute('data-tab') === activityActiveTab);
}
renderBreakdownSection(stats);
}
async function refreshActivityModal() {
if (!activityModalOpen)
return;
const seq = ++activityFetchSeq;
try {
if (!electronObj || !electronObj.ipcRenderer || typeof electronObj.ipcRenderer.invoke !== 'function') {
throw new Error('ipcRenderer unavailable');
}
const raw = await electronObj.ipcRenderer.invoke('telemetry:get-activity-stats');
if (!activityModalOpen || seq !== activityFetchSeq)
return;
if (!raw || typeof raw !== 'object') {
activityFetchError = true;
if (!activityStatsCache) {
activityStatsCache = normalizeActivityStats(null);
}
}
else {
activityFetchError = false;
activityStatsCache = normalizeActivityStats(raw);
}
renderActivityModalData();
}
catch {
if (!activityModalOpen || seq !== activityFetchSeq)
return;
activityFetchError = true;
if (!activityStatsCache) {
activityStatsCache = normalizeActivityStats(null);
}
renderActivityModalData();
}
}
function closeActivityModal() {
if (!activityModalOpen && !portalOverlaySignaled)
return;
activityModalOpen = false;
activityHoveredDate = null;
activityHoveredCell = null;
activityRenderedTodayKey = null;
if (activityRefreshTimer) {
clearInterval(activityRefreshTimer);
activityRefreshTimer = null;
}
if (activityEscapeHandler && g.document && typeof g.document.removeEventListener === 'function') {
g.document.removeEventListener('keydown', activityEscapeHandler, true);
activityEscapeHandler = null;
}
if (activityOverlayEl && activityOverlayEl.parentNode) {
activityOverlayEl.parentNode.removeChild(activityOverlayEl);
}
activityOverlayEl = null;
if (portalOverlaySignaled) {
portalOverlaySignaled = false;
setPortalOverlayOpenSafe(false);
}
}
function handleBeforeUnload() {
try {
if (activityModalOpen || portalOverlaySignaled) {
activityModalOpen = false;
activityHoveredDate = null;
activityHoveredCell = null;
activityRenderedTodayKey = null;
if (activityRefreshTimer) {
clearInterval(activityRefreshTimer);
activityRefreshTimer = null;
}
if (activityEscapeHandler && g.document && typeof g.document.removeEventListener === 'function') {
g.document.removeEventListener('keydown', activityEscapeHandler, true);
activityEscapeHandler = null;
}
if (portalOverlaySignaled) {
portalOverlaySignaled = false;
setPortalOverlayOpenSafe(false);
}
}
}
catch { }
}
function openActivityModal() {
if (activityModalOpen)
return;
ensureModalStyles();
activityModalOpen = true;
activityFetchError = false;
activityHoveredDate = null;
activityHoveredCell = null;
activityRenderedTodayKey = null;
portalOverlaySignaled = true;
setPortalOverlayOpenSafe(true);
const light = isLightTheme();
const overlay = g.document.createElement('div');
overlay.id = MODAL_ID;
overlay.classList.toggle(LIGHT_MODAL_CLASS, light);
overlay.setAttribute('data-agy-theme', light ? 'light' : 'dark');
overlay.innerHTML = `
<div class="agy-ta-card" role="dialog" aria-modal="true" aria-label="Token 活动">
<div class="agy-ta-header">
<div class="agy-ta-title-wrap">
<span class="agy-ta-title">Token 活动</span>
<span class="agy-ta-badge"><span class="agy-ta-badge-dot"></span>Desktop + CLI 同步</span>
</div>
<div class="agy-ta-controls">
<div class="agy-ta-tabs">
<button type="button" class="agy-ta-tab" data-tab="daily">每天</button>
<button type="button" class="agy-ta-tab" data-tab="weekly">每周</button>
<button type="button" class="agy-ta-tab" data-tab="monthly">每月</button>
<button type="button" class="agy-ta-tab" data-tab="total">累计总量</button>
</div>
<button type="button" class="agy-ta-close" data-role="ta-close" title="关闭 (Esc)">×</button>
</div>
</div>
<div class="agy-ta-kpis">
<div class="agy-ta-kpi">
<div class="agy-ta-kpi-label">今日消耗</div>
<div class="agy-ta-kpi-val" data-role="kpi-today-val">--</div>
<div class="agy-ta-kpi-sub" data-role="kpi-today-sub">Desktop 0 · CLI 0</div>
</div>
<div class="agy-ta-kpi">
<div class="agy-ta-kpi-label">本周消耗</div>
<div class="agy-ta-kpi-val" data-role="kpi-week-val">--</div>
<div class="agy-ta-kpi-sub" data-role="kpi-week-sub">缓存率 0% · 输出 0</div>
</div>
<div class="agy-ta-kpi">
<div class="agy-ta-kpi-label">本月消耗</div>
<div class="agy-ta-kpi-val" data-role="kpi-month-val">--</div>
<div class="agy-ta-kpi-sub" data-role="kpi-month-sub">活跃 0 天 · Desktop 0 / CLI 0</div>
</div>
<div class="agy-ta-kpi">
<div class="agy-ta-kpi-label">累计总量</div>
<div class="agy-ta-kpi-val" data-role="kpi-all-val">--</div>
<div class="agy-ta-kpi-sub" data-role="kpi-all-sub">共 0 活跃天 · 缓存率 0%</div>
</div>
</div>
<div class="agy-ta-heatmap-section">
<div class="agy-ta-section-head">
<span class="agy-ta-section-title">近 53 周活动热力图</span>
<span class="agy-ta-legend">
<span>少</span>
<span class="agy-ta-legend-sq is-lv0"></span>
<span class="agy-ta-legend-sq is-lv1"></span>
<span class="agy-ta-legend-sq is-lv2"></span>
<span class="agy-ta-legend-sq is-lv3"></span>
<span class="agy-ta-legend-sq is-lv4"></span>
<span>多</span>
</span>
</div>
<div class="agy-ta-heatmap-scroll">
<div class="agy-ta-heatmap-inner">
<div class="agy-ta-heatmap-grid" data-role="ta-heatmap-grid"></div>
<div class="agy-ta-months" data-role="ta-months"></div>
</div>
</div>
</div>
<div class="agy-ta-breakdown-section">
<div class="agy-ta-section-head">
<span class="agy-ta-section-title" data-role="ta-bd-title">每日消耗明细</span>
<div class="agy-ta-bd-controls" data-role="ta-bd-controls">
<span class="agy-ta-src-legend" data-role="ta-src-legend">
<span class="agy-ta-src-item"><span class="agy-ta-src-dot" style="background:var(--agy-ta-desktop-color, #D965B5);"></span>Desktop</span>
<span class="agy-ta-src-item"><span class="agy-ta-src-dot" style="background:var(--agy-ta-cli-color, #60A5FA);"></span>CLI</span>
</span>
<div class="agy-ta-mode-switch" data-role="ta-mode-switch">
<button type="button" class="agy-ta-mode-btn" data-mode="source">端侧</button>
<button type="button" class="agy-ta-mode-btn" data-mode="model">模型</button>
</div>
</div>
</div>
<div class="agy-ta-breakdown-list" data-role="ta-bd-list"></div>
</div>
<div class="agy-ta-tooltip" data-role="ta-tooltip">
<div class="agy-ta-tt-date" data-role="tt-date"></div>
<div class="agy-ta-tt-total" data-role="tt-total"></div>
<div class="agy-ta-tt-sub" data-role="tt-sub"></div>
</div>
</div>
`;
overlay.addEventListener('click', (e) => {
if (e.target === overlay) {
closeActivityModal();
}
});
const card = overlay.querySelector('.agy-ta-card');
if (card) {
card.addEventListener('click', (e) => {
e.stopPropagation();
});
}
const closeBtn = overlay.querySelector('[data-role="ta-close"]');
if (closeBtn) {
closeBtn.addEventListener('click', () => {
closeActivityModal();
});
}
const tabBtns = overlay.querySelectorAll('.agy-ta-tab[data-tab]');
for (const btn of tabBtns) {
btn.addEventListener('click', () => {
const nextTab = btn.getAttribute('data-tab');
if (nextTab && nextTab !== activityActiveTab) {
activityActiveTab = nextTab;
renderActivityModalData();
}
});
}
const modeBtns = overlay.querySelectorAll('.agy-ta-mode-btn[data-mode]');
for (const btn of modeBtns) {
btn.addEventListener('click', () => {
const nextMode = btn.getAttribute('data-mode');
if (nextMode && nextMode !== activityBreakdownMode) {
activityBreakdownMode = nextMode;
renderActivityModalData();
}
});
}
const gridEl = overlay.querySelector('[data-role="ta-heatmap-grid"]');
if (gridEl) {
gridEl.addEventListener('mouseover', (e) => {
const cell = e.target && e.target.closest ? e.target.closest('.agy-ta-cell[data-date]') : null;
if (!cell)
return;
const dateStr = cell.getAttribute('data-date');
activityHoveredDate = dateStr;
activityHoveredCell = cell;
showActivityTooltip(cell, dateStr);
});
gridEl.addEventListener('mousemove', (e) => {
const cell = e.target && e.target.closest ? e.target.closest('.agy-ta-cell[data-date]') : null;
if (cell) {
const dateStr = cell.getAttribute('data-date');
if (dateStr !== activityHoveredDate) {
activityHoveredDate = dateStr;
activityHoveredCell = cell;
showActivityTooltip(cell, dateStr);
}
}
else if (e.target === gridEl) {
activityHoveredDate = null;
activityHoveredCell = null;
hideActivityTooltip();
}
});
gridEl.addEventListener('mouseleave', () => {
activityHoveredDate = null;
activityHoveredCell = null;
hideActivityTooltip();
});
}
activityEscapeHandler = (e) => {
if (e.key === 'Escape') {
e.preventDefault();
e.stopPropagation();
closeActivityModal();
}
};
g.document.addEventListener('keydown', activityEscapeHandler, true);
activityOverlayEl = overlay;
(g.document.body || g.document.documentElement).appendChild(overlay);
renderActivityModalData();
void refreshActivityModal();
activityRefreshTimer = setInterval(() => {
void refreshActivityModal();
