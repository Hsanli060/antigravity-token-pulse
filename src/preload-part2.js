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
const leftPx = Math.min(m.col * 15, 792 - 28);
return `<span class="agy-ta-month-lbl" style="left:${leftPx}px;">${escHtml(m.label)}</span>`;
})
.join('');
activityRenderedTodayKey = todayKey;
}
function resolveBreakdownBarAnim(barKey, targetPct, prevMap, nextMap) {
const clamped = Math.max(0, Math.min(100, Number(targetPct) || 0));
const prev = barKey && prevMap && typeof prevMap.get === 'function' ? prevMap.get(barKey) : undefined;
if (barKey && nextMap && typeof nextMap.set === 'function') {
nextMap.set(barKey, clamped);
}
const shouldAnimate = (prev === undefined && clamped > 0) || (prev !== undefined && Math.abs(prev - clamped) >= 0.05);
const initial = shouldAnimate ? (prev !== undefined ? prev : 0) : clamped;
return {
initialStr: initial.toFixed(2),
targetAttr: shouldAnimate ? ` data-target-width="${clamped.toFixed(2)}%"` : '',
};
}
function buildDualProgressHtml(desktop, cli, total, maxTotal, barKey, prevMap, nextMap) {
const t = Number(total) || 0;
const d = Number(desktop) || 0;
const c = Number(cli) || 0;
const widthPct = maxTotal > 0 && t > 0 ? Math.max(2, Math.min(100, (t / maxTotal) * 100)) : 0;
const splitTotal = d + c;
const desktopPct = splitTotal > 0 ? (d / splitTotal) * 100 : (t > 0 ? 100 : 0);
const cliPct = splitTotal > 0 ? Math.max(0, 100 - desktopPct) : 0;
const anim = resolveBreakdownBarAnim(barKey, widthPct, prevMap, nextMap);
return `
<div class="agy-ta-bar-track">
<div class="agy-ta-bar-fill" style="width:${anim.initialStr}%;"${anim.targetAttr}>
<div class="agy-ta-seg-desktop" style="width:${desktopPct.toFixed(2)}%;"></div>
<div class="agy-ta-seg-cli" style="width:${cliPct.toFixed(2)}%;"></div>
</div>
</div>
`;
}
function buildModelProgressHtml(modelsObj, total, maxTotal, palette, barKey, prevMap, nextMap) {
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
const anim = resolveBreakdownBarAnim(barKey, widthPct, prevMap, nextMap);
return `
<div class="agy-ta-bar-track">
<div class="agy-ta-bar-fill" style="width:${anim.initialStr}%;"${anim.targetAttr}>
${segsHtml}
</div>
</div>
`;
}
function buildModelSubHtml(modelsObj, palette) {
const entries = getSortedModelEntries(modelsObj);
if (entries.length === 0) {
return '<span class="agy-ta-ellipsis">暂无模型明细</span>';
}
const totalAll = entries.reduce((sum, [, m]) => sum + (Number(m && m.total) || 0), 0);
const named = [];
const foldedBase = [];
for (const entry of entries) {
const [name] = entry;
if (name === '其他模型' || name === '其他') {
foldedBase.push(entry);
}
else {
named.push(entry);
}
}
const topItems = [];
if (named.length === 0) {
const otherTotal = foldedBase.reduce((sum, [, m]) => sum + (Number(m && m.total) || 0), 0);
if (otherTotal > 0) {
const otherLines = foldedBase.map(([n, m]) => {
const tot = Number(m && m.total) || 0;
const pct = totalAll > 0 ? ((tot / totalAll) * 100).toFixed(1) : '0.0';
return `• ${n}: ${formatActivityTokens(tot)} (${pct}%)`;
});
topItems.push({
name: '其他',
total: otherTotal,
color: palette ? palette.getColor('其他') : '#64748B',
isOther: true,
title: `其他模型合计 ${formatActivityTokens(otherTotal)}：\n${otherLines.join('\n')}`,
});
}
}
else {
const showCount = (named.length <= 3 && foldedBase.length === 0) ? named.length : Math.min(2, named.length);
for (const [name, m] of named.slice(0, showCount)) {
const tot = Number(m && m.total) || 0;
const pct = totalAll > 0 ? ((tot / totalAll) * 100).toFixed(1) : '0.0';
topItems.push({
name,
total: tot,
color: palette ? palette.getColor(name) : '#64748B',
isOther: false,
title: `${name}: ${formatActivityTokens(tot)} (${pct}%)`,
});
}
const folded = [...named.slice(showCount), ...foldedBase];
const otherTotal = folded.reduce((sum, [, m]) => sum + (Number(m && m.total) || 0), 0);
if (otherTotal > 0) {
const otherLines = folded.map(([n, m]) => {
const tot = Number(m && m.total) || 0;
const pct = totalAll > 0 ? ((tot / totalAll) * 100).toFixed(1) : '0.0';
return `• ${n}: ${formatActivityTokens(tot)} (${pct}%)`;
});
topItems.push({
name: '其他',
total: otherTotal,
color: palette ? palette.getColor('其他') : '#64748B',
isOther: true,
title: `其他模型合计 ${formatActivityTokens(otherTotal)}：\n${otherLines.join('\n')}`,
});
}
}
return topItems.map(item =>
`<span class="agy-ta-model-chip${item.isOther ? ' is-other' : ''}" title="${escHtml(item.title)}"><span class="agy-ta-model-inline-dot" style="background:${item.color};"></span><span class="agy-ta-ellipsis">${escHtml(item.name)}</span><span class="agy-ta-model-chip-val">${formatActivityTokens(item.total)}</span></span>`
).join('<span class="agy-ta-model-sep">·</span>');
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
const totalAll = allEntries.reduce((sum, [, m]) => sum + (Number(m && m.total) || 0), 0);
const named = allEntries.filter(([name]) => name !== '其他模型' && name !== '其他');
const top4 = named.slice(0, 4);
const top4Names = new Set(top4.map(([n]) => n));
let otherSum = 0;
const otherEntries = [];
for (const [name, m] of allEntries) {
if (!top4Names.has(name)) {
const tot = Number(m && m.total) || 0;
otherSum += tot;
if (tot > 0) {
otherEntries.push([name, tot]);
}
}
}
const items = top4.map(([name, m]) => {
const tot = Number(m && m.total) || 0;
const pct = totalAll > 0 ? ((tot / totalAll) * 100).toFixed(1) : '0.0';
return {
name,
color: palette.getColor(name),
isOther: false,
title: `${name}: ${formatActivityTokens(tot)} (${pct}%)`,
};
});
if (otherSum > 0) {
const otherLines = otherEntries.map(([n, tot]) => {
const pct = totalAll > 0 ? ((tot / totalAll) * 100).toFixed(1) : '0.0';
return `• ${n}: ${formatActivityTokens(tot)} (${pct}%)`;
});
items.push({
name: '其他',
color: palette.getColor('其他'),
isOther: true,
title: `其他模型合计 ${formatActivityTokens(otherSum)}：\n${otherLines.join('\n')}`,
});
}
return items.map(it =>
`<span class="agy-ta-src-item${it.isOther ? ' is-other' : ''}" title="${escHtml(it.title)}"><span class="agy-ta-src-dot" style="background:${it.color};"></span><span class="agy-ta-ellipsis">${escHtml(it.name)}</span></span>`
).join('');
}
function buildModelsSig(modelsObj) {
const entries = getSortedModelEntries(modelsObj);
if (entries.length === 0) return '';
return entries.map(([n, m]) => `${n}:${Number(m.total) || 0}:${Number(m.in) || 0}:${Number(m.cache) || 0}:${Number(m.out) || 0}:${Number(m.steps) || 0}`).join(',');
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
const viewKey = `${activityActiveTab}:${activityActiveTab === 'total' ? 'total' : activityBreakdownMode}`;
if (viewKey !== breakdownRenderedViewKey) {
breakdownBarRenderedPct.clear();
breakdownRenderedSignature = '';
}
const palette = buildModelColorMap(stats);
const updateLegend = (rows) => {
if (!srcLegendEl)
return;
if (activityBreakdownMode === 'source') {
srcLegendEl.innerHTML = `
<span class="agy-ta-src-item" title="Desktop"><span class="agy-ta-src-dot" style="background:var(--agy-ta-desktop-color, #D965B5);"></span><span class="agy-ta-ellipsis">Desktop</span></span>
<span class="agy-ta-src-item" title="CLI"><span class="agy-ta-src-dot" style="background:var(--agy-ta-cli-color, #60A5FA);"></span><span class="agy-ta-ellipsis">CLI</span></span>
`;
}
else {
srcLegendEl.innerHTML = renderModelLegend(rows, palette);
}
};
const days = stats.days || {};
const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const nextBreakdownBarMap = new Map();
let nextSig = '';
let nextHtml = '';
if (activityActiveTab === 'daily') {
titleEl.textContent = '每日消耗明细（近 10 个活跃日）';
titleEl.title = titleEl.textContent;
const rows = Object.keys(days)
.map((dateStr) => ({ dateStr, ...getDayData(stats, dateStr) }))
.filter((r) => r.total > 0)
.sort((a, b) => (a.dateStr < b.dateStr ? 1 : -1))
.slice(0, 10);
updateLegend(rows);
nextSig = `${viewKey}|${stats.todayKey}|${activityFetchError ? 1 : 0}|` + rows.map((r) => `${r.dateStr}:${r.total}:${r.desktop}:${r.cli}:${r.in}:${r.cache}:${r.out}:${activityBreakdownMode === 'model' ? buildModelsSig(r.models) : ''}`).join(';');
if (viewKey === breakdownRenderedViewKey && nextSig === breakdownRenderedSignature && listEl.childElementCount > 0) {
return;
}
if (rows.length === 0) {
breakdownBarRenderedPct.clear();
breakdownRenderedViewKey = viewKey;
breakdownRenderedSignature = nextSig;
listEl.innerHTML = `<div class="agy-ta-empty">${activityFetchError ? '无法读取统计数据，请确认主进程已注入最新遥测模块' : '暂无 Token 消耗记录'}</div>`;
return;
}
const maxTotal = rows.reduce((mx, r) => Math.max(mx, r.total), 0);
nextHtml = rows
.map((r) => {
const dt = parseDateKeyLocal(r.dateStr);
const wd = weekdayNames[dt.getDay()];
const isToday = r.dateStr === stats.todayKey;
const periodLabel = `${r.dateStr} · ${wd}`;
const rowTooltip = buildModelTooltipAttr(periodLabel, r.models);
const titleAttr = rowTooltip ? ` title="${rowTooltip}"` : '';
const barKey = `${viewKey}:${r.dateStr}`;
const barHtml = activityBreakdownMode === 'model'
? buildModelProgressHtml(r.models, r.total, maxTotal, palette, barKey, breakdownBarRenderedPct, nextBreakdownBarMap)
: buildDualProgressHtml(r.desktop, r.cli, r.total, maxTotal, barKey, breakdownBarRenderedPct, nextBreakdownBarMap);
const leftSubText = `输入 ${formatActivityTokens(r.in)} · 缓存 ${formatActivityTokens(r.cache)} (${calcCachePct(r)}%) · 输出 ${formatActivityTokens(r.out)}`;
const srcSubText = `Desktop ${formatActivityTokens(r.desktop)} · CLI ${formatActivityTokens(r.cli)}`;
const rightSubHtml = activityBreakdownMode === 'model'
? `<span class="agy-ta-row-sub-right">${buildModelSubHtml(r.models, palette)}</span>`
: `<span class="agy-ta-row-sub-right" title="${escHtml(srcSubText)}"><span class="agy-ta-ellipsis">${escHtml(srcSubText)}</span></span>`;
return `
<div class="agy-ta-row"${titleAttr}>
<div class="agy-ta-row-top">
<span class="agy-ta-row-name"><span class="agy-ta-ellipsis">${escHtml(r.dateStr)} · ${wd}</span>${isToday ? '<span class="agy-ta-tag">今天</span>' : ''}</span>
<span class="agy-ta-row-total">${formatActivityTokens(r.total)}</span>
</div>
${barHtml}
<div class="agy-ta-row-sub">
<span class="agy-ta-row-sub-left" title="${escHtml(leftSubText)}">${escHtml(leftSubText)}</span>
${rightSubHtml}
</div>
</div>
`;
})
.join('');
}
else if (activityActiveTab === 'weekly') {
titleEl.textContent = '每周消耗对比（近 8 个 ISO 周）';
titleEl.title = titleEl.textContent;
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
nextSig = `${viewKey}|${thisWeekInfo.key}|${activityFetchError ? 1 : 0}|` + rows.map((w) => `${w.key}:${w.total}:${w.desktop}:${w.cli}:${w.activeDays}:${w.cache}:${w.out}:${activityBreakdownMode === 'model' ? buildModelsSig(w.models) : ''}`).join(';');
if (viewKey === breakdownRenderedViewKey && nextSig === breakdownRenderedSignature && listEl.childElementCount > 0) {
return;
}
if (rows.length === 0) {
breakdownBarRenderedPct.clear();
breakdownRenderedViewKey = viewKey;
breakdownRenderedSignature = nextSig;
listEl.innerHTML = `<div class="agy-ta-empty">${activityFetchError ? '无法读取统计数据，请确认主进程已注入最新遥测模块' : '暂无每周消耗记录'}</div>`;
return;
}
const maxTotal = rows.reduce((mx, r) => Math.max(mx, r.total), 0);
nextHtml = rows
.map((w) => {
const isCur = w.key === thisWeekInfo.key;
const periodLabel = `${w.key} (${w.range})`;
const rowTooltip = buildModelTooltipAttr(periodLabel, w.models);
const titleAttr = rowTooltip ? ` title="${rowTooltip}"` : '';
const barKey = `${viewKey}:${w.key}`;
const barHtml = activityBreakdownMode === 'model'
? buildModelProgressHtml(w.models, w.total, maxTotal, palette, barKey, breakdownBarRenderedPct, nextBreakdownBarMap)
: buildDualProgressHtml(w.desktop, w.cli, w.total, maxTotal, barKey, breakdownBarRenderedPct, nextBreakdownBarMap);
const leftSubText = `活跃 ${w.activeDays} 天 · 缓存率 ${calcCachePct(w)}% · 输出 ${formatActivityTokens(w.out)}`;
const srcSubText = `Desktop ${formatActivityTokens(w.desktop)} · CLI ${formatActivityTokens(w.cli)}`;
const rightSubHtml = activityBreakdownMode === 'model'
? `<span class="agy-ta-row-sub-right">${buildModelSubHtml(w.models, palette)}</span>`
: `<span class="agy-ta-row-sub-right" title="${escHtml(srcSubText)}"><span class="agy-ta-ellipsis">${escHtml(srcSubText)}</span></span>`;
return `
<div class="agy-ta-row"${titleAttr}>
<div class="agy-ta-row-top">
<span class="agy-ta-row-name"><span class="agy-ta-ellipsis">${escHtml(w.key)} (${escHtml(w.range)})</span>${isCur ? '<span class="agy-ta-tag">本周</span>' : ''}</span>
<span class="agy-ta-row-total">${formatActivityTokens(w.total)}</span>
</div>
${barHtml}
<div class="agy-ta-row-sub">
<span class="agy-ta-row-sub-left" title="${escHtml(leftSubText)}">${escHtml(leftSubText)}</span>
${rightSubHtml}
</div>
</div>
`;
})
.join('');
}
else if (activityActiveTab === 'monthly') {
titleEl.textContent = '每月消耗对比';
titleEl.title = titleEl.textContent;
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
nextSig = `${viewKey}|${curYm}|${activityFetchError ? 1 : 0}|` + rows.map((m) => `${m.ym}:${m.total}:${m.desktop}:${m.cli}:${m.activeDays}:${m.in}:${m.cache}:${m.out}:${activityBreakdownMode === 'model' ? buildModelsSig(m.models) : ''}`).join(';');
if (viewKey === breakdownRenderedViewKey && nextSig === breakdownRenderedSignature && listEl.childElementCount > 0) {
return;
}
if (rows.length === 0) {
breakdownBarRenderedPct.clear();
breakdownRenderedViewKey = viewKey;
breakdownRenderedSignature = nextSig;
listEl.innerHTML = `<div class="agy-ta-empty">${activityFetchError ? '无法读取统计数据，请确认主进程已注入最新遥测模块' : '暂无每月消耗记录'}</div>`;
return;
}
const maxTotal = rows.reduce((mx, r) => Math.max(mx, r.total), 0);
nextHtml = rows
.map((m) => {
const [yStr, mStr] = m.ym.split('-');
const label = `${yStr}年${mStr}月`;
const isCur = m.ym === curYm;
const periodLabel = label;
const rowTooltip = buildModelTooltipAttr(periodLabel, m.models);
const titleAttr = rowTooltip ? ` title="${rowTooltip}"` : '';
const barKey = `${viewKey}:${m.ym}`;
const barHtml = activityBreakdownMode === 'model'
? buildModelProgressHtml(m.models, m.total, maxTotal, palette, barKey, breakdownBarRenderedPct, nextBreakdownBarMap)
: buildDualProgressHtml(m.desktop, m.cli, m.total, maxTotal, barKey, breakdownBarRenderedPct, nextBreakdownBarMap);
const leftSubText = `输入 ${formatActivityTokens(m.in)} · 缓存 ${formatActivityTokens(m.cache)} (${calcCachePct(m)}%) · 输出 ${formatActivityTokens(m.out)} · 活跃 ${m.activeDays} 天`;
const srcSubText = `Desktop ${formatActivityTokens(m.desktop)} · CLI ${formatActivityTokens(m.cli)}`;
const rightSubHtml = activityBreakdownMode === 'model'
? `<span class="agy-ta-row-sub-right">${buildModelSubHtml(m.models, palette)}</span>`
: `<span class="agy-ta-row-sub-right" title="${escHtml(srcSubText)}"><span class="agy-ta-ellipsis">${escHtml(srcSubText)}</span></span>`;
return `
<div class="agy-ta-row"${titleAttr}>
<div class="agy-ta-row-top">
<span class="agy-ta-row-name"><span class="agy-ta-ellipsis">${escHtml(label)}</span>${isCur ? '<span class="agy-ta-tag">本月</span>' : ''}</span>
<span class="agy-ta-row-total">${formatActivityTokens(m.total)}</span>
</div>
${barHtml}
<div class="agy-ta-row-sub">
<span class="agy-ta-row-sub-left" title="${escHtml(leftSubText)}">${escHtml(leftSubText)}</span>
${rightSubHtml}
</div>
</div>
`;
})
.join('');
}
else {
titleEl.textContent = '累计总量概览与构成分布';
titleEl.title = titleEl.textContent;
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
nextSig = `${viewKey}|${Number(all.total) || 0}:${allIn}:${allCache}:${allOut}:${allDesktop}:${allCli}:${Number(all.activeDays) || 0}:${Number(all.totalConversations) || 0}:${Number(all.steps) || 0}|${buildModelsSig(allModels)}`;
if (viewKey === breakdownRenderedViewKey && nextSig === breakdownRenderedSignature && listEl.childElementCount > 0) {
return;
}

let modelPanelHtml = '';
if (modelEntries.length === 0) {
modelPanelHtml = `
<div class="agy-ta-panel">
<div class="agy-ta-panel-title" title="各模型累计消耗分布">各模型累计消耗分布</div>
<div style="color:var(--agy-ta-muted, #7E7E8E);font-size:11.5px;padding:8px 0;text-align:center;">暂无模型消耗明细记录</div>
</div>
`;
}
else {
const modelPanelTitle = `各模型累计消耗分布（共 ${modelEntries.length} 个模型）`;
const modelsAllAnim = resolveBreakdownBarAnim('total:models:all', totalModelSum > 0 ? 100 : 0, breakdownBarRenderedPct, nextBreakdownBarMap);
modelPanelHtml = `
<div class="agy-ta-panel">
<div class="agy-ta-panel-title" title="${escHtml(modelPanelTitle)}">${escHtml(modelPanelTitle)}</div>
<div class="agy-ta-bar-track" style="height:10px;">
<div class="agy-ta-bar-fill" style="width:${modelsAllAnim.initialStr}%;"${modelsAllAnim.targetAttr}>
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
const mPromptDenom = mIn + mCache;
const mCacheRate = mPromptDenom > 0 ? ((mCache / mPromptDenom) * 100).toFixed(1) : '0.0';
const stepsPart = m.steps ? ` · ${m.steps} 步` : '';
const metaText = `输入 ${formatActivityTokens(mIn)} · 缓存 ${formatActivityTokens(mCache)} (${mCacheRate}%) · 输出 ${formatActivityTokens(mOut)}${stepsPart}`;
const modelBarAnim = resolveBreakdownBarAnim(`total:model:${name}`, pct, breakdownBarRenderedPct, nextBreakdownBarMap);
return `
<div class="agy-ta-model-item">
<div class="agy-ta-model-row-head">
<span class="agy-ta-model-name" title="${escHtml(name)}"><span class="agy-ta-model-inline-dot" style="background:${col};"></span><span class="agy-ta-ellipsis">${escHtml(name)}</span></span>
<span class="agy-ta-comp-val">${formatActivityTokens(mTot)} (${pct.toFixed(1)}%)</span>
</div>
<div class="agy-ta-comp-track">
<div class="agy-ta-comp-fill" style="width:${modelBarAnim.initialStr}%; background:${col};"${modelBarAnim.targetAttr}></div>
</div>
<div class="agy-ta-model-meta" title="${escHtml(metaText)}">
${escHtml(metaText)}
</div>
</div>
`;
}).join('')}
</div>
</div>
`;
}

const inAnim = resolveBreakdownBarAnim('total:comp:in', inPct, breakdownBarRenderedPct, nextBreakdownBarMap);
const cacheAnim = resolveBreakdownBarAnim('total:comp:cache', cacheCompPct, breakdownBarRenderedPct, nextBreakdownBarMap);
const outAnim = resolveBreakdownBarAnim('total:comp:out', outPct, breakdownBarRenderedPct, nextBreakdownBarMap);
const srcAllAnim = resolveBreakdownBarAnim('total:src:all', srcSum > 0 ? 100 : 0, breakdownBarRenderedPct, nextBreakdownBarMap);
const tokPanelTitle = `Token 类型构成（共 ${formatActivityTokens(all.total)}）`;
const srcPanelTitle = `端侧来源分布 · ${Number(all.activeDays) || 0} 活跃天`;
nextHtml = `
<div class="agy-ta-total-grid">
<div class="agy-ta-panel">
<div class="agy-ta-panel-title" title="${escHtml(tokPanelTitle)}">${escHtml(tokPanelTitle)}</div>
<div class="agy-ta-comp-item">
<div class="agy-ta-comp-head">
<span class="agy-ta-comp-label" title="输入 (Input)"><span class="agy-ta-ellipsis">输入 (Input)</span></span>
<span class="agy-ta-comp-val">${formatActivityTokens(allIn)} (${inPct.toFixed(1)}%)</span>
</div>
<div class="agy-ta-comp-track">
<div class="agy-ta-comp-fill" style="width:${inAnim.initialStr}%; background:var(--agy-ta-tok-in, #A78BFA);"${inAnim.targetAttr}></div>
</div>
</div>
<div class="agy-ta-comp-item">
<div class="agy-ta-comp-head">
<span class="agy-ta-comp-label" title="缓存读取 (Cache Read)"><span class="agy-ta-ellipsis">缓存读取 (Cache Read)</span></span>
<span class="agy-ta-comp-val">${formatActivityTokens(allCache)} (${cacheCompPct.toFixed(1)}%)</span>
</div>
<div class="agy-ta-comp-track">
<div class="agy-ta-comp-fill" style="width:${cacheAnim.initialStr}%; background:var(--agy-ta-desktop-color, #D965B5);"${cacheAnim.targetAttr}></div>
</div>
</div>
<div class="agy-ta-comp-item">
<div class="agy-ta-comp-head">
<span class="agy-ta-comp-label" title="输出 (Output)"><span class="agy-ta-ellipsis">输出 (Output)</span></span>
<span class="agy-ta-comp-val">${formatActivityTokens(allOut)} (${outPct.toFixed(1)}%)</span>
</div>
<div class="agy-ta-comp-track">
<div class="agy-ta-comp-fill" style="width:${outAnim.initialStr}%; background:var(--agy-ta-tok-out, #34D399);"${outAnim.targetAttr}></div>
</div>
</div>
</div>
<div class="agy-ta-panel">
<div class="agy-ta-panel-title" title="${escHtml(srcPanelTitle)}">${escHtml(srcPanelTitle)}</div>
<div class="agy-ta-bar-track" style="height:10px;">
<div class="agy-ta-bar-fill" style="width:${srcAllAnim.initialStr}%;"${srcAllAnim.targetAttr}>
<div class="agy-ta-seg-desktop" style="width:${desktopPct.toFixed(2)}%;"></div>
<div class="agy-ta-seg-cli" style="width:${cliPct.toFixed(2)}%;"></div>
</div>
</div>
<div class="agy-ta-comp-item">
<div class="agy-ta-comp-head">
<span class="agy-ta-comp-label" title="Desktop (Antigravity 2.0)"><span class="agy-ta-src-dot" style="background:var(--agy-ta-desktop-color, #D965B5);"></span><span class="agy-ta-ellipsis">Desktop (Antigravity 2.0)</span></span>
<span class="agy-ta-comp-val">${formatActivityTokens(allDesktop)} (${desktopPct.toFixed(1)}%)</span>
</div>
</div>
<div class="agy-ta-comp-item">
<div class="agy-ta-comp-head">
<span class="agy-ta-comp-label" title="CLI (agy)"><span class="agy-ta-src-dot" style="background:var(--agy-ta-cli-color, #60A5FA);"></span><span class="agy-ta-ellipsis">CLI (agy)</span></span>
<span class="agy-ta-comp-val">${formatActivityTokens(allCli)} (${cliPct.toFixed(1)}%)</span>
</div>
</div>
<div class="agy-ta-panel-foot">
<span class="agy-ta-ellipsis" title="累计：${escHtml(convText)}">累计：${escHtml(convText)}</span>
<span class="agy-ta-panel-foot-right">平均缓存率 ${calcCachePct(all)}%</span>
</div>
</div>
</div>
${modelPanelHtml}
`;
}
listEl.innerHTML = nextHtml;
breakdownBarRenderedPct.clear();
for (const [k, v] of nextBreakdownBarMap.entries()) {
breakdownBarRenderedPct.set(k, v);
}
breakdownRenderedViewKey = viewKey;
breakdownRenderedSignature = nextSig;
const pendingBreakdownBars = listEl.querySelectorAll('[data-target-width]');
if (pendingBreakdownBars.length > 0) {
const applyBreakdownBars = () => {
for (const bar of pendingBreakdownBars) {
const tw = bar.getAttribute('data-target-width');
if (tw !== null) {
bar.style.width = tw;
bar.removeAttribute('data-target-width');
}
}
};
if (typeof g.requestAnimationFrame === 'function') {
g.requestAnimationFrame(() => g.requestAnimationFrame(applyBreakdownBars));
}
else {
setTimeout(applyBreakdownBars, 16);
}
}
listEl.scrollTop = prevScroll;
}
function formatResetCountdown(resetTimeStr) {
if (typeof resetTimeStr !== 'string' || !resetTimeStr.trim()) {
return '';
}
const ts = Date.parse(resetTimeStr.trim());
if (!Number.isFinite(ts)) {
return '';
}
const diffMs = ts - Date.now();
if (diffMs <= 60000) {
return '即将重置';
}
const totalMin = Math.round(diffMs / 60000);
const days = Math.floor(totalMin / (60 * 24));
const hours = Math.floor((totalMin % (60 * 24)) / 60);
const mins = totalMin % 60;
if (days > 0) {
return `${days}天${hours > 0 ? ` ${hours}h` : ''} 后重置`;
}
if (hours > 0) {
return `${hours}h${mins > 0 ? ` ${mins}m` : ''} 后重置`;
}
return `${mins}m 后重置`;
}
function formatUpdatedAgo(unixSec) {
const sec = Number(unixSec) || 0;
if (sec <= 0) {
return '';
}
const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - sec);
if (diffSec < 60) {
return '刚刚更新';
}
const mins = Math.floor(diffSec / 60);
if (mins < 60) {
return `${mins} 分钟前更新`;
}
const hours = Math.floor(mins / 60);
if (hours < 24) {
return `${hours} 小时前更新`;
}
const days = Math.floor(hours / 24);
return `${days} 天前更新`;
}
function getQuotaBarColor(pct) {
if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) {
return 'var(--agy-ta-muted)';
}
const n = Number(pct);
if (n >= 50) return 'var(--agy-ta-q-good)';
if (n >= 20) return 'var(--agy-ta-q-warn)';
return 'var(--agy-ta-q-low)';
}
function formatResetCountdownCompact(resetTimeStr) {
if (typeof resetTimeStr !== 'string' || !resetTimeStr.trim()) {
return '';
}
const ts = Date.parse(resetTimeStr.trim());
if (!Number.isFinite(ts)) {
return '';
}
const diffMs = ts - Date.now();
if (diffMs <= 60000) {
return '即将';
}
const totalMin = Math.round(diffMs / 60000);
const days = Math.floor(totalMin / (60 * 24));
const hours = Math.floor((totalMin % (60 * 24)) / 60);
const mins = totalMin % 60;
if (days > 0) {
return `${days}d${hours > 0 ? `${hours}h` : ''}`;
}
if (hours > 0) {
return `${hours}h${mins > 0 ? `${mins}m` : ''}`;
}
return `${mins}m`;
}
const ACCT_RING_CIRCUMFERENCE = 86.708; // 2 * Math.PI * 13.8
function formatQuotaRingOffset(pct) {
if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) {
return ACCT_RING_CIRCUMFERENCE.toFixed(2);
}
const clamped = Math.max(0, Math.min(100, Number(pct)));
return (ACCT_RING_CIRCUMFERENCE * (1 - clamped / 100)).toFixed(2);
}
function resolveDynamicQuotaGroups(q) {
if (!q || typeof q !== 'object') {
return [];
}
if (Array.isArray(q.groups) && q.groups.length > 0) {
return q.groups.filter((g) => g && Array.isArray(g.buckets) && g.buckets.length > 0);
}
const fallback = [];
const addFallbackGroup = (name, shortName, bShort, bLong) => {
const buckets = [];
if (bShort && typeof bShort.pct === 'number' && Number.isFinite(bShort.pct)) {
buckets.push({ window: '5h', label: '5h', pct: Math.max(0, Math.min(100, Math.round(bShort.pct))), resetTime: bShort.resetTime || '' });
}
if (bLong && typeof bLong.pct === 'number' && Number.isFinite(bLong.pct)) {
buckets.push({ window: 'weekly', label: '周', pct: Math.max(0, Math.min(100, Math.round(bLong.pct))), resetTime: bLong.resetTime || '' });
}
if (buckets.length > 0) {
fallback.push({ name, shortName, buckets });
}
};
addFallbackGroup('Gemini Models', 'Gemini', q.fiveHour, q.weekly);
addFallbackGroup(q.secondaryLabel || 'Claude / GPT', q.secondaryLabel ? (q.secondaryLabel.replace(/\s+models?$/i, '') || 'Claude / GPT') : 'Claude / GPT', q.secondaryFiveHour, q.secondaryWeekly);
addFallbackGroup('Gemini 4 Argon', 'Argon', null, q.argonWeekly);
return fallback;
}
function renderQuotaRingHtml(groupName, bucket, prevPct) {
const pct = bucket && typeof bucket.pct === 'number' && Number.isFinite(bucket.pct) ? Math.max(0, Math.min(100, Math.round(bucket.pct))) : null;
const winLabel = (bucket && bucket.label) ? String(bucket.label) : '短周期';
const resetFull = bucket && bucket.resetTime ? formatResetCountdown(bucket.resetTime) : '';
const fullTip = `${groupName} ${winLabel}额度：${pct !== null ? `${pct}%` : '未知'}${resetFull ? ` · ${resetFull}` : ''}`;
const strokeColor = getQuotaBarColor(pct);
const targetOffset = formatQuotaRingOffset(pct);
const shouldAnimate = pct !== null && (prevPct === undefined || prevPct !== pct);
const initialOffset = shouldAnimate ? formatQuotaRingOffset(prevPct !== undefined ? prevPct : 0) : targetOffset;
const isZero = pct === 0;
const valTxt = pct !== null ? `${pct}%` : '—';
const valCls = `agy-ta-ring-val${valTxt.length >= 4 ? ' is-full-pct' : ''}${isZero ? ' is-depleted' : ''}`;
return `
<div class="agy-ta-ring-wrap" title="${escHtml(fullTip)}">
<svg class="agy-ta-ring-svg" viewBox="0 0 32 32" aria-hidden="true">
<circle class="agy-ta-ring-bg" cx="16" cy="16" r="13.8"></circle>
<circle class="agy-ta-ring-arc" cx="16" cy="16" r="13.8" transform="rotate(-90 16 16)" stroke="${strokeColor}" stroke-dasharray="${ACCT_RING_CIRCUMFERENCE.toFixed(2)}" stroke-dashoffset="${initialOffset}"${isZero ? ' stroke-opacity="0"' : ''}${shouldAnimate ? ` data-target-offset="${targetOffset}"` : ''}></circle>
</svg>
<span class="${valCls}">${escHtml(valTxt)}</span>
</div>
`;
}
function renderPoolRowHtml(acctId, group, idx, ringPrevMap, ringNextMap, hasAnyDual, barPrevMap, barNextMap) {
const buckets = Array.isArray(group && group.buckets) ? group.buckets : [];
if (buckets.length === 0) {
return '';
}
const fullName = String((group && group.name) || (group && group.shortName) || '模型池');
const shortName = String((group && group.shortName) || fullName);
const primary = buckets[buckets.length - 1];
const secondary = buckets.length > 1 ? buckets[0] : null;
const showThirdCol = hasAnyDual !== undefined ? Boolean(hasAnyDual) : Boolean(secondary);
const pct = primary && typeof primary.pct === 'number' && Number.isFinite(primary.pct) ? Math.max(0, Math.min(100, Math.round(primary.pct))) : null;
const winLabel = (primary && primary.label) ? String(primary.label) : '额度';
const resetFull = primary && primary.resetTime ? formatResetCountdown(primary.resetTime) : '';
const resetShort = primary && primary.resetTime ? formatResetCountdownCompact(primary.resetTime) : '';
const isDepleted = pct === 0;
const showReset = Boolean(resetShort && pct !== null && pct < 100);
const barTip = `${fullName} (${winLabel})：${pct !== null ? `${pct}%` : '未知'}${resetFull ? ` · ${resetFull}` : ''}`;
const fillColor = getQuotaBarColor(pct);
const widthPct = pct !== null ? pct : 0;
const barKey = `${acctId}:${idx}:${primary.window || primary.label || 'primary'}`;
const prevBarPct = barPrevMap && typeof barPrevMap.get === 'function' ? barPrevMap.get(barKey) : undefined;
if (barNextMap && typeof barNextMap.set === 'function' && pct !== null) {
barNextMap.set(barKey, pct);
}
const shouldAnimateBar = pct !== null && ((prevBarPct === undefined && pct > 0) || (prevBarPct !== undefined && prevBarPct !== pct));
const initialBarWidth = shouldAnimateBar ? (prevBarPct !== undefined ? prevBarPct : 0) : widthPct;
const resetHtml = showReset
? `<span class="agy-ta-pool-reset${isDepleted ? ' is-depleted' : ''}">· ${escHtml(resetShort)}</span>`
: '';
let ringColHtml = '';
let longResetColHtml = '';
if (secondary) {
const secPct = typeof secondary.pct === 'number' && Number.isFinite(secondary.pct) ? Math.max(0, Math.min(100, Math.round(secondary.pct))) : null;
const ringKey = `${acctId}:${idx}:${secondary.window || secondary.label || 'short'}`;
const prevPct = ringPrevMap && typeof ringPrevMap.get === 'function' ? ringPrevMap.get(ringKey) : undefined;
if (ringNextMap && typeof ringNextMap.set === 'function' && secPct !== null) {
ringNextMap.set(ringKey, secPct);
}
ringColHtml = renderQuotaRingHtml(fullName, secondary, prevPct);
if (showThirdCol) {
const secResetShort = secondary.resetTime ? formatResetCountdownCompact(secondary.resetTime) : '';
const secResetFull = secondary.resetTime ? formatResetCountdown(secondary.resetTime) : '';
const showSecReset = Boolean(secResetShort && secPct !== null && secPct < 100);
const secWinLbl = secondary.label ? String(secondary.label) : '短周期';
const secTip = showSecReset ? `${fullName} ${secWinLbl}额度 · ${secResetFull || secResetShort}` : '';
longResetColHtml = `<span class="agy-ta-pool-long-reset${secPct === 0 ? ' is-depleted' : ''}"${secTip ? ` title="${escHtml(secTip)}"` : ''}>${showSecReset ? escHtml(secResetShort) : ''}</span>`;
}
}
else {
const onlyTag = `仅${winLabel}`;
ringColHtml = `<span class="agy-ta-pool-only-tag" title="${escHtml(`${fullName}仅包含${winLabel}周期限额`)}">${escHtml(onlyTag)}</span>`;
if (showThirdCol) {
longResetColHtml = `<span class="agy-ta-pool-long-reset"></span>`;
}
}
return `
<div class="agy-ta-pool-row${secondary ? '' : ' is-single-window'}">
<div class="agy-ta-pool-left" title="${escHtml(barTip)}">
<div class="agy-ta-pool-head">
<span class="agy-ta-pool-meta">
<span class="agy-ta-pool-name">${escHtml(shortName)}</span>
<span class="agy-ta-pool-win">${escHtml(winLabel)}</span>
${resetHtml}
</span>
<span class="agy-ta-pool-pct${isDepleted ? ' is-depleted' : ''}">${escHtml(pct !== null ? `${pct}%` : '—')}</span>
</div>
<div class="agy-ta-pool-track"><div class="agy-ta-pool-fill" style="width:${initialBarWidth}%; background:${fillColor};"${shouldAnimateBar ? ` data-target-width="${widthPct}%"` : ''}></div></div>
</div>
<div class="agy-ta-pool-ring-col">${ringColHtml}</div>
${longResetColHtml}
</div>
`;
}
function renderQuotaBarHtml(label, bucket, shortLabel) {
const winLabel = shortLabel || label;
const fakeGroup = {
name: label,
shortName: winLabel,
buckets: [{
window: winLabel,
label: winLabel,
pct: bucket && typeof bucket.pct === 'number' && Number.isFinite(bucket.pct) ? Math.max(0, Math.min(100, Math.round(bucket.pct))) : null,
resetTime: bucket && bucket.resetTime ? bucket.resetTime : '',
}],
};
return renderPoolRowHtml('preview', fakeGroup, 0, null, null);
}
function syncAccountsChromeAndVisibility() {
if (!activityOverlayEl) {
return;
}
const acctTabBtn = activityOverlayEl.querySelector('[data-role="ta-tab-accounts"]');
if (acctTabBtn) {
acctTabBtn.hidden = false;
}
const acctPill = activityOverlayEl.querySelector('[data-role="ta-acct-pill"]');
if (acctPill) {
const activeAcct = accountsList.find((a) => a && (a.isCurrent || a.id === accountsCurrentId)) || null;
if (accountsAvailable && activeAcct) {
const shortName = activeAcct.label || activeAcct.email || activeAcct.name || activeAcct.id;
const planTxt = activeAcct.plan && activeAcct.plan !== 'UNKNOWN' ? ` · ${activeAcct.plan}` : '';
acctPill.innerHTML = `<span class="agy-ta-ellipsis">${escHtml(shortName)}${escHtml(planTxt)}</span>`;
acctPill.title = `当前账号：${activeAcct.email || shortName}（点击管理与切换）`;
acctPill.hidden = false;
}
else {
acctPill.hidden = true;
}
}
const isAccountsView = activityActiveTab === 'accounts';
const kpisEl = activityOverlayEl.querySelector('.agy-ta-kpis');
const heatmapEl = activityOverlayEl.querySelector('.agy-ta-heatmap-section');
const breakdownEl = activityOverlayEl.querySelector('.agy-ta-breakdown-section');
const accountsSec = activityOverlayEl.querySelector('[data-role="ta-accounts-section"]');
if (kpisEl) kpisEl.style.display = isAccountsView ? 'none' : '';
if (heatmapEl) heatmapEl.style.display = isAccountsView ? 'none' : '';
if (breakdownEl) breakdownEl.style.display = isAccountsView ? 'none' : '';
if (accountsSec) accountsSec.hidden = !isAccountsView;
if (isAccountsView) {
hideActivityTooltip();
}
}
function stopAccountAddFlow(notifyBackend) {
const wasActive = accountsAddState !== 'idle';
accountsAddState = 'idle';
accountsAddAuthUrl = '';
accountsAddCopied = false;
if (accountsAddPollTimer) {
clearInterval(accountsAddPollTimer);
accountsAddPollTimer = null;
}
if (accountsAddCopiedTimer) {
clearTimeout(accountsAddCopiedTimer);
accountsAddCopiedTimer = null;
}
if (notifyBackend && wasActive && electronObj && electronObj.ipcRenderer && typeof electronObj.ipcRenderer.invoke === 'function') {
Promise.resolve(electronObj.ipcRenderer.invoke('telemetry:accounts-add-cancel')).catch(() => { });
}
}
function copyTextFallback(text) {
if (!text) return false;
try {
if (g.navigator && g.navigator.clipboard && typeof g.navigator.clipboard.writeText === 'function') {
Promise.resolve(g.navigator.clipboard.writeText(text)).catch(() => { });
return true;
}
}
catch { }
try {
if (g.document && g.document.body && typeof g.document.createElement === 'function') {
const ta = g.document.createElement('textarea');
ta.value = text;
ta.style.position = 'fixed';
ta.style.opacity = '0';
g.document.body.appendChild(ta);
ta.select();
if (typeof g.document.execCommand === 'function') {
g.document.execCommand('copy');
}
g.document.body.removeChild(ta);
return true;
}
}
catch { }
return false;
}
function renderAccountsSection() {
if (!activityOverlayEl) {
return;
}
syncAccountsChromeAndVisibility();
if (activityActiveTab !== 'accounts') {
return;
}
const setRoleText = (role, txt, titleText) => {
const el = activityOverlayEl.querySelector(`[data-role="${role}"]`);
if (el) {
el.textContent = txt;
if (typeof titleText === 'string') {
el.title = titleText;
}
}
};
const metaEl = activityOverlayEl.querySelector('[data-role="ta-acct-meta"]');
const addBtn = activityOverlayEl.querySelector('[data-action="acct-add"]');
const syncBtn = activityOverlayEl.querySelector('[data-action="acct-sync-live"]');
const refreshBtn = activityOverlayEl.querySelector('[data-action="acct-refresh"]');
const noticeEl = activityOverlayEl.querySelector('[data-role="ta-acct-notice"]');
const listEl = activityOverlayEl.querySelector('[data-role="ta-acct-list"]');
if (!accountsAvailable) {
setRoleText('acct-kpi-current-val', '--', '账号引擎尚未就绪');
setRoleText('acct-kpi-count-val', '0', '账号引擎尚未就绪');
setRoleText('acct-kpi-5h-val', '--', '部署 agy-switch 引擎后可用');
setRoleText('acct-kpi-week-val', '--', '部署 agy-switch 引擎后可用');
if (metaEl) {
metaEl.textContent = accountsLoading ? '正在检测账号引擎...' : '引擎未部署';
}
if (addBtn) {
addBtn.disabled = true;
addBtn.textContent = '+ 添加账号';
}
if (syncBtn) {
syncBtn.hidden = true;
}
if (refreshBtn) {
refreshBtn.disabled = true;
refreshBtn.textContent = '刷新额度';
}
if (noticeEl) {
if (accountsErrorMsg) {
noticeEl.className = 'agy-ta-acct-notice is-error';
noticeEl.innerHTML = `<span class="agy-ta-acct-notice-text">${escHtml(accountsErrorMsg)}</span>`;
noticeEl.hidden = false;
}
else {
noticeEl.innerHTML = '';
noticeEl.hidden = true;
}
}
if (listEl) {
const unavailSig = accountsLoading ? 'unavail:loading' : 'unavail:missing';
if (unavailSig !== accountsRenderedListSignature || listEl.childElementCount === 0) {
accountsRenderedListSignature = unavailSig;
listEl.innerHTML = accountsLoading
? `<div class="agy-ta-empty">正在检测本地账号引擎与账号列表...</div>`
: `
<div class="agy-ta-empty">
<div class="agy-ta-empty-title">未检测到内置账号管理引擎 (agy-switch.exe)</div>
<div class="agy-ta-empty-desc">
重新双击运行 <span class="agy-ta-empty-code">Antigravity-Telemetry-Installer.bat</span> 即可自动从 GitHub Releases 下载并部署（无需编译 Rust）；<br/>
也可手动下载 <span class="agy-ta-empty-code">agy-switch-windows-x64.exe</span> 重命名为 <span class="agy-ta-empty-code">agy-switch.exe</span> 放入 <span class="agy-ta-empty-code">%LOCALAPPDATA%\\agy-switch\\</span> 后点击下方检测。
</div>
<div class="agy-ta-empty-actions">
<button type="button" class="agy-ta-acct-btn agy-ta-acct-btn-primary" data-action="acct-redetect">重新检测引擎</button>
<button type="button" class="agy-ta-acct-btn" data-action="acct-open-releases">打开 GitHub Releases</button>
</div>
</div>
`;
}
}
return;
}
const orderedAccounts = accountsList.slice().sort((a, b) => {
const aCur = Boolean(a && (a.isCurrent || (accountsCurrentId && a.id === accountsCurrentId)));
const bCur = Boolean(b && (b.isCurrent || (accountsCurrentId && b.id === accountsCurrentId)));
return Number(bCur) - Number(aCur);
});
const activeAcct = orderedAccounts.find((a) => a && (a.isCurrent || (accountsCurrentId && a.id === accountsCurrentId))) || null;
const readyAccts = orderedAccounts.filter((a) => a && !a.disabled && !a.validationBlocked);
const unavailableCount = Math.max(0, orderedAccounts.length - readyAccts.length);
if (activeAcct) {
const curTitle = activeAcct.label || activeAcct.email || activeAcct.name || activeAcct.id;
const curPlan = activeAcct.plan && activeAcct.plan !== 'UNKNOWN' ? ` · ${activeAcct.plan}` : '';
setRoleText('acct-kpi-current-val', `${curTitle}${curPlan}`, `当前登录：${activeAcct.email || curTitle}${curPlan}`);
}
else {
setRoleText('acct-kpi-current-val', orderedAccounts.length > 0 ? '未匹配' : '--', '当前未检测到已匹配的激活账号');
}
const countText = orderedAccounts.length === 0
? '0'
: `${orderedAccounts.length} (${readyAccts.length} 可用${unavailableCount > 0 ? ` / ${unavailableCount} 受限` : ''})`;
setRoleText('acct-kpi-count-val', countText, `共 ${orderedAccounts.length} 个已保存账号，${readyAccts.length} 个可用`);

let best5h = null;
let bestWeek = null;
for (const a of readyAccts) {
const q = a && a.quota ? a.quota : null;
const dynGroups = resolveDynamicQuotaGroups(q);
const firstGrp = dynGroups[0] || null;
const firstBuckets = firstGrp && Array.isArray(firstGrp.buckets) ? firstGrp.buckets : [];
const dynLong = firstBuckets.length > 0 ? firstBuckets[firstBuckets.length - 1] : null;
const dynShort = firstBuckets.length > 1 ? firstBuckets[0] : null;
const p5 = (q && q.fiveHour && typeof q.fiveHour.pct === 'number' && Number.isFinite(q.fiveHour.pct))
? Math.round(q.fiveHour.pct)
: (dynShort && typeof dynShort.pct === 'number' ? Math.round(dynShort.pct) : null);
const pw = (q && q.weekly && typeof q.weekly.pct === 'number' && Number.isFinite(q.weekly.pct))
? Math.round(q.weekly.pct)
: (dynLong && typeof dynLong.pct === 'number' ? Math.round(dynLong.pct) : null);
const who = a.label || a.email || a.name || a.id;
if (p5 !== null && (!best5h || p5 > best5h.pct)) {
best5h = { pct: p5, who };
}
if (pw !== null && (!bestWeek || pw > bestWeek.pct)) {
bestWeek = { pct: pw, who };
}
}
setRoleText('acct-kpi-5h-val', best5h ? `${best5h.pct}%` : '--', best5h ? `最高可用短周期额度：${best5h.who} (${best5h.pct}%)` : '点击刷新额度获取');
setRoleText('acct-kpi-week-val', bestWeek ? `${bestWeek.pct}%` : '--', bestWeek ? `最高可用长周期额度：${bestWeek.who} (${bestWeek.pct}%)` : '点击刷新额度获取');

const anyBusy = Boolean(accountsSwitchingId || accountsDeletingId);
const isAdding = accountsAddState !== 'idle';
if (metaEl) {
let latestTs = 0;
for (const a of orderedAccounts) {
if (a && Number(a.lastUpdated) > latestTs) {
latestTs = Number(a.lastUpdated);
}
}
const agoTxt = formatUpdatedAgo(latestTs);
metaEl.textContent = accountsLoading
? '读取本地账号列表...'
: `共 ${orderedAccounts.length} 个${agoTxt ? ` · ${agoTxt}` : ''}`;
}
if (addBtn) {
addBtn.disabled = anyBusy || accountsAddState === 'starting' || accountsAddState === 'finalizing';
addBtn.textContent = accountsAddState === 'starting'
? '启动授权中...'
: accountsAddState === 'waiting_browser'
? '等待浏览器授权...'
: accountsAddState === 'finalizing'
? '同步账号中...'
: '+ 添加账号';
}
if (syncBtn) {
syncBtn.hidden = !accountsCanSync;
syncBtn.disabled = accountsSyncing || accountsRefreshing || anyBusy || isAdding;
syncBtn.textContent = accountsSyncing ? '同步中...' : '同步当前';
}
if (refreshBtn) {
refreshBtn.disabled = accountsRefreshing || accountsSyncing || anyBusy || isAdding;
refreshBtn.textContent = accountsRefreshing ? '刷新中...' : '刷新额度';
}
if (noticeEl) {
if (accountsErrorMsg) {
noticeEl.className = 'agy-ta-acct-notice is-error';
noticeEl.innerHTML = `<span class="agy-ta-acct-notice-text">${escHtml(accountsErrorMsg)}</span>`;
noticeEl.hidden = false;
}
else if (accountsSwitchingId) {
noticeEl.className = 'agy-ta-acct-notice is-warn';
const txt = accountsStatusMsg || '正在后台切换账号并重启 Antigravity 2.0，请勿重复点击...';
noticeEl.innerHTML = `<span class="agy-ta-acct-notice-text">${escHtml(txt)}</span>`;
noticeEl.hidden = false;
}
else if (isAdding) {
noticeEl.className = 'agy-ta-acct-notice is-warn';
const txt = accountsAddState === 'starting'
? '正在后台准备 Google 授权服务，即将自动打开浏览器...'
: accountsAddState === 'finalizing'
? '已收到授权回调，正在静默同步账号与配额...'
: '已自动打开浏览器，请在浏览器中完成 Google 登录授权（完成后将自动同步）';
const openBtnHtml = accountsAddAuthUrl
? `<button type="button" class="agy-ta-acct-btn agy-ta-acct-btn-sm" data-action="acct-add-open">重新打开浏览器</button>`
: '';
const copyBtnHtml = accountsAddAuthUrl
? `<button type="button" class="agy-ta-acct-btn agy-ta-acct-btn-sm" data-action="acct-add-copy">${accountsAddCopied ? '已复制 ✓' : '复制链接'}</button>`
: '';
const cancelBtnHtml = accountsAddState !== 'finalizing'
? `<button type="button" class="agy-ta-acct-btn agy-ta-acct-btn-sm" data-action="acct-add-cancel">取消</button>`
: '';
noticeEl.innerHTML = `
<span class="agy-ta-acct-notice-text">${escHtml(txt)}</span>
<span class="agy-ta-acct-notice-actions">${openBtnHtml}${copyBtnHtml}${cancelBtnHtml}</span>
`;
noticeEl.hidden = false;
}
else if (accountsStatusMsg) {
noticeEl.className = 'agy-ta-acct-notice';
noticeEl.innerHTML = `<span class="agy-ta-acct-notice-text">${escHtml(accountsStatusMsg)}</span>`;
noticeEl.hidden = false;
}
else {
noticeEl.innerHTML = '';
noticeEl.hidden = true;
}
}
if (!listEl) {
return;
}
const prevScroll = listEl.scrollTop;
if (accountsLoading && orderedAccounts.length === 0) {
const loadingSig = 'avail:loading';
if (loadingSig !== accountsRenderedListSignature || listEl.childElementCount === 0) {
accountsRenderedListSignature = loadingSig;
listEl.innerHTML = `<div class="agy-ta-empty">正在读取本地账号缓存...</div>`;
}
return;
}
if (orderedAccounts.length === 0) {
const emptySig = `avail:empty:${anyBusy ? 1 : 0}:${isAdding ? 1 : 0}`;
if (emptySig !== accountsRenderedListSignature || listEl.childElementCount === 0) {
accountsRenderedListSignature = emptySig;
listEl.innerHTML = `
<div class="agy-ta-empty">
<div>尚未添加任何账号，点击下方按钮通过浏览器完成 Google 登录授权</div>
<button type="button" class="agy-ta-acct-btn agy-ta-acct-btn-primary" data-action="acct-add"${(anyBusy || isAdding) ? ' disabled' : ''}>${isAdding ? '等待浏览器授权...' : '+ 添加第一个账号'}</button>
</div>
`;
}
return;
}
const listSig = `${accountsSwitchingId || ''}|${accountsDeletingId || ''}|${accountsPendingConfirmId || ''}|${accountsPendingConfirmType || ''}|${accountsCurrentId || ''}|` + orderedAccounts.map((a) => {
const grps = resolveDynamicQuotaGroups(a.quota);
const gSig = grps.map((gr) => `${gr.shortName}:${(gr.buckets || []).map((b) => `${b.window}=${b.pct}@${b.resetTime || ''}`).join(',')}`).join('/');
return `${a.id}:${a.email || ''}:${a.label || ''}:${a.plan || ''}:${a.isCurrent ? 1 : 0}:${a.disabled ? 1 : 0}:${a.validationBlocked ? 1 : 0}:${a.isForbidden ? 1 : 0}:${gSig}`;
}).join(';');
if (listSig === accountsRenderedListSignature && listEl.childElementCount > 0) {
return;
}
accountsRenderedListSignature = listSig;
const nextRingPctMap = new Map();
const nextBarPctMap = new Map();
listEl.innerHTML = orderedAccounts.map((acct) => {
const isCurrent = Boolean(acct.isCurrent || (accountsCurrentId && acct.id === accountsCurrentId));
const isUnavailable = Boolean(acct.disabled || acct.validationBlocked);
const isSwitchingThis = accountsSwitchingId === acct.id;
const isDeletingThis = accountsDeletingId === acct.id;
const isConfirmSwitch = !isCurrent && !isUnavailable && !anyBusy && accountsPendingConfirmId === acct.id && accountsPendingConfirmType === 'switch';
const isConfirmDelete = !anyBusy && accountsPendingConfirmId === acct.id && accountsPendingConfirmType === 'delete';
const titleEmail = acct.email || acct.name || acct.id;
const activeDotHtml = isCurrent ? `<span class="agy-ta-acct-active-dot" title="当前登录账号"></span>` : '';
const planBadge = acct.plan && acct.plan !== 'UNKNOWN'
? `<span class="agy-ta-tag" title="${escHtml(acct.planRaw || acct.plan)}">${escHtml(acct.plan)}</span>`
: '';
const labelBadge = acct.label
? `<span class="agy-ta-acct-label agy-ta-ellipsis" title="${escHtml(acct.label)}">${escHtml(acct.label)}</span>`
: '';
const statusTags = [
acct.disabled ? `<span class="agy-ta-tag agy-ta-acct-tag-danger">已禁用</span>` : '',
acct.validationBlocked ? `<span class="agy-ta-tag agy-ta-acct-tag-warn">需验证</span>` : '',
acct.isForbidden ? `<span class="agy-ta-tag agy-ta-acct-tag-danger">受限</span>` : '',
].filter(Boolean).join('');
const deleteTriggerHtml = `<button type="button" class="agy-ta-acct-btn agy-ta-acct-btn-ghost-danger" data-action="acct-delete" data-account-id="${escHtml(acct.id)}" title="从 agy-switch 本地列表中移除该账号"${anyBusy ? ' disabled' : ''}>删除</button>`;
let actionHtml = '';
if (isSwitchingThis) {
actionHtml = `<button type="button" class="agy-ta-acct-btn" disabled>切换中...</button>`;
}
else if (isDeletingThis) {
actionHtml = `<button type="button" class="agy-ta-acct-btn agy-ta-acct-btn-danger" disabled>删除中...</button>`;
}
else if (isConfirmSwitch) {
actionHtml = `
<span class="agy-ta-acct-confirm-hint">重启?</span>
<button type="button" class="agy-ta-acct-btn agy-ta-acct-btn-danger" data-action="acct-confirm" data-account-id="${escHtml(acct.id)}">确认</button>
<button type="button" class="agy-ta-acct-btn" data-action="acct-cancel">取消</button>
`;
}
else if (isConfirmDelete) {
actionHtml = `
<span class="agy-ta-acct-confirm-hint">${isCurrent ? '移除当前?' : '移除?'}</span>
<button type="button" class="agy-ta-acct-btn agy-ta-acct-btn-danger" data-action="acct-delete-confirm" data-account-id="${escHtml(acct.id)}">确认</button>
<button type="button" class="agy-ta-acct-btn" data-action="acct-cancel">取消</button>
`;
}
else if (isCurrent) {
actionHtml = `<span class="agy-ta-acct-state-lbl">当前</span>${deleteTriggerHtml}`;
}
else if (isUnavailable) {
actionHtml = `<span class="agy-ta-acct-state-lbl is-muted">不可用</span>${deleteTriggerHtml}`;
}
else {
actionHtml = `<button type="button" class="agy-ta-acct-btn" data-action="acct-switch" data-account-id="${escHtml(acct.id)}"${anyBusy ? ' disabled' : ''}>切换</button>${deleteTriggerHtml}`;
}
const dynGroups = resolveDynamicQuotaGroups(acct.quota);
const hasAnyDual = dynGroups.some((g) => g && Array.isArray(g.buckets) && g.buckets.length > 1);
const poolsHtml = dynGroups.length > 0
? dynGroups.map((grp, idx) => renderPoolRowHtml(acct.id, grp, idx, accountsRingRenderedPct, nextRingPctMap, hasAnyDual, accountsBarRenderedPct, nextBarPctMap)).join('')
: `<div class="agy-ta-acct-no-quota">${acct.isForbidden ? '当前账号配额接口受限' : '暂无配额缓存，点击上方「刷新额度」获取'}</div>`;
return `
<div class="agy-ta-row agy-ta-acct-row${isCurrent ? ' is-active' : ''}${isUnavailable ? ' is-disabled' : ''}">
<div class="agy-ta-acct-top">
<div class="agy-ta-acct-identity">
${activeDotHtml}
<span class="agy-ta-acct-email agy-ta-ellipsis" title="${escHtml(titleEmail)}">${escHtml(titleEmail)}</span>
${labelBadge}
${planBadge}
${statusTags}
</div>
<div class="agy-ta-acct-actions">${actionHtml}</div>
</div>
<div class="agy-ta-acct-pools${hasAnyDual ? '' : ' is-single-only'}">
${poolsHtml}
</div>
</div>
`;
}).join('');
accountsRingRenderedPct.clear();
for (const [k, v] of nextRingPctMap.entries()) {
accountsRingRenderedPct.set(k, v);
}
accountsBarRenderedPct.clear();
for (const [k, v] of nextBarPctMap.entries()) {
accountsBarRenderedPct.set(k, v);
}
const pendingRings = listEl.querySelectorAll('.agy-ta-ring-arc[data-target-offset]');
const pendingBars = listEl.querySelectorAll('.agy-ta-pool-fill[data-target-width]');
if (pendingRings.length > 0 || pendingBars.length > 0) {
const applyAnimations = () => {
for (const arc of pendingRings) {
const targetOff = arc.getAttribute('data-target-offset');
if (targetOff !== null) {
arc.setAttribute('stroke-dashoffset', targetOff);
arc.removeAttribute('data-target-offset');
}
}
for (const bar of pendingBars) {
const targetWidth = bar.getAttribute('data-target-width');
if (targetWidth !== null) {
bar.style.width = targetWidth;
bar.removeAttribute('data-target-width');
}
}
};
if (typeof g.requestAnimationFrame === 'function') {
g.requestAnimationFrame(() => g.requestAnimationFrame(applyAnimations));
}
else {
setTimeout(applyAnimations, 16);
}
}
listEl.scrollTop = prevScroll;
}
async function refreshAccountsList(forceRemote, opts) {
const watchOnly = Boolean(opts && opts.watchOnly);
if (!activityModalOpen) {
return;
}
if (!electronObj || !electronObj.ipcRenderer || typeof electronObj.ipcRenderer.invoke !== 'function') {
accountsAvailable = false;
syncAccountsChromeAndVisibility();
return;
}
if (forceRemote && accountsRefreshing) {
return;
}
const seq = ++accountsFetchSeq;
if (forceRemote) {
accountsRefreshing = true;
accountsErrorMsg = '';
accountsStatusMsg = '';
renderAccountsSection();
}
else if (!watchOnly && !accountsAvailable && accountsList.length === 0) {
accountsLoading = true;
}
try {
const channel = forceRemote ? 'telemetry:accounts-refresh' : 'telemetry:accounts-list';
const res = await electronObj.ipcRenderer.invoke(channel);
if (!activityModalOpen || seq !== accountsFetchSeq) {
return;
}
accountsLoading = false;
accountsRefreshing = false;
if (!res || typeof res !== 'object' || !res.available) {
accountsAvailable = false;
accountsCanSync = false;
accountsList = [];
accountsCurrentId = null;
accountsPendingConfirmId = null;
accountsPendingConfirmType = null;
stopAccountAddFlow(false);
renderActivityModalData();
renderAccountsSection();
return;
}
if (Array.isArray(res.capabilities)) {
accountsCanSync = res.capabilities.includes('sync');
}
const nextAccounts = Array.isArray(res.accounts) ? res.accounts : [];
const prevIdsKey = accountsList.map((a) => `${a.id}:${a.lastUpdated}:${a.isCurrent}`).join('|');
const nextIdsKey = nextAccounts.map((a) => `${a.id}:${a.lastUpdated}:${a.isCurrent}`).join('|');
if (watchOnly && prevIdsKey === nextIdsKey) {
return;
}
accountsAvailable = true;
accountsList = nextAccounts;
accountsCurrentId = typeof res.currentId === 'string' ? res.currentId : null;
if (accountsPendingConfirmId && !accountsList.some((a) => a && a.id === accountsPendingConfirmId)) {
accountsPendingConfirmId = null;
accountsPendingConfirmType = null;
}
accountsErrorMsg = typeof res.error === 'string' && res.error ? res.error : '';
if (forceRemote && res.refreshed && res.refreshSummary) {
const s = res.refreshSummary;
accountsStatusMsg = `已刷新 ${Number(s.success) || 0}/${Number(s.total) || accountsList.length} 个账号额度${Number(s.failed) > 0 ? `（${Number(s.failed)} 个失败）` : ''}`;
}
renderActivityModalData();
renderAccountsSection();
if (accountsCanSync && !accountsAutoSyncedOnce && !forceRemote && !watchOnly) {
accountsAutoSyncedOnce = true;
void syncCurrentAccount(false);
}
}
catch {
if (!activityModalOpen || seq !== accountsFetchSeq) {
return;
}
accountsLoading = false;
accountsRefreshing = false;
if (forceRemote) {
accountsErrorMsg = '刷新额度失败，请稍后重试或检查网络代理';
renderAccountsSection();
}
}
}
async function syncCurrentAccount(manual) {
if (!activityModalOpen || accountsSyncing || accountsSwitchingId || accountsDeletingId || accountsAddState !== 'idle') {
return;
}
if (!electronObj || !electronObj.ipcRenderer || typeof electronObj.ipcRenderer.invoke !== 'function') {
return;
}
accountsSyncing = true;
if (manual) {
accountsErrorMsg = '';
accountsStatusMsg = '';
renderAccountsSection();
}
try {
const res = await electronObj.ipcRenderer.invoke('telemetry:accounts-sync');
if (!activityModalOpen) {
accountsSyncing = false;
return;
}
accountsSyncing = false;
if (!res || typeof res !== 'object' || !res.available) {
if (manual) {
accountsErrorMsg = (res && typeof res.error === 'string' && res.error) ? res.error : '同步当前登录账号失败';
renderAccountsSection();
}
return;
}
if (Array.isArray(res.capabilities)) {
accountsCanSync = res.capabilities.includes('sync');
}
accountsAvailable = true;
if (Array.isArray(res.accounts)) {
accountsList = res.accounts;
accountsCurrentId = typeof res.currentId === 'string' ? res.currentId : null;
}
const syncedEmail = typeof res.syncedEmail === 'string' ? res.syncedEmail : '';
if (res.imported) {
accountsErrorMsg = '';
accountsStatusMsg = syncedEmail ? `✓ 已自动导入当前登录账号：${syncedEmail}` : '✓ 已自动导入当前登录账号';
}
else if (res.changed) {
accountsErrorMsg = '';
accountsStatusMsg = syncedEmail ? `已对齐当前登录账号：${syncedEmail}` : '已对齐当前登录账号';
}
else if (manual) {
if (res.error) {
accountsStatusMsg = '';
accountsErrorMsg = res.error;
}
else if (res.synced && syncedEmail) {
accountsErrorMsg = '';
accountsStatusMsg = `当前登录账号已同步：${syncedEmail}`;
}
else {
accountsErrorMsg = '';
accountsStatusMsg = '未检测到已登录的 Antigravity 账号会话';
}
}
renderActivityModalData();
renderAccountsSection();
}
catch {
if (!activityModalOpen) {
accountsSyncing = false;
return;
}
accountsSyncing = false;
if (manual) {
accountsStatusMsg = '';
accountsErrorMsg = '同步当前登录账号失败，请稍后重试';
renderAccountsSection();
}
}
}
let accountsAddPollBusy = false;
async function pollAccountAddStatus() {
if (!activityModalOpen || accountsAddState === 'idle' || accountsAddPollBusy) {
return;
}
if (!electronObj || !electronObj.ipcRenderer || typeof electronObj.ipcRenderer.invoke !== 'function') {
stopAccountAddFlow(false);
return;
}
accountsAddPollBusy = true;
try {
const st = await electronObj.ipcRenderer.invoke('telemetry:accounts-add-status');
if (!activityModalOpen || accountsAddState === 'idle') {
return;
}
if (!st || typeof st !== 'object') {
return;
}
if (st.state === 'done') {
stopAccountAddFlow(false);
if (Array.isArray(st.accounts)) {
accountsList = st.accounts;
accountsCurrentId = typeof st.currentId === 'string' ? st.currentId : null;
}
accountsErrorMsg = typeof st.error === 'string' && st.error ? st.error : '';
accountsStatusMsg = st.addedLabel
? `✓ 已成功添加账号：${st.addedLabel}`
: '✓ 账号添加并同步成功';
renderActivityModalData();
renderAccountsSection();
return;
}
if (st.state === 'error') {
stopAccountAddFlow(false);
accountsStatusMsg = '';
accountsErrorMsg = (typeof st.error === 'string' && st.error) ? st.error : '添加账号失败，请重试';
renderAccountsSection();
return;
}
if (st.state === 'cancelled' || !st.active) {
stopAccountAddFlow(false);
accountsStatusMsg = '';
renderAccountsSection();
return;
}
const nextState = st.state === 'finalizing' ? 'finalizing' : (st.state === 'waiting_browser' ? 'waiting_browser' : 'starting');
const nextUrl = typeof st.authUrl === 'string' && st.authUrl ? st.authUrl : accountsAddAuthUrl;
if (nextState !== accountsAddState || nextUrl !== accountsAddAuthUrl) {
accountsAddState = nextState;
accountsAddAuthUrl = nextUrl;
renderAccountsSection();
}
}
catch { }
finally {
accountsAddPollBusy = false;
}
}
async function openAccountAddBrowser() {
if (!activityModalOpen || !accountsAddAuthUrl) {
return;
}
if (!electronObj || !electronObj.ipcRenderer || typeof electronObj.ipcRenderer.invoke !== 'function') {
return;
}
try {
const res = await electronObj.ipcRenderer.invoke('telemetry:accounts-add-open');
if (activityModalOpen && res && !res.ok && res.error) {
accountsErrorMsg = res.error;
renderAccountsSection();
}
}
catch { }
}
function copyAccountAddUrl() {
if (!activityModalOpen || !accountsAddAuthUrl) {
return;
}
if (copyTextFallback(accountsAddAuthUrl)) {
accountsAddCopied = true;
if (accountsAddCopiedTimer) {
clearTimeout(accountsAddCopiedTimer);
}
accountsAddCopiedTimer = setTimeout(() => {
accountsAddCopiedTimer = null;
accountsAddCopied = false;
if (activityModalOpen && accountsAddState !== 'idle') {
renderAccountsSection();
}
}, 1800);
renderAccountsSection();
}
}
async function triggerAccountAdd() {
if (!activityModalOpen || accountsSwitchingId || accountsDeletingId) {
return;
}
if (accountsAddState === 'waiting_browser' && accountsAddAuthUrl) {
await openAccountAddBrowser();
return;
}
if (accountsAddState !== 'idle') {
return;
}
if (!electronObj || !electronObj.ipcRenderer || typeof electronObj.ipcRenderer.invoke !== 'function') {
return;
}
accountsPendingConfirmId = null;
accountsPendingConfirmType = null;
accountsErrorMsg = '';
accountsStatusMsg = '';
accountsAddState = 'starting';
accountsAddAuthUrl = '';
accountsAddCopied = false;
renderAccountsSection();
try {
const res = await electronObj.ipcRenderer.invoke('telemetry:accounts-add');
if (!activityModalOpen) {
stopAccountAddFlow(true);
return;
}
if (!res || !res.ok) {
stopAccountAddFlow(false);
if (!res || !res.cancelled) {
accountsErrorMsg = (res && typeof res.error === 'string' && res.error) ? res.error : '后台静默启动 Google 授权失败';
}
renderAccountsSection();
return;
}
if (res.state === 'done') {
stopAccountAddFlow(false);
await refreshAccountsList(false);
return;
}
accountsAddState = res.state === 'finalizing' ? 'finalizing' : (res.state === 'waiting_browser' ? 'waiting_browser' : 'starting');
accountsAddAuthUrl = typeof res.authUrl === 'string' ? res.authUrl : '';
if (accountsAddPollTimer) {
clearInterval(accountsAddPollTimer);
}
accountsAddPollTimer = setInterval(() => {
void pollAccountAddStatus();
}, 800);
renderAccountsSection();
}
catch {
if (!activityModalOpen) {
return;
}
stopAccountAddFlow(false);
accountsErrorMsg = '启动后台静默授权失败，请重试';
renderAccountsSection();
}
}
async function triggerAccountDelete(accountId) {
if (!activityModalOpen || !accountId || accountsSwitchingId || accountsDeletingId) {
return;
}
if (!electronObj || !electronObj.ipcRenderer || typeof electronObj.ipcRenderer.invoke !== 'function') {
return;
}
stopAccountAddFlow(true);
const targetObj = accountsList.find((a) => a && a.id === accountId) || null;
const targetLabel = targetObj ? (targetObj.label || targetObj.email || targetObj.name || targetObj.id) : accountId;
accountsPendingConfirmId = null;
accountsPendingConfirmType = null;
accountsDeletingId = accountId;
accountsErrorMsg = '';
accountsStatusMsg = `正在从本地移除账号 ${targetLabel}...`;
renderAccountsSection();
try {
const res = await electronObj.ipcRenderer.invoke('telemetry:accounts-delete', accountId);
if (!activityModalOpen) {
return;
}
accountsDeletingId = null;
if (!res || !res.ok) {
accountsStatusMsg = '';
accountsErrorMsg = (res && typeof res.error === 'string' && res.error) ? res.error : '删除账号失败';
renderAccountsSection();
return;
}
if (Array.isArray(res.accounts)) {
accountsList = res.accounts;
accountsCurrentId = typeof res.currentId === 'string' ? res.currentId : null;
}
accountsErrorMsg = typeof res.error === 'string' && res.error ? res.error : '';
accountsStatusMsg = `已移除本地账号记录：${targetLabel}（不影响当前正在运行的登录会话）`;
renderActivityModalData();
renderAccountsSection();
}
catch {
if (!activityModalOpen) {
return;
}
accountsDeletingId = null;
accountsStatusMsg = '';
accountsErrorMsg = '调用删除账号失败';
renderAccountsSection();
}
}
async function triggerAccountSwitch(accountId) {
if (!activityModalOpen || !accountId || accountsSwitchingId || accountsDeletingId) {
return;
}
if (!electronObj || !electronObj.ipcRenderer || typeof electronObj.ipcRenderer.invoke !== 'function') {
return;
}
stopAccountAddFlow(true);
accountsPendingConfirmId = null;
accountsPendingConfirmType = null;
accountsSwitchingId = accountId;
accountsErrorMsg = '';
accountsStatusMsg = '正在后台切换账号并重启 Antigravity 2.0（约 2~4 秒，窗口关闭后将自动重新打开）...';
renderAccountsSection();
try {
const res = await electronObj.ipcRenderer.invoke('telemetry:accounts-switch', accountId);
if (!activityModalOpen) {
return;
}
if (!res || !res.ok) {
accountsSwitchingId = null;
accountsStatusMsg = '';
accountsErrorMsg = (res && typeof res.error === 'string' && res.error) ? res.error : '账号切换启动失败';
renderAccountsSection();
return;
}
if (accountsSwitchFallbackTimer) {
clearTimeout(accountsSwitchFallbackTimer);
}
accountsSwitchFallbackTimer = setTimeout(() => {
accountsSwitchFallbackTimer = null;
if (activityModalOpen && accountsSwitchingId === accountId) {
accountsSwitchingId = null;
accountsStatusMsg = '已发送切换指令；若客户端未自动重启，请在终端检查 agy-switch 状态或手动重启 Antigravity 2.0';
renderAccountsSection();
}
}, 25000);
}
catch {
if (!activityModalOpen) {
return;
}
accountsSwitchingId = null;
accountsStatusMsg = '';
accountsErrorMsg = '调用切换指令失败';
renderAccountsSection();
}
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
const setRoleText = (role, txt, titleText) => {
const el = activityOverlayEl.querySelector(`[data-role="${role}"]`);
if (el) {
el.textContent = txt;
if (typeof titleText === 'string') {
el.title = titleText;
}
}
};
const todaySub = `Desktop ${formatActivityTokens(today.desktop)} · CLI ${formatActivityTokens(today.cli)}`;
const weekSub = `缓存率 ${calcCachePct(thisWeek)}% · 输出 ${formatActivityTokens(thisWeek.out)}`;
const monthDays = `活跃 ${Number(thisMonth.activeDays) || 0} 天`;
const monthSub = `Desktop ${formatActivityTokens(thisMonth.desktop)} · CLI ${formatActivityTokens(thisMonth.cli)}`;
const allSub = `共 ${Number(allTime.activeDays) || 0} 活跃天 · 缓存率 ${calcCachePct(allTime)}%`;
setRoleText('kpi-today-val', formatActivityTokens(today.total));
setRoleText('kpi-today-sub', todaySub, todaySub);
setRoleText('kpi-week-val', formatActivityTokens(thisWeek.total));
setRoleText('kpi-week-sub', weekSub, weekSub);
setRoleText('kpi-month-days', monthDays, monthDays);
setRoleText('kpi-month-val', formatActivityTokens(thisMonth.total));
setRoleText('kpi-month-sub', monthSub, `${monthDays} · ${monthSub}`);
setRoleText('kpi-all-val', formatActivityTokens(allTime.total));
setRoleText('kpi-all-sub', allSub, allSub);
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
syncAccountsChromeAndVisibility();
for (const btn of tabBtns) {
btn.classList.toggle('is-active', btn.getAttribute('data-tab') === activityActiveTab);
}
if (activityActiveTab !== 'accounts') {
renderBreakdownSection(stats);
}
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
accountsPendingConfirmId = null;
accountsPendingConfirmType = null;
accountsSwitchingId = null;
accountsDeletingId = null;
accountsRefreshing = false;
accountsSyncing = false;
accountsAutoSyncedOnce = false;
accountsRingRenderedPct.clear();
accountsBarRenderedPct.clear();
accountsRenderedListSignature = '';
breakdownBarRenderedPct.clear();
breakdownRenderedViewKey = '';
breakdownRenderedSignature = '';
accountsErrorMsg = '';
accountsStatusMsg = '';
stopAccountAddFlow(true);
if (accountsSwitchFallbackTimer) {
clearTimeout(accountsSwitchFallbackTimer);
accountsSwitchFallbackTimer = null;
}
if (activityRefreshTimer) {
clearInterval(activityRefreshTimer);
activityRefreshTimer = null;
}
if (activityEscapeHandler && g.document && typeof g.document.removeEventListener === 'function') {
g.document.removeEventListener('keydown', activityEscapeHandler, true);
activityEscapeHandler = null;
}
if (activityFocusHandler && g.window && typeof g.window.removeEventListener === 'function') {
g.window.removeEventListener('focus', activityFocusHandler);
activityFocusHandler = null;
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
stopAccountAddFlow(true);
if (accountsSwitchFallbackTimer) {
clearTimeout(accountsSwitchFallbackTimer);
accountsSwitchFallbackTimer = null;
}
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
if (activityFocusHandler && g.window && typeof g.window.removeEventListener === 'function') {
g.window.removeEventListener('focus', activityFocusHandler);
activityFocusHandler = null;
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
<span class="agy-ta-badge" title="Desktop + CLI 同步"><span class="agy-ta-badge-dot"></span><span class="agy-ta-ellipsis">Desktop + CLI 同步</span></span>
<button type="button" class="agy-ta-acct-pill" data-role="ta-acct-pill" hidden></button>
</div>
<div class="agy-ta-controls">
<div class="agy-ta-tabs">
<button type="button" class="agy-ta-tab" data-tab="daily">每天</button>
<button type="button" class="agy-ta-tab" data-tab="weekly">每周</button>
<button type="button" class="agy-ta-tab" data-tab="monthly">每月</button>
<button type="button" class="agy-ta-tab" data-tab="total">累计总量</button>
<button type="button" class="agy-ta-tab" data-tab="accounts" data-role="ta-tab-accounts">账号</button>
</div>
<button type="button" class="agy-ta-close" data-role="ta-close" title="关闭 (Esc)">×</button>
</div>
</div>
<div class="agy-ta-kpis">
<div class="agy-ta-kpi">
<div class="agy-ta-kpi-label"><span class="agy-ta-ellipsis">今日消耗</span></div>
<div class="agy-ta-kpi-val" data-role="kpi-today-val">--</div>
<div class="agy-ta-kpi-sub" data-role="kpi-today-sub">Desktop 0 · CLI 0</div>
</div>
<div class="agy-ta-kpi">
<div class="agy-ta-kpi-label"><span class="agy-ta-ellipsis">本周消耗</span></div>
<div class="agy-ta-kpi-val" data-role="kpi-week-val">--</div>
<div class="agy-ta-kpi-sub" data-role="kpi-week-sub">缓存率 0% · 输出 0</div>
</div>
<div class="agy-ta-kpi">
<div class="agy-ta-kpi-label"><span class="agy-ta-ellipsis">本月消耗</span><span class="agy-ta-kpi-label-meta" data-role="kpi-month-days">活跃 0 天</span></div>
<div class="agy-ta-kpi-val" data-role="kpi-month-val">--</div>
<div class="agy-ta-kpi-sub" data-role="kpi-month-sub">Desktop 0 · CLI 0</div>
</div>
<div class="agy-ta-kpi">
<div class="agy-ta-kpi-label"><span class="agy-ta-ellipsis">累计总量</span></div>
<div class="agy-ta-kpi-val" data-role="kpi-all-val">--</div>
<div class="agy-ta-kpi-sub" data-role="kpi-all-sub">共 0 活跃天 · 缓存率 0%</div>
</div>
</div>
<div class="agy-ta-heatmap-section">
<div class="agy-ta-section-head">
<span class="agy-ta-section-title" title="近 53 周活动热力图">近 53 周活动热力图</span>
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
<span class="agy-ta-src-item" title="Desktop"><span class="agy-ta-src-dot" style="background:var(--agy-ta-desktop-color, #D965B5);"></span><span class="agy-ta-ellipsis">Desktop</span></span>
<span class="agy-ta-src-item" title="CLI"><span class="agy-ta-src-dot" style="background:var(--agy-ta-cli-color, #60A5FA);"></span><span class="agy-ta-ellipsis">CLI</span></span>
</span>
<div class="agy-ta-mode-switch" data-role="ta-mode-switch">
<button type="button" class="agy-ta-mode-btn" data-mode="source">端侧</button>
<button type="button" class="agy-ta-mode-btn" data-mode="model">模型</button>
</div>
</div>
</div>
<div class="agy-ta-breakdown-list" data-role="ta-bd-list"></div>
</div>
<div class="agy-ta-accounts-section" data-role="ta-accounts-section" hidden>
<div class="agy-ta-acct-summary-bar">
<span class="agy-ta-acct-sum-item is-primary"><span class="agy-ta-acct-sum-dot"></span><span class="agy-ta-acct-sum-lbl">当前</span><span class="agy-ta-acct-sum-val agy-ta-ellipsis" data-role="acct-kpi-current-val">--</span></span>
<span class="agy-ta-acct-sum-sep"></span>
<span class="agy-ta-acct-sum-item"><span class="agy-ta-acct-sum-lbl">账号</span><span class="agy-ta-acct-sum-val" data-role="acct-kpi-count-val">0</span></span>
<span class="agy-ta-acct-sum-sep"></span>
<span class="agy-ta-acct-sum-item"><span class="agy-ta-acct-sum-lbl">长周期最高</span><span class="agy-ta-acct-sum-val" data-role="acct-kpi-week-val">--</span></span>
<span class="agy-ta-acct-sum-sep"></span>
<span class="agy-ta-acct-sum-item"><span class="agy-ta-acct-sum-lbl">短周期最高</span><span class="agy-ta-acct-sum-val" data-role="acct-kpi-5h-val">--</span></span>
</div>
<div class="agy-ta-acct-panel">
<div class="agy-ta-section-head">
<div class="agy-ta-acct-head-left">
<span class="agy-ta-section-title">账号列表与配额</span>
<span class="agy-ta-acct-meta" data-role="ta-acct-meta"></span>
<span class="agy-ta-acct-legend" title="左侧进度条为长周期（周）额度，右侧动态圆环为短周期（5h）额度（单周期池直接以进度条展示）">条=长周期 · 环=短周期</span>
</div>
<div class="agy-ta-acct-head-actions">
<button type="button" class="agy-ta-acct-btn agy-ta-acct-btn-primary" data-action="acct-add">+ 添加账号</button>
<button type="button" class="agy-ta-acct-btn" data-action="acct-sync-live" hidden>同步当前</button>
<button type="button" class="agy-ta-acct-btn" data-action="acct-refresh">刷新额度</button>
</div>
</div>
<div class="agy-ta-acct-notice" data-role="ta-acct-notice" hidden></div>
<div class="agy-ta-acct-list" data-role="ta-acct-list"></div>
</div>
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
accountsPendingConfirmId = null;
accountsPendingConfirmType = null;
activityActiveTab = nextTab;
renderActivityModalData();
if (nextTab === 'accounts') {
breakdownBarRenderedPct.clear();
breakdownRenderedViewKey = '';
breakdownRenderedSignature = '';
accountsRingRenderedPct.clear();
accountsBarRenderedPct.clear();
accountsRenderedListSignature = '';
renderAccountsSection();
void refreshAccountsList(false);
}
}
});
}
const acctPillBtn = overlay.querySelector('[data-role="ta-acct-pill"]');
if (acctPillBtn) {
acctPillBtn.addEventListener('click', () => {
if (activityActiveTab !== 'accounts') {
accountsPendingConfirmId = null;
accountsPendingConfirmType = null;
activityActiveTab = 'accounts';
breakdownBarRenderedPct.clear();
breakdownRenderedViewKey = '';
breakdownRenderedSignature = '';
renderActivityModalData();
accountsRingRenderedPct.clear();
accountsBarRenderedPct.clear();
accountsRenderedListSignature = '';
renderAccountsSection();
void refreshAccountsList(false);
}
});
}
const accountsSecEl = overlay.querySelector('[data-role="ta-accounts-section"]');
if (accountsSecEl) {
accountsSecEl.addEventListener('click', (e) => {
const actionEl = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
if (!actionEl) {
return;
}
const action = actionEl.getAttribute('data-action');
if (action === 'acct-add') {
void triggerAccountAdd();
}
else if (action === 'acct-add-open') {
void openAccountAddBrowser();
}
else if (action === 'acct-add-copy') {
copyAccountAddUrl();
}
else if (action === 'acct-add-cancel') {
stopAccountAddFlow(true);
accountsStatusMsg = '';
accountsErrorMsg = '';
renderAccountsSection();
}
else if (action === 'acct-sync-live') {
void syncCurrentAccount(true);
}
else if (action === 'acct-refresh') {
void refreshAccountsList(true);
}
else if (action === 'acct-redetect') {
accountsErrorMsg = '';
accountsStatusMsg = '';
accountsLoading = true;
accountsRenderedListSignature = '';
renderAccountsSection();
void refreshAccountsList(false);
}
else if (action === 'acct-open-releases') {
if (electronObj && electronObj.ipcRenderer && typeof electronObj.ipcRenderer.invoke === 'function') {
Promise.resolve(electronObj.ipcRenderer.invoke('telemetry:accounts-open-releases')).then((res) => {
if (activityModalOpen && res && !res.ok && res.error) {
accountsErrorMsg = res.error;
renderAccountsSection();
}
}).catch(() => { });
}
}
else if (action === 'acct-switch') {
const id = actionEl.getAttribute('data-account-id');
if (id && !accountsSwitchingId && !accountsDeletingId) {
accountsPendingConfirmId = id;
accountsPendingConfirmType = 'switch';
accountsErrorMsg = '';
renderAccountsSection();
}
}
else if (action === 'acct-delete') {
const id = actionEl.getAttribute('data-account-id');
if (id && !accountsSwitchingId && !accountsDeletingId) {
accountsPendingConfirmId = id;
accountsPendingConfirmType = 'delete';
accountsErrorMsg = '';
renderAccountsSection();
}
}
else if (action === 'acct-cancel') {
accountsPendingConfirmId = null;
accountsPendingConfirmType = null;
renderAccountsSection();
}
else if (action === 'acct-confirm') {
const id = actionEl.getAttribute('data-account-id');
if (id) {
void triggerAccountSwitch(id);
}
}
else if (action === 'acct-delete-confirm') {
const id = actionEl.getAttribute('data-account-id');
if (id) {
void triggerAccountDelete(id);
}
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
activityFocusHandler = () => {
if (!activityModalOpen || !accountsAvailable || activityActiveTab !== 'accounts') {
return;
}
if (accountsAddState !== 'idle') {
void pollAccountAddStatus();
return;
}
if (!accountsSwitchingId && !accountsDeletingId && !accountsRefreshing && !accountsSyncing) {
void refreshAccountsList(false, { watchOnly: true });
}
};
if (g.window && typeof g.window.addEventListener === 'function') {
g.window.addEventListener('focus', activityFocusHandler);
}
activityOverlayEl = overlay;
(g.document.body || g.document.documentElement).appendChild(overlay);
renderActivityModalData();
if (activityActiveTab === 'accounts') {
renderAccountsSection();
}
void refreshActivityModal();
void refreshAccountsList(false);
activityRefreshTimer = setInterval(() => {
void refreshActivityModal();
