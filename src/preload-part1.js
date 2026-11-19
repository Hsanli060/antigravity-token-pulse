// === TELEMETRY_MOD_PRELOAD_START ===
function installTelemetryBar() {
const g = globalThis;
const BACKEND_SWITCH = '--agy-backend=';
const isRemoteWindow = typeof process !== 'undefined' &&
Array.isArray(process.argv) &&
(process.argv.find((a) => typeof a === 'string' && a.startsWith(BACKEND_SWITCH)) || '').slice(BACKEND_SWITCH.length) === 'ssh';
const loc = g.location;
const host = loc && loc.hostname;
const okHost = !loc ||
(/^https?:$/.test(loc.protocol || '') &&
(host === '127.0.0.1' || host === 'localhost'));
if (isRemoteWindow || !okHost || !g.document || (g.top && g.self && g.top !== g.self)) {
return;
}
if (g.__agyTelemetryBarInstalled) {
return;
}
g.__agyTelemetryBarInstalled = true;
const electronObj = typeof electron_1 !== 'undefined' ? electron_1 : (typeof require === 'function' ? require('electron') : null);
const STYLE_ID = 'agy-custom-telemetry-style';
const MODAL_STYLE_ID = 'agy-token-activity-style';
const MODAL_ID = 'agy-token-activity-modal';
const BAR_CLASS = 'agy-custom-telemetry-bar';
const LIGHT_BAR_CLASS = 'agy-tm-light';
const LIGHT_MODAL_CLASS = 'agy-ta-light';
const RING_CIRCUMFERENCE = 37.6991; // 2 * Math.PI * 6
function hasCssClass(el, cls) {
if (!el)
return false;
if (el.classList && typeof el.classList.contains === 'function') {
return el.classList.contains(cls);
}
if (typeof el.className === 'string') {
return el.className.split(/\s+/).includes(cls);
}
return false;
}
function parseCssColorLuminance(raw) {
if (typeof raw !== 'string')
return null;
const s = raw.trim();
if (!s || s === 'transparent' || s === 'none' || s === 'initial' || s === 'inherit')
return null;
let r, gCh, b, a = 1;
let m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(s);
if (m) {
const hex = m[1];
if (hex.length === 3 || hex.length === 4) {
r = parseInt(hex[0] + hex[0], 16);
gCh = parseInt(hex[1] + hex[1], 16);
b = parseInt(hex[2] + hex[2], 16);
if (hex.length === 4)
a = parseInt(hex[3] + hex[3], 16) / 255;
}
else {
r = parseInt(hex.slice(0, 2), 16);
gCh = parseInt(hex.slice(2, 4), 16);
b = parseInt(hex.slice(4, 6), 16);
if (hex.length === 8)
a = parseInt(hex.slice(6, 8), 16) / 255;
}
}
else if ((m = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s))) {
r = Number(m[1]);
gCh = Number(m[2]);
b = Number(m[3]);
if (m[4] !== undefined) {
a = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
}
}
else if ((m = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(s))) {
r = Number(m[1]) * 255;
gCh = Number(m[2]) * 255;
b = Number(m[3]) * 255;
if (m[4] !== undefined) {
a = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
}
}
else {
return null;
}
if (!Number.isFinite(r) || !Number.isFinite(gCh) || !Number.isFinite(b) || !Number.isFinite(a) || a <= 0.05) {
return null;
}
return (0.2126 * r + 0.7152 * gCh + 0.0722 * b) / 255;
}
function resolveCssVarColor(styleObj, rawVal) {
let cur = typeof rawVal === 'string' ? rawVal.trim() : '';
for (let depth = 0; depth < 3 && cur; depth++) {
if (parseCssColorLuminance(cur) !== null)
return cur;
const m = /^var\(\s*(--[^,\s)]+)(?:\s*,\s*(.+))?\)$/.exec(cur);
if (!m || !styleObj || typeof styleObj.getPropertyValue !== 'function')
break;
cur = (styleObj.getPropertyValue(m[1]) || '').trim() || (m[2] ? m[2].trim() : '');
}
return cur;
}
function isLightTheme() {
const doc = g.document;
if (!doc)
return false;
const docEl = doc.documentElement || null;
const bodyEl = doc.body || null;
const lightClasses = ['theme-light', 'light-theme', 'vscode-light'];
const darkClasses = ['theme-dark', 'dark-theme', 'vscode-dark', 'vscode-high-contrast'];
for (const cls of lightClasses) {
if (hasCssClass(bodyEl, cls) || hasCssClass(docEl, cls))
return true;
}
for (const cls of darkClasses) {
if (hasCssClass(bodyEl, cls) || hasCssClass(docEl, cls))
return false;
}
if (hasCssClass(bodyEl, 'light') || hasCssClass(docEl, 'light'))
return true;
if (hasCssClass(bodyEl, 'dark') || hasCssClass(docEl, 'dark'))
return false;
for (const el of [docEl, bodyEl]) {
if (!el || typeof el.getAttribute !== 'function')
continue;
const dt = String(el.getAttribute('data-theme') || '').trim().toLowerCase();
if (dt) {
if (dt.includes('light'))
return true;
if (dt.includes('dark'))
return false;
}
}
const inlineCs = docEl && docEl.style ? String(docEl.style.colorScheme || '').trim().toLowerCase() : '';
if (inlineCs === 'light')
return true;
if (inlineCs === 'dark')
return false;
if (typeof g.getComputedStyle === 'function') {
for (const el of [bodyEl, docEl]) {
if (!el)
continue;
try {
const cs = g.getComputedStyle(el);
if (!cs)
continue;
const bgLum = parseCssColorLuminance(cs.backgroundColor);
if (bgLum !== null)
return bgLum > 0.5;
}
catch { }
}
if (docEl) {
try {
const cs = g.getComputedStyle(docEl);
if (cs) {
if (typeof cs.getPropertyValue === 'function') {
const resolvedBg = resolveCssVarColor(cs, cs.getPropertyValue('--background'));
const varLum = parseCssColorLuminance(resolvedBg);
if (varLum !== null)
return varLum > 0.5;
}
const compCs = String(cs.colorScheme || '').trim().toLowerCase();
if (compCs === 'light')
return true;
if (compCs === 'dark')
return false;
}
}
catch { }
}
}
return false;
}
function ensureStyles() {
if (g.document.getElementById(STYLE_ID)) {
return;
}
const style = g.document.createElement('style');
style.id = STYLE_ID;
style.textContent = `
.${BAR_CLASS} {
--agy-tm-fg: #91919C;
--agy-tm-fg-hover: #D4D4E0;
--agy-tm-dot: #767886;
--agy-tm-hover-bg: rgba(255,255,255,0.08);
--agy-tm-ring-track: #52535E;
display: inline-flex;
align-items: center;
margin-left: 14px;
padding: 2px 6px;
border-radius: 5px;
font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
font-size: 12px;
font-weight: 400;
line-height: 1;
color: var(--agy-tm-fg);
white-space: nowrap;
user-select: none;
pointer-events: auto;
cursor: pointer;
flex-shrink: 0;
max-width: 100%;
box-sizing: border-box;
font-variant-numeric: tabular-nums;
font-feature-settings: "tnum" 1;
transition: background 0.15s ease, color 0.15s ease;
}
.${BAR_CLASS}.${LIGHT_BAR_CLASS} {
--agy-tm-fg: #5C6070;
--agy-tm-fg-hover: #181A24;
--agy-tm-dot: #9CA0AE;
--agy-tm-hover-bg: rgba(15, 23, 42, 0.06);
--agy-tm-ring-track: #D0D4DF;
}
.${BAR_CLASS}:hover {
background: var(--agy-tm-hover-bg);
color: var(--agy-tm-fg-hover);
}
.${BAR_CLASS}:hover .agy-tm-pri,
.${BAR_CLASS}:hover .agy-tm-sec {
color: var(--agy-tm-fg-hover);
}
.${BAR_CLASS} .agy-tm-item {
display: inline-flex;
align-items: center;
flex-shrink: 0;
white-space: nowrap;
}
.${BAR_CLASS} .agy-tm-ico {
flex-shrink: 0;
margin-right: 5px;
}
.${BAR_CLASS} .agy-tm-pri {
color: var(--agy-tm-fg);
font-weight: 400;
font-variant-numeric: tabular-nums;
font-feature-settings: "tnum" 1;
transition: color 0.15s ease;
}
.${BAR_CLASS} .agy-tm-sec {
color: var(--agy-tm-fg);
font-weight: 400;
font-variant-numeric: tabular-nums;
font-feature-settings: "tnum" 1;
transition: color 0.15s ease;
}
.${BAR_CLASS} .agy-tm-dot {
color: var(--agy-tm-dot);
font-weight: 400;
margin: 0 10px;
flex-shrink: 0;
}
.${BAR_CLASS}.is-compact {
margin-left: 6px;
padding: 2px 5px;
font-size: 11px;
flex-shrink: 1;
min-width: 0;
overflow: hidden;
}
.${BAR_CLASS}.is-compact .agy-tm-dot {
margin: 0 5px;
}
.${BAR_CLASS}.is-compact .agy-tm-ico {
width: 12px;
height: 12px;
margin-right: 3px;
}
.agy-composer-footer > div:first-child:has(> .${BAR_CLASS}.is-wrapped) {
flex-wrap: wrap;
row-gap: 3px;
}
.${BAR_CLASS}.is-wrapped {
flex-basis: 100%;
width: calc(100% - 2px);
flex-shrink: 0;
margin-left: 2px;
margin-top: 2px;
padding: 2px 4px;
font-size: 11px;
white-space: nowrap;
flex-wrap: nowrap;
overflow: hidden;
}
.${BAR_CLASS}.is-wrapped .agy-tm-dot {
margin: 0 5px;
}
.${BAR_CLASS}.is-wrapped .agy-tm-ico {
width: 12px;
height: 12px;
margin-right: 3px;
}
@container input-footer (max-width: 450px) {
.agy-composer-footer > div:first-child {
flex-wrap: wrap;
row-gap: 3px;
}
.${BAR_CLASS} {
flex-basis: 100%;
width: calc(100% - 2px);
flex-shrink: 0;
margin-left: 2px;
margin-top: 2px;
padding: 2px 4px;
font-size: 11px;
white-space: nowrap;
flex-wrap: nowrap;
overflow: hidden;
}
.${BAR_CLASS} .agy-tm-dot {
margin: 0 5px;
}
.${BAR_CLASS} .agy-tm-ico {
width: 12px;
height: 12px;
margin-right: 3px;
}
}
`;
(g.document.head || g.document.documentElement).appendChild(style);
}
function ensureModalStyles() {
if (g.document.getElementById(MODAL_STYLE_ID)) {
return;
}
const style = g.document.createElement('style');
style.id = MODAL_STYLE_ID;
style.textContent = `
#${MODAL_ID}, #${MODAL_ID} * {
box-sizing: border-box;
}
#${MODAL_ID} {
--agy-ta-overlay-bg: rgba(10, 10, 16, 0.58);
--agy-ta-fg: #E8E8F0;
--agy-ta-card-bg: #22222C;
--agy-ta-card-border: rgba(255, 255, 255, 0.1);
--agy-ta-card-shadow: 0 24px 60px rgba(0, 0, 0, 0.65);
--agy-ta-title: #F4F4FA;
--agy-ta-badge-bg: rgba(186, 74, 152, 0.16);
--agy-ta-badge-fg: #F6A5D8;
--agy-ta-badge-border: rgba(246, 165, 216, 0.25);
--agy-ta-tabs-bg: rgba(255, 255, 255, 0.04);
--agy-ta-tabs-border: rgba(255, 255, 255, 0.08);
--agy-ta-tab-fg: #9A9AA8;
--agy-ta-tab-hover-fg: #E8E8F0;
--agy-ta-tab-hover-bg: rgba(255, 255, 255, 0.06);
--agy-ta-tab-active-bg: rgba(186, 74, 152, 0.28);
--agy-ta-tab-active-fg: #F6A5D8;
--agy-ta-tab-active-border: rgba(246, 165, 216, 0.28);
--agy-ta-close-fg: #91919C;
--agy-ta-close-hover-bg: rgba(255, 255, 255, 0.09);
--agy-ta-close-hover-fg: #FFFFFF;
--agy-ta-kpi-bg: rgba(255, 255, 255, 0.03);
--agy-ta-kpi-border: rgba(255, 255, 255, 0.06);
--agy-ta-kpi-label: #8E8E9E;
--agy-ta-kpi-val: #F4F4FA;
--agy-ta-kpi-sub: #7E7E8E;
--agy-ta-divider: rgba(255, 255, 255, 0.06);
--agy-ta-section-title: #B4B4C4;
--agy-ta-muted: #7E7E8E;
--agy-ta-cell-empty: #2E2E38;
--agy-ta-cell-hover-outline: rgba(255, 255, 255, 0.55);
--agy-ta-src-legend-fg: #9A9AA8;
--agy-ta-mode-switch-bg: #262631;
--agy-ta-mode-switch-border: rgba(255, 255, 255, 0.07);
--agy-ta-mode-btn-fg: #8E8EA0;
--agy-ta-mode-btn-hover-fg: #D4D4E2;
--agy-ta-mode-btn-active-bg: rgba(217, 101, 181, 0.22);
--agy-ta-mode-btn-active-fg: #F5B4E0;
--agy-ta-model-name-fg: #E2E2EC;
--agy-ta-model-meta-fg: #9A9AA8;
--agy-ta-scrollbar: rgba(255, 255, 255, 0.14);
--agy-ta-row-bg: rgba(255, 255, 255, 0.025);
--agy-ta-row-border: rgba(255, 255, 255, 0.05);
--agy-ta-row-name-fg: #E2E2EC;
--agy-ta-tag-bg: rgba(246, 165, 216, 0.14);
--agy-ta-tag-fg: #F6A5D8;
--agy-ta-row-total-fg: #F4F4FA;
--agy-ta-track-bg: rgba(255, 255, 255, 0.06);
--agy-ta-row-sub-fg: #848494;
--agy-ta-panel-bg: rgba(255, 255, 255, 0.025);
--agy-ta-panel-border: rgba(255, 255, 255, 0.06);
--agy-ta-panel-title-fg: #D4D4E2;
--agy-ta-comp-head-fg: #A2A2B2;
--agy-ta-comp-val-fg: #EAEAF4;
--agy-ta-tt-bg: #3B3B48;
--agy-ta-tt-border: rgba(255, 255, 255, 0.1);
--agy-ta-tt-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
--agy-ta-tt-fg: #F0F0F7;
--agy-ta-tt-date-fg: #B4B4C6;
--agy-ta-tt-total-fg: #FFFFFF;
--agy-ta-tt-sub-fg: #9A9AAC;
--agy-ta-hm-0: #2E2E38;
--agy-ta-hm-1: #58294E;
--agy-ta-hm-2: #843571;
--agy-ta-hm-3: #BA4A98;
--agy-ta-hm-4: #F6A5D8;
--agy-ta-desktop-color: #D965B5;
--agy-ta-cli-color: #60A5FA;
--agy-ta-tok-in: #A78BFA;
--agy-ta-tok-out: #34D399;
--agy-ta-q-good: #34D399;
--agy-ta-q-warn: #FBBF24;
--agy-ta-q-low: #FB7185;
--agy-ta-btn-bg: rgba(255, 255, 255, 0.05);
--agy-ta-btn-border: rgba(255, 255, 255, 0.12);
--agy-ta-btn-fg: #D4D4E2;
--agy-ta-btn-hover-bg: rgba(255, 255, 255, 0.1);
--agy-ta-btn-hover-fg: #FFFFFF;
--agy-ta-danger-bg: rgba(251, 113, 133, 0.18);
--agy-ta-danger-border: rgba(251, 113, 133, 0.36);
--agy-ta-danger-fg: #FDA4AF;
--agy-ta-danger-hover-bg: rgba(251, 113, 133, 0.28);
--agy-ta-warn-bg: rgba(251, 191, 36, 0.14);
--agy-ta-warn-border: rgba(251, 191, 36, 0.28);
--agy-ta-warn-fg: #FCD34D;
position: fixed;
inset: 0;
z-index: 2147483640;
background: var(--agy-ta-overlay-bg);
backdrop-filter: blur(4px);
display: flex;
align-items: center;
justify-content: center;
font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
font-variant-numeric: tabular-nums;
font-feature-settings: "tnum" 1;
color: var(--agy-ta-fg);
user-select: none;
}
#${MODAL_ID}.${LIGHT_MODAL_CLASS} {
--agy-ta-overlay-bg: rgba(15, 23, 42, 0.36);
--agy-ta-fg: #1F2328;
--agy-ta-card-bg: #FFFFFF;
--agy-ta-card-border: rgba(15, 23, 42, 0.12);
--agy-ta-card-shadow: 0 20px 50px rgba(15, 23, 42, 0.16), 0 2px 8px rgba(15, 23, 42, 0.08);
--agy-ta-title: #111827;
--agy-ta-badge-bg: rgba(22, 163, 74, 0.12);
--agy-ta-badge-fg: #15803D;
--agy-ta-badge-border: rgba(22, 163, 74, 0.28);
--agy-ta-tabs-bg: #F3F4F6;
--agy-ta-tabs-border: #E5E7EB;
--agy-ta-tab-fg: #57606A;
--agy-ta-tab-hover-fg: #1F2328;
--agy-ta-tab-hover-bg: rgba(15, 23, 42, 0.05);
--agy-ta-tab-active-bg: rgba(22, 163, 74, 0.14);
--agy-ta-tab-active-fg: #15803D;
--agy-ta-tab-active-border: rgba(22, 163, 74, 0.32);
--agy-ta-close-fg: #57606A;
--agy-ta-close-hover-bg: rgba(15, 23, 42, 0.07);
--agy-ta-close-hover-fg: #111827;
--agy-ta-kpi-bg: #F6F8FA;
--agy-ta-kpi-border: #E2E6EC;
--agy-ta-kpi-label: #57606A;
--agy-ta-kpi-val: #111827;
--agy-ta-kpi-sub: #6E7781;
--agy-ta-divider: #E5E7EB;
--agy-ta-section-title: #374151;
--agy-ta-muted: #6E7781;
--agy-ta-cell-empty: #EBEDF0;
--agy-ta-cell-hover-outline: rgba(15, 23, 42, 0.45);
--agy-ta-src-legend-fg: #57606A;
--agy-ta-mode-switch-bg: #F3F4F6;
--agy-ta-mode-switch-border: #E5E7EB;
--agy-ta-mode-btn-fg: #57606A;
--agy-ta-mode-btn-hover-fg: #1F2328;
--agy-ta-mode-btn-active-bg: rgba(22, 163, 74, 0.14);
--agy-ta-mode-btn-active-fg: #15803D;
--agy-ta-model-name-fg: #1F2328;
--agy-ta-model-meta-fg: #57606A;
--agy-ta-scrollbar: rgba(15, 23, 42, 0.18);
--agy-ta-row-bg: #F8FAFC;
--agy-ta-row-border: #E5E7EB;
--agy-ta-row-name-fg: #1F2328;
--agy-ta-tag-bg: rgba(22, 163, 74, 0.12);
--agy-ta-tag-fg: #15803D;
--agy-ta-row-total-fg: #111827;
--agy-ta-track-bg: #E5E7EB;
--agy-ta-row-sub-fg: #57606A;
--agy-ta-panel-bg: #F8FAFC;
--agy-ta-panel-border: #E5E7EB;
--agy-ta-panel-title-fg: #1F2328;
--agy-ta-comp-head-fg: #4B5563;
--agy-ta-comp-val-fg: #111827;
--agy-ta-tt-bg: #FFFFFF;
--agy-ta-tt-border: rgba(15, 23, 42, 0.14);
--agy-ta-tt-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
--agy-ta-tt-fg: #1F2328;
--agy-ta-tt-date-fg: #57606A;
--agy-ta-tt-total-fg: #111827;
--agy-ta-tt-sub-fg: #57606A;
--agy-ta-hm-0: #EBEDF0;
--agy-ta-hm-1: #9BE9A8;
--agy-ta-hm-2: #40C463;
--agy-ta-hm-3: #30A14E;
--agy-ta-hm-4: #216E39;
--agy-ta-desktop-color: #C026D3;
--agy-ta-cli-color: #2563EB;
--agy-ta-tok-in: #7C3AED;
--agy-ta-tok-out: #16A34A;
--agy-ta-q-good: #16A34A;
--agy-ta-q-warn: #D97706;
--agy-ta-q-low: #DC2626;
--agy-ta-btn-bg: #F3F4F6;
--agy-ta-btn-border: #D1D5DB;
--agy-ta-btn-fg: #374151;
--agy-ta-btn-hover-bg: #E5E7EB;
--agy-ta-btn-hover-fg: #111827;
--agy-ta-danger-bg: rgba(220, 38, 38, 0.1);
--agy-ta-danger-border: rgba(220, 38, 38, 0.28);
--agy-ta-danger-fg: #DC2626;
--agy-ta-danger-hover-bg: rgba(220, 38, 38, 0.18);
--agy-ta-warn-bg: rgba(217, 119, 6, 0.1);
--agy-ta-warn-border: rgba(217, 119, 6, 0.26);
--agy-ta-warn-fg: #B45309;
}
#${MODAL_ID} .agy-ta-card {
width: 860px;
max-width: 94vw;
max-height: 90vh;
display: flex;
flex-direction: column;
overflow-y: auto;
background: var(--agy-ta-card-bg);
border: 1px solid var(--agy-ta-card-border);
border-radius: 14px;
padding: 22px 26px;
color: var(--agy-ta-fg);
box-shadow: var(--agy-ta-card-shadow);
cursor: default;
}
#${MODAL_ID} .agy-ta-ellipsis {
min-width: 0;
overflow: hidden;
text-overflow: ellipsis;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-header {
display: flex;
align-items: center;
justify-content: space-between;
gap: 12px;
flex-wrap: nowrap;
flex-shrink: 0;
min-width: 0;
}
#${MODAL_ID} .agy-ta-title-wrap {
display: flex;
align-items: center;
gap: 10px;
min-width: 0;
flex: 1 1 auto;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-title {
font-size: 16px;
font-weight: 600;
color: var(--agy-ta-title);
letter-spacing: 0.2px;
white-space: nowrap;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-badge {
display: inline-flex;
align-items: center;
gap: 5px;
min-width: 0;
max-width: 100%;
flex: 0 1 auto;
white-space: nowrap;
overflow: hidden;
font-size: 11px;
font-weight: 500;
padding: 2px 8px;
border-radius: 999px;
background: var(--agy-ta-badge-bg);
color: var(--agy-ta-badge-fg);
border: 1px solid var(--agy-ta-badge-border);
}
#${MODAL_ID} .agy-ta-badge-dot {
width: 6px;
height: 6px;
border-radius: 50%;
background: var(--agy-ta-badge-fg);
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-controls {
display: flex;
align-items: center;
gap: 10px;
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-tabs {
display: inline-flex;
align-items: center;
gap: 2px;
padding: 3px;
border-radius: 8px;
background: var(--agy-ta-tabs-bg);
border: 1px solid var(--agy-ta-tabs-border);
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-tab {
border: none;
background: transparent;
color: var(--agy-ta-tab-fg);
font-family: inherit;
font-size: 12px;
font-weight: 500;
padding: 5px 11px;
border-radius: 6px;
cursor: pointer;
transition: background 0.15s ease, color 0.15s ease;
outline: none;
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-tab:hover {
color: var(--agy-ta-tab-hover-fg);
background: var(--agy-ta-tab-hover-bg);
}
#${MODAL_ID} .agy-ta-tab.is-active {
background: var(--agy-ta-tab-active-bg);
color: var(--agy-ta-tab-active-fg);
box-shadow: inset 0 0 0 1px var(--agy-ta-tab-active-border);
}
#${MODAL_ID} .agy-ta-close {
width: 28px;
height: 28px;
border-radius: 7px;
border: none;
background: transparent;
color: var(--agy-ta-close-fg);
font-family: inherit;
font-size: 18px;
line-height: 1;
display: inline-flex;
align-items: center;
justify-content: center;
cursor: pointer;
transition: background 0.15s ease, color 0.15s ease;
outline: none;
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-close:hover {
background: var(--agy-ta-close-hover-bg);
color: var(--agy-ta-close-hover-fg);
}
#${MODAL_ID} .agy-ta-kpis {
display: grid;
grid-template-columns: repeat(4, minmax(0, 1fr));
gap: 10px;
margin-top: 16px;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-kpi {
background: var(--agy-ta-kpi-bg);
border: 1px solid var(--agy-ta-kpi-border);
border-radius: 10px;
padding: 11px 13px;
min-width: 0;
}
#${MODAL_ID} .agy-ta-kpi-label {
display: flex;
align-items: center;
justify-content: space-between;
gap: 6px;
font-size: 11px;
color: var(--agy-ta-kpi-label);
margin-bottom: 5px;
min-width: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-kpi-label-meta {
font-size: 10.5px;
color: var(--agy-ta-kpi-sub);
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-kpi-val {
font-size: 20px;
font-weight: 700;
color: var(--agy-ta-kpi-val);
line-height: 1.2;
letter-spacing: -0.2px;
white-space: nowrap;
overflow: hidden;
text-overflow: ellipsis;
}
#${MODAL_ID} .agy-ta-kpi-sub {
font-size: 11px;
color: var(--agy-ta-kpi-sub);
margin-top: 5px;
white-space: nowrap;
overflow: hidden;
text-overflow: ellipsis;
}
#${MODAL_ID} .agy-ta-heatmap-section {
margin-top: 16px;
padding-top: 14px;
border-top: 1px solid var(--agy-ta-divider);
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-section-head {
display: flex;
align-items: center;
justify-content: space-between;
margin-bottom: 10px;
gap: 10px;
flex-wrap: nowrap;
flex-shrink: 0;
min-width: 0;
}
#${MODAL_ID} .agy-ta-section-title {
font-size: 12px;
font-weight: 500;
color: var(--agy-ta-section-title);
white-space: nowrap;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-legend {
display: inline-flex;
align-items: center;
gap: 4px;
font-size: 11px;
color: var(--agy-ta-muted);
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-legend-sq {
width: 10px;
height: 10px;
border-radius: 2px;
display: inline-block;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-legend-sq.is-lv0 { background: var(--agy-ta-hm-0); }
#${MODAL_ID} .agy-ta-legend-sq.is-lv1 { background: var(--agy-ta-hm-1); }
#${MODAL_ID} .agy-ta-legend-sq.is-lv2 { background: var(--agy-ta-hm-2); }
#${MODAL_ID} .agy-ta-legend-sq.is-lv3 { background: var(--agy-ta-hm-3); }
#${MODAL_ID} .agy-ta-legend-sq.is-lv4 { background: var(--agy-ta-hm-4); }
#${MODAL_ID} .agy-ta-heatmap-scroll {
overflow-x: auto;
overflow-y: hidden;
padding-bottom: 2px;
}
#${MODAL_ID} .agy-ta-heatmap-inner {
width: 792px;
margin: 0 auto;
}
#${MODAL_ID} .agy-ta-heatmap-grid {
display: flex;
gap: 3px;
width: 792px;
}
#${MODAL_ID} .agy-ta-week-col {
display: flex;
flex-direction: column;
gap: 3px;
width: 12px;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-cell {
width: 12px;
height: 12px;
border-radius: 3px;
background: var(--agy-ta-cell-empty);
cursor: pointer;
transition: transform 0.08s ease;
}
#${MODAL_ID} .agy-ta-cell:hover {
outline: 1px solid var(--agy-ta-cell-hover-outline);
outline-offset: -1px;
}
#${MODAL_ID} .agy-ta-cell.is-future {
visibility: hidden;
pointer-events: none;
}
#${MODAL_ID} .agy-ta-months {
position: relative;
width: 792px;
height: 16px;
margin-top: 7px;
}
#${MODAL_ID} .agy-ta-month-lbl {
position: absolute;
top: 0;
font-size: 11px;
line-height: 16px;
color: var(--agy-ta-muted);
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-breakdown-section {
margin-top: 14px;
padding-top: 14px;
border-top: 1px solid var(--agy-ta-divider);
display: flex;
flex-direction: column;
flex-shrink: 0;
min-height: 0;
}
#${MODAL_ID} .agy-ta-src-legend {
display: inline-flex;
align-items: center;
justify-content: flex-end;
gap: 8px;
flex-wrap: nowrap;
min-width: 0;
flex: 0 1 auto;
overflow: hidden;
font-size: 11px;
color: var(--agy-ta-src-legend-fg);
}
#${MODAL_ID} .agy-ta-src-item {
display: inline-flex;
align-items: center;
gap: 4px;
white-space: nowrap;
min-width: 0;
flex: 0 1 auto;
}
#${MODAL_ID} .agy-ta-src-item.is-other {
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-src-dot {
width: 8px;
height: 8px;
border-radius: 2px;
display: inline-block;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-bd-controls {
display: inline-flex;
align-items: center;
justify-content: flex-end;
gap: 8px;
flex-wrap: nowrap;
min-width: 0;
flex: 1 1 auto;
}
#${MODAL_ID} .agy-ta-mode-switch {
display: inline-flex;
background: var(--agy-ta-mode-switch-bg);
border: 1px solid var(--agy-ta-mode-switch-border);
border-radius: 7px;
padding: 2px;
gap: 2px;
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-mode-btn {
appearance: none;
border: none;
background: transparent;
color: var(--agy-ta-mode-btn-fg);
font-size: 11px;
padding: 2px 8px;
border-radius: 5px;
cursor: pointer;
transition: all 0.15s ease;
line-height: 1.3;
font-family: inherit;
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-mode-btn:hover {
color: var(--agy-ta-mode-btn-hover-fg);
}
#${MODAL_ID} .agy-ta-mode-btn.is-active {
background: var(--agy-ta-mode-btn-active-bg);
color: var(--agy-ta-mode-btn-active-fg);
font-weight: 500;
}
#${MODAL_ID} .agy-ta-seg-model {
height: 100%;
transition: width 0.25s ease;
}
#${MODAL_ID} .agy-ta-model-inline-dot {
display: inline-block;
width: 6px;
height: 6px;
border-radius: 50%;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-model-list {
display: flex;
flex-direction: column;
gap: 7px;
margin-top: 2px;
}
#${MODAL_ID} .agy-ta-model-item {
display: flex;
flex-direction: column;
gap: 4px;
min-width: 0;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-model-row-head {
display: flex;
align-items: center;
justify-content: space-between;
gap: 8px;
font-size: 11px;
flex-wrap: nowrap;
min-width: 0;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-model-name {
display: inline-flex;
align-items: center;
gap: 6px;
color: var(--agy-ta-model-name-fg);
font-weight: 500;
min-width: 0;
flex: 1 1 auto;
white-space: nowrap;
overflow: hidden;
}
#${MODAL_ID} .agy-ta-model-meta {
color: var(--agy-ta-model-meta-fg);
font-size: 10.5px;
white-space: nowrap;
overflow: hidden;
text-overflow: ellipsis;
min-width: 0;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-breakdown-list {
max-height: 240px;
overflow-y: auto;
display: flex;
flex-direction: column;
gap: 8px;
padding-right: 4px;
}
#${MODAL_ID} .agy-ta-breakdown-list::-webkit-scrollbar,
#${MODAL_ID} .agy-ta-acct-list::-webkit-scrollbar,
#${MODAL_ID} .agy-ta-card::-webkit-scrollbar,
#${MODAL_ID} .agy-ta-heatmap-scroll::-webkit-scrollbar {
width: 5px;
height: 5px;
}
#${MODAL_ID} .agy-ta-breakdown-list::-webkit-scrollbar-thumb,
#${MODAL_ID} .agy-ta-acct-list::-webkit-scrollbar-thumb,
#${MODAL_ID} .agy-ta-card::-webkit-scrollbar-thumb,
#${MODAL_ID} .agy-ta-heatmap-scroll::-webkit-scrollbar-thumb {
background: var(--agy-ta-scrollbar);
border-radius: 999px;
}
#${MODAL_ID} .agy-ta-row {
background: var(--agy-ta-row-bg);
border: 1px solid var(--agy-ta-row-border);
border-radius: 8px;
padding: 9px 12px;
display: flex;
flex-direction: column;
gap: 6px;
min-width: 0;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-row-top {
display: flex;
align-items: center;
justify-content: space-between;
gap: 10px;
font-size: 12px;
flex-wrap: nowrap;
min-width: 0;
}
#${MODAL_ID} .agy-ta-row-name {
color: var(--agy-ta-row-name-fg);
font-weight: 500;
display: inline-flex;
align-items: center;
gap: 6px;
min-width: 0;
flex: 1 1 auto;
white-space: nowrap;
overflow: hidden;
}
#${MODAL_ID} .agy-ta-tag {
font-size: 10px;
padding: 1px 6px;
border-radius: 4px;
background: var(--agy-ta-tag-bg);
color: var(--agy-ta-tag-fg);
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-row-total {
font-weight: 600;
color: var(--agy-ta-row-total-fg);
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-bar-track {
width: 100%;
height: 6px;
border-radius: 999px;
background: var(--agy-ta-track-bg);
overflow: hidden;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-bar-fill {
height: 100%;
display: flex;
border-radius: 999px;
overflow: hidden;
transition: width 0.25s ease;
}
#${MODAL_ID} .agy-ta-seg-desktop {
height: 100%;
background: var(--agy-ta-desktop-color);
}
#${MODAL_ID} .agy-ta-seg-cli {
height: 100%;
background: var(--agy-ta-cli-color);
}
#${MODAL_ID} .agy-ta-row-sub {
display: flex;
align-items: center;
justify-content: space-between;
gap: 10px;
font-size: 11px;
color: var(--agy-ta-row-sub-fg);
flex-wrap: nowrap;
min-width: 0;
}
#${MODAL_ID} .agy-ta-row-sub-left {
flex: 0 0 auto;
white-space: nowrap;
min-width: 0;
}
#${MODAL_ID} .agy-ta-row-sub-right {
display: inline-flex;
align-items: center;
justify-content: flex-end;
gap: 5px;
min-width: 0;
flex: 1 1 auto;
overflow: hidden;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-model-chip {
display: inline-flex;
align-items: center;
gap: 4px;
min-width: 0;
flex: 0 1 auto;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-model-chip.is-other {
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-model-chip-val,
#${MODAL_ID} .agy-ta-model-sep {
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-total-grid {
display: grid;
grid-template-columns: repeat(2, minmax(0, 1fr));
gap: 10px;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-panel {
background: var(--agy-ta-panel-bg);
border: 1px solid var(--agy-ta-panel-border);
border-radius: 9px;
padding: 12px 14px;
display: flex;
flex-direction: column;
gap: 10px;
min-width: 0;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-panel-title {
font-size: 12px;
font-weight: 600;
color: var(--agy-ta-panel-title-fg);
white-space: nowrap;
overflow: hidden;
text-overflow: ellipsis;
min-width: 0;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-panel-foot {
display: flex;
align-items: center;
justify-content: space-between;
gap: 8px;
font-size: 11px;
color: var(--agy-ta-row-sub-fg);
flex-wrap: nowrap;
min-width: 0;
flex-shrink: 0;
margin-top: auto;
padding-top: 4px;
border-top: 1px solid var(--agy-ta-divider, rgba(255,255,255,0.06));
}
#${MODAL_ID} .agy-ta-panel-foot-right {
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-comp-item {
display: flex;
flex-direction: column;
gap: 4px;
min-width: 0;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-comp-head {
display: flex;
align-items: center;
justify-content: space-between;
gap: 8px;
font-size: 11px;
color: var(--agy-ta-comp-head-fg);
flex-wrap: nowrap;
min-width: 0;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-comp-label {
display: inline-flex;
align-items: center;
gap: 6px;
min-width: 0;
flex: 1 1 auto;
white-space: nowrap;
overflow: hidden;
}
#${MODAL_ID} .agy-ta-comp-val {
color: var(--agy-ta-comp-val-fg);
font-weight: 500;
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-comp-track {
width: 100%;
height: 6px;
border-radius: 999px;
background: var(--agy-ta-track-bg);
overflow: hidden;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-comp-fill {
height: 100%;
border-radius: 999px;
}
#${MODAL_ID} .agy-ta-empty {
text-align: center;
padding: 28px 12px;
color: var(--agy-ta-muted);
font-size: 12px;
}
#${MODAL_ID} .agy-ta-acct-pill {
display: inline-flex;
align-items: center;
gap: 5px;
max-width: 190px;
padding: 2px 8px;
border-radius: 999px;
border: 1px solid var(--agy-ta-tabs-border);
background: var(--agy-ta-tabs-bg);
color: var(--agy-ta-tab-fg);
font-family: inherit;
font-size: 11px;
font-weight: 500;
cursor: pointer;
outline: none;
transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
min-width: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-acct-pill:hover {
background: var(--agy-ta-tab-hover-bg);
color: var(--agy-ta-tab-hover-fg);
border-color: var(--agy-ta-tab-active-border);
}
#${MODAL_ID} .agy-ta-acct-pill[hidden],
#${MODAL_ID} .agy-ta-tab[hidden],
#${MODAL_ID} .agy-ta-accounts-section[hidden] {
display: none !important;
}
#${MODAL_ID} .agy-ta-accounts-section {
margin-top: 16px;
padding-top: 14px;
border-top: 1px solid var(--agy-ta-divider);
display: flex;
flex-direction: column;
gap: 10px;
min-height: 260px;
}
#${MODAL_ID} .agy-ta-acct-head-left {
display: flex;
align-items: center;
gap: 8px;
min-width: 0;
}
#${MODAL_ID} .agy-ta-acct-meta {
font-size: 11px;
color: var(--agy-ta-muted);
white-space: nowrap;
overflow: hidden;
text-overflow: ellipsis;
}
#${MODAL_ID} .agy-ta-acct-head-actions {
display: inline-flex;
align-items: center;
gap: 8px;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-acct-btn {
border: 1px solid var(--agy-ta-btn-border);
background: var(--agy-ta-btn-bg);
color: var(--agy-ta-btn-fg);
font-family: inherit;
font-size: 11.5px;
font-weight: 500;
padding: 4px 10px;
border-radius: 7px;
cursor: pointer;
transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
outline: none;
white-space: nowrap;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-acct-btn:hover:not(:disabled) {
background: var(--agy-ta-btn-hover-bg);
color: var(--agy-ta-btn-hover-fg);
}
#${MODAL_ID} .agy-ta-acct-btn:disabled {
opacity: 0.55;
cursor: not-allowed;
}
#${MODAL_ID} .agy-ta-acct-btn-danger {
background: var(--agy-ta-danger-bg);
border-color: var(--agy-ta-danger-border);
color: var(--agy-ta-danger-fg);
}
#${MODAL_ID} .agy-ta-acct-btn-danger:hover:not(:disabled) {
background: var(--agy-ta-danger-hover-bg);
color: var(--agy-ta-danger-fg);
}
#${MODAL_ID} .agy-ta-acct-notice {
font-size: 11.5px;
padding: 7px 10px;
border-radius: 8px;
border: 1px solid var(--agy-ta-tabs-border);
background: var(--agy-ta-tabs-bg);
color: var(--agy-ta-row-sub-fg);
line-height: 1.45;
}
#${MODAL_ID} .agy-ta-acct-notice.is-error {
background: var(--agy-ta-danger-bg);
border-color: var(--agy-ta-danger-border);
color: var(--agy-ta-danger-fg);
}
#${MODAL_ID} .agy-ta-acct-notice.is-warn {
background: var(--agy-ta-warn-bg);
border-color: var(--agy-ta-warn-border);
color: var(--agy-ta-warn-fg);
}
#${MODAL_ID} .agy-ta-acct-list {
max-height: 440px;
overflow-y: auto;
display: flex;
flex-direction: column;
gap: 8px;
padding-right: 4px;
}
#${MODAL_ID} .agy-ta-acct-row {
gap: 8px;
padding: 10px 12px;
}
#${MODAL_ID} .agy-ta-acct-row.is-active {
border-color: var(--agy-ta-tab-active-border);
background: var(--agy-ta-panel-bg);
}
#${MODAL_ID} .agy-ta-acct-row.is-disabled {
opacity: 0.65;
}
#${MODAL_ID} .agy-ta-acct-top {
display: flex;
align-items: center;
justify-content: space-between;
gap: 10px;
min-width: 0;
}
#${MODAL_ID} .agy-ta-acct-identity {
display: flex;
align-items: center;
gap: 6px;
min-width: 0;
flex: 1 1 auto;
}
#${MODAL_ID} .agy-ta-acct-email {
font-size: 12.5px;
font-weight: 600;
color: var(--agy-ta-row-name-fg);
min-width: 0;
}
#${MODAL_ID} .agy-ta-acct-label {
font-size: 10.5px;
padding: 1px 6px;
border-radius: 5px;
background: var(--agy-ta-tabs-bg);
border: 1px solid var(--agy-ta-tabs-border);
color: var(--agy-ta-row-sub-fg);
max-width: 120px;
flex-shrink: 0;
}
#${MODAL_ID} .agy-ta-acct-tag-warn {
background: var(--agy-ta-warn-bg);
color: var(--agy-ta-warn-fg);
}
#${MODAL_ID} .agy-ta-acct-tag-danger {
background: var(--agy-ta-danger-bg);
color: var(--agy-ta-danger-fg);
}
#${MODAL_ID} .agy-ta-acct-actions {
display: inline-flex;
align-items: center;
gap: 6px;
flex-shrink: 0;
white-space: nowrap;
}
#${MODAL_ID} .agy-ta-acct-confirm-hint {
font-size: 11px;
color: var(--agy-ta-warn-fg);
}
#${MODAL_ID} .agy-ta-acct-state-lbl {
font-size: 11px;
color: var(--agy-ta-muted);
padding: 2px 4px;
}
#${MODAL_ID} .agy-ta-acct-quotas {
display: grid;
grid-template-columns: repeat(2, minmax(0, 1fr));
gap: 12px;
}
#${MODAL_ID} .agy-ta-acct-secondary {
display: flex;
align-items: center;
justify-content: space-between;
gap: 8px;
font-size: 10.5px;
color: var(--agy-ta-muted);
padding-top: 2px;
}
#${MODAL_ID} .agy-ta-tooltip {
position: fixed;
z-index: 2147483645;
display: none;
pointer-events: none;
background: var(--agy-ta-tt-bg);
border: 1px solid var(--agy-ta-tt-border);
border-radius: 10px;
padding: 8px 12px;
box-shadow: var(--agy-ta-tt-shadow);
white-space: nowrap;
max-width: calc(100vw - 24px);
overflow: hidden;
color: var(--agy-ta-tt-fg);
line-height: 1.45;
}
#${MODAL_ID} .agy-ta-tt-date {
font-size: 11px;
color: var(--agy-ta-tt-date-fg);
overflow: hidden;
text-overflow: ellipsis;
}
#${MODAL_ID} .agy-ta-tt-total {
font-size: 13px;
font-weight: 600;
color: var(--agy-ta-tt-total-fg);
margin: 1px 0;
overflow: hidden;
text-overflow: ellipsis;
}
#${MODAL_ID} .agy-ta-tt-sub {
font-size: 11px;
color: var(--agy-ta-tt-sub-fg);
overflow: hidden;
text-overflow: ellipsis;
}
@media (max-width: 720px) {
#${MODAL_ID} .agy-ta-kpis {
grid-template-columns: repeat(2, minmax(0, 1fr));
}
#${MODAL_ID} .agy-ta-total-grid,
#${MODAL_ID} .agy-ta-acct-quotas {
grid-template-columns: 1fr;
}
#${MODAL_ID} .agy-ta-section-title {
flex-shrink: 1;
min-width: 0;
overflow: hidden;
text-overflow: ellipsis;
}
#${MODAL_ID} .agy-ta-row-sub-left {
flex: 0 1 auto;
overflow: hidden;
text-overflow: ellipsis;
}
}
@media (max-width: 600px) {
#${MODAL_ID} .agy-ta-badge,
#${MODAL_ID} .agy-ta-acct-pill {
display: none;
}
#${MODAL_ID} .agy-ta-tab {
padding: 5px 8px;
}
}
`;
(g.document.head || g.document.documentElement).appendChild(style);
}
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
function formatActivityTokens(num) {
const n = Number(num);
if (!Number.isFinite(n) || n <= 0) {
return '0';
}
if (n >= 1e9) {
return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
}
if (n >= 1e6) {
return (n / 1e6).toFixed(n >= 100e6 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
}
if (n >= 1e3) {
return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
}
return String(Math.round(n));
}
function escHtml(str) {
return String(str == null ? '' : str)
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;');
}
function calcCachePct(bucket) {
if (!bucket)
return 0;
const inTok = Number(bucket.in) || 0;
const cacheTok = Number(bucket.cache) || 0;
const denom = inTok + cacheTok;
return denom > 0 ? Math.round((cacheTok / denom) * 100) : 0;
}
function pad2(n) {
return String(n).padStart(2, '0');
}
function formatDateKey(dt) {
return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}
function getLocalTodayKey() {
return formatDateKey(new Date());
}
function parseDateKeyLocal(dateStr) {
const parts = String(dateStr || '').split('-');
if (parts.length !== 3)
return new Date();
return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0);
}
function addLocalDays(dt, offsetDays) {
const next = new Date(dt.getTime());
next.setDate(next.getDate() + offsetDays);
return next;
}
function getIsoWeekInfo(dateStr) {
const d = parseDateKeyLocal(dateStr);
const isoDay = d.getDay() || 7;
const mon = addLocalDays(d, -(isoDay - 1));
const sun = addLocalDays(mon, 6);
const thu = addLocalDays(mon, 3);
const isoYear = thu.getFullYear();
const jan4 = new Date(isoYear, 0, 4, 12, 0, 0);
const jan4IsoDay = jan4.getDay() || 7;
const week1Thu = addLocalDays(jan4, 4 - jan4IsoDay);
const weekNum = 1 + Math.round((thu.getTime() - week1Thu.getTime()) / (7 * 86400000));
const key = `${isoYear}-W${pad2(weekNum)}`;
const range = `${pad2(mon.getMonth() + 1)}/${pad2(mon.getDate())}~${pad2(sun.getMonth() + 1)}/${pad2(sun.getDate())}`;
return {
key,
range,
startKey: formatDateKey(mon),
};
}
function getHeatmapColor(totalTokens, lightOverride) {
const light = typeof lightOverride === 'boolean' ? lightOverride : isLightTheme();
const t = Number(totalTokens) || 0;
if (light) {
if (t <= 0)
return '#EBEDF0';
if (t < 15e6)
return '#9BE9A8';
if (t < 65e6)
return '#40C463';
if (t < 180e6)
return '#30A14E';
return '#216E39';
}
if (t <= 0)
return '#2E2E38';
if (t < 15e6)
return '#58294E';
if (t < 65e6)
return '#843571';
if (t < 180e6)
return '#BA4A98';
return '#F6A5D8';
}
const MODEL_CURATED_PALETTE = [
'#C084FC', // Electric Purple
'#38BDF8', // Sky Cyan
'#FBBF24', // Amber Gold
'#34D399', // Mint Emerald
'#FB7185', // Coral Rose
'#818CF8', // Indigo Violet
'#FB923C', // Warm Orange
'#2DD4BF', // Ice Teal
];
function stringHash(str) {
let hash = 0;
const s = String(str || '');
for (let i = 0; i < s.length; i++) {
hash = ((hash << 5) - hash) + s.charCodeAt(i);
hash |= 0;
}
return hash;
}
function buildModelColorMap(stats) {
const modelTotals = new Map();
if (stats && stats.allTime && stats.allTime.models) {
for (const [name, m] of Object.entries(stats.allTime.models)) {
const tot = Number(m && m.total) || 0;
if (tot > 0) {
modelTotals.set(name, (modelTotals.get(name) || 0) + tot);
}
}
}
if (stats && stats.days) {
for (const d of Object.values(stats.days)) {
if (d && d.models) {
for (const [name, m] of Object.entries(d.models)) {
const tot = Number(m && m.total) || 0;
if (tot > 0 && !modelTotals.has(name)) {
modelTotals.set(name, (modelTotals.get(name) || 0) + tot);
}
}
}
}
}
const namedModels = [];
for (const [name, tot] of modelTotals.entries()) {
if (name !== '其他模型' && name !== '其他') {
namedModels.push({ name, total: tot });
}
}
namedModels.sort((a, b) => b.total - a.total);
const colorMap = new Map();
colorMap.set('其他模型', '#64748B');
colorMap.set('其他', '#64748B');
namedModels.forEach((item, idx) => {
if (idx < MODEL_CURATED_PALETTE.length) {
colorMap.set(item.name, MODEL_CURATED_PALETTE[idx]);
} else {
const hash = stringHash(item.name);
// Golden-angle hue progression for high dynamic distinction
const hue = ((idx * 137.508 + Math.abs(hash % 60)) % 360).toFixed(1);
colorMap.set(item.name, `hsl(${hue}, 78%, 65%)`);
}
});
return {
getColor(modelName) {
const key = String(modelName || '').trim();
if (!key) return '#64748B';
if (colorMap.has(key)) return colorMap.get(key);
if (key === '其他模型' || key === '其他') return '#64748B';
const hash = stringHash(key);
const fallbackIdx = colorMap.size;
const hue = ((fallbackIdx * 137.508 + Math.abs(hash % 60)) % 360).toFixed(1);
const color = `hsl(${hue}, 78%, 65%)`;
colorMap.set(key, color);
return color;
},
colorMap,
};
}
function mergeModelsMap(target, src) {
if (!src || typeof src !== 'object' || !target) return target;
for (const [mName, mData] of Object.entries(src)) {
if (!mData) continue;
if (!target[mName]) {
target[mName] = { in: 0, cache: 0, out: 0, total: 0, steps: 0 };
}
target[mName].in += Number(mData.in) || 0;
target[mName].cache += Number(mData.cache) || 0;
target[mName].out += Number(mData.out) || 0;
target[mName].total += Number(mData.total) || 0;
target[mName].steps += Number(mData.steps) || 0;
}
return target;
}
function getSortedModelEntries(modelsObj) {
return Object.entries(modelsObj || {})
.filter(([, v]) => (Number(v && v.total) || 0) > 0)
.sort((a, b) => (Number(b[1].total) || 0) - (Number(a[1].total) || 0));
}
function normalizeActivityStats(raw) {
const emptyBucket = () => ({ in: 0, cache: 0, out: 0, total: 0, desktop: 0, cli: 0, steps: 0, activeDays: 0, models: {} });
if (!raw || typeof raw !== 'object') {
return {
todayKey: getLocalTodayKey(),
today: emptyBucket(),
thisWeek: emptyBucket(),
thisMonth: emptyBucket(),
allTime: { ...emptyBucket(), totalConversations: 0 },
days: {},
_empty: true,
};
}
return {
todayKey: typeof raw.todayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.todayKey) ? raw.todayKey : getLocalTodayKey(),
today: { ...emptyBucket(), ...(raw.today || {}), models: (raw.today && raw.today.models && typeof raw.today.models === 'object') ? raw.today.models : {} },
thisWeek: { ...emptyBucket(), ...(raw.thisWeek || {}), models: (raw.thisWeek && raw.thisWeek.models && typeof raw.thisWeek.models === 'object') ? raw.thisWeek.models : {} },
thisMonth: { ...emptyBucket(), ...(raw.thisMonth || {}), models: (raw.thisMonth && raw.thisMonth.models && typeof raw.thisMonth.models === 'object') ? raw.thisMonth.models : {} },
allTime: { ...emptyBucket(), totalConversations: 0, ...(raw.allTime || {}), models: (raw.allTime && raw.allTime.models && typeof raw.allTime.models === 'object') ? raw.allTime.models : {} },
days: raw.days && typeof raw.days === 'object' ? raw.days : {},
_empty: false,
};
}
let activityModalOpen = false;
let portalOverlaySignaled = false;
let activityActiveTab = 'daily'; // 'daily' | 'weekly' | 'monthly' | 'total' | 'accounts'
let activityBreakdownMode = 'source'; // 'source' | 'model'
let activityOverlayEl = null;
let activityRefreshTimer = null;
let activityEscapeHandler = null;
let activityStatsCache = null;
let activityFetchError = false;
let activityFetchSeq = 0;
let activityRenderedTodayKey = null;
let activityHoveredDate = null;
let activityHoveredCell = null;
let accountsAvailable = false;
let accountsList = [];
let accountsCurrentId = null;
let accountsLoading = false;
let accountsRefreshing = false;
let accountsSwitchingId = null;
let accountsPendingConfirmId = null;
let accountsStatusMsg = '';
let accountsErrorMsg = '';
let accountsFetchSeq = 0;
let accountsSwitchFallbackTimer = null;
function setPortalOverlayOpenSafe(open) {
try {
if (electronObj && electronObj.ipcRenderer && typeof electronObj.ipcRenderer.invoke === 'function') {
Promise.resolve(electronObj.ipcRenderer.invoke('wcv:set-portal-overlay-open', Boolean(open))).catch(() => { });
}
}
catch { }
}
function getDayData(stats, dateStr) {
const d = stats && stats.days ? stats.days[dateStr] : null;
if (!d || typeof d !== 'object') {
return { in: 0, cache: 0, out: 0, total: 0, desktop: 0, cli: 0, steps: 0, models: {} };
}
return {
in: Number(d.in) || 0,
cache: Number(d.cache) || 0,
out: Number(d.out) || 0,
total: Number(d.total) || 0,
desktop: Number(d.desktop) || 0,
cli: Number(d.cli) || 0,
steps: Number(d.steps) || 0,
models: (d.models && typeof d.models === 'object') ? d.models : {},
};
}
function hideActivityTooltip() {
if (!activityOverlayEl)
return;
const tt = activityOverlayEl.querySelector('[data-role="ta-tooltip"]');
if (tt)
tt.style.display = 'none';
}
function showActivityTooltip(cellEl, dateStr) {
if (!activityOverlayEl || !cellEl || !dateStr)
return;
const tt = activityOverlayEl.querySelector('[data-role="ta-tooltip"]');
if (!tt)
return;
const stats = activityStatsCache || normalizeActivityStats(null);
const day = getDayData(stats, dateStr);
const parts = dateStr.split('-');
const dateLabel = `${Number(parts[1])}月${Number(parts[2])}日`;
const totalLabel = `${formatActivityTokens(day.total)} Tokens`;
const subLabel = `Desktop ${formatActivityTokens(day.desktop)} · CLI ${formatActivityTokens(day.cli)} · 缓存 ${calcCachePct(day)}%`;
const elDate = tt.querySelector('[data-role="tt-date"]');
const elTotal = tt.querySelector('[data-role="tt-total"]');
const elSub = tt.querySelector('[data-role="tt-sub"]');
if (elDate)
elDate.textContent = dateLabel;
if (elTotal)
elTotal.textContent = totalLabel;
if (elSub)
elSub.textContent = subLabel;
tt.style.visibility = 'hidden';
tt.style.display = 'block';
const rect = cellEl.getBoundingClientRect();
const tw = tt.offsetWidth || 180;
