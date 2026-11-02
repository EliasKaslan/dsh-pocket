/* ============================================================
   DSH 随行 · mobile client
   A dependency-free SPA served by the DSH Mobile Bridge plugin.
   ============================================================ */
'use strict';

const APP_VERSION = '1.0.0';
const PROTOCOL = 1;
const LS_SESSION = 'dsh.bridge.session.v1';
const LS_PREFS = 'dsh.bridge.prefs.v1';
const LS_DEVICE = 'dsh.bridge.device.v1';
const LS_CACHE = 'dsh.bridge.cache.v1';
const MAX_PROMPT = 8000;
const TASK_LIMIT = 300;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const app = $('#app');
const toastEl = $('#toast');
const modalRoot = $('#modal-root');

const state = {
  screen: 'boot',
  session: null,
  me: null,
  bridge: null,
  tasks: new Map(),
  order: [],
  summary: { total: 0, running: 0, done: 0, error: 0, idle: 0, today: 0 },
  prevStatus: new Map(),
  filter: 'all',
  query: '',
  loading: true,
  error: '',
  connState: 'connecting',
  latency: 0,
  latencyAt: 0,
  bridgeFailures: 0,
  lastSeq: 0,
  lastPong: 0,
  ws: null,
  sse: null,
  reconnectTimer: null,
  pingTimer: null,
  paintTimer: null,
  detailTimer: null,
  clockTimer: null,
  refreshTimer: null,
  tasksTimer: null,
  detailPollTimer: null,
  pollingTasks: false,
  closing: false,
  screenSeq: 0,
  detailId: null,
  detail: null,
  detailError: '',
  detailSeq: 0,
  chatAuto: true,
  pendingPrompts: [],
  draft: { prompt: '', cwd: '', preset: '', clientTaskId: '' },
  workspaces: [],
  presets: [],
  defaultPreset: '',
  model: null,
  manualCode: '',
  deviceName: '',
  showManual: false,
  scanPending: null,
  pairing: false,
  pairingMessage: '',
  connectError: '',
  creating: false,
  createError: '',
  prefs: { theme: 'dark', notify: false, deviceName: '', lastCwd: '', showSubagents: false },
  installPrompt: null,
  authLost: false,
  pullStart: null,
  pullDistance: 0,
};

if (new URLSearchParams(location.search).has('debug')) window.__dshState = state;

/* ---------------- helpers ---------------- */

function esc(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function icon(name) {
  return `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function uid(prefix = 'id') {
  try {
    if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  } catch { /* fall through */ }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function trimText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function oneLine(value, max = 120) {
  return trimText(String(value ?? '').replace(/\s+/gu, ' ').trim(), max);
}

function normalizeBase(value) {
  const raw = String(value ?? '').trim().replace(/\/+$/u, '');
  if (raw.length === 0) return '';
  if (!/^https?:\/\//iu.test(raw)) return `http://${raw}`;
  return raw;
}

function normalizeCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/gu, '').slice(0, 8);
}

function displayCode(value) {
  const clean = normalizeCode(value);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

function b64UrlDecode(value) {
  let raw = String(value ?? '').replace(/-/gu, '+').replace(/_/gu, '/');
  while (raw.length % 4 !== 0) raw += '=';
  const binary = atob(raw);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parsePairHash(hash) {
  const match = String(hash ?? '').match(/^#pair=(.+)$/u);
  if (match === null) return null;
  try {
    const payload = JSON.parse(b64UrlDecode(match[1]));
    if (payload === null || typeof payload !== 'object') return null;
    const base = normalizeBase(payload.u);
    const code = normalizeCode(payload.c);
    if (base.length === 0 || code.length !== 8) return null;
    return { baseUrl: base, code, name: payload.n ? decodeURIComponent(payload.n) : '', fingerprint: payload.f ?? '' };
  } catch {
    return null;
  }
}

function parseScanText(text) {
  const raw = String(text ?? '').trim();
  if (raw.length === 0) return null;
  if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/u.test(raw)) return { baseUrl: normalizeBase(raw), code: '' };
  try {
    const url = new URL(raw);
    if (url.protocol === 'dshlink:') {
      const base = normalizeBase(url.searchParams.get('u'));
      const code = normalizeCode(url.searchParams.get('c'));
      if (base.length > 0 && code.length === 8) return { baseUrl: base, code };
      return null;
    }
    if (url.hash.startsWith('#pair=')) {
      const parsed = parsePairHash(url.hash);
      if (parsed !== null) return { ...parsed, url: url.href };
    }
    const code = normalizeCode(url.searchParams.get('code') ?? url.searchParams.get('c'));
    if (code.length === 8) return { baseUrl: normalizeBase(url.origin), code, url: url.href };
  } catch { /* not a URL */ }
  const code = normalizeCode(raw);
  if (code.length === 8) return { baseUrl: normalizeBase(location.origin), code };
  return null;
}

function relTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const diff = Date.now() - value;
  if (diff < 45_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const date = new Date(value);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function fmtClock(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function todayLine() {
  const now = new Date();
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  return `${now.getMonth() + 1}月${now.getDate()}日 ${week} · 数据实时同步`;
}

function statusMeta(status) {
  switch (status) {
    case 'running': return { cls: 'status-running', label: '运行中' };
    case 'done': return { cls: 'status-done', label: '已完成' };
    case 'cancelled': return { cls: 'status-cancelled', label: '已中断' };
    case 'error': return { cls: 'status-error', label: '出错' };
    default: return { cls: 'status-idle', label: '空闲' };
  }
}

function shortModel(model) {
  const value = String(model ?? '').replace(/^[^/]+\//u, '');
  return trimText(value || '默认模型', 24);
}

function serverName() {
  return state.me?.server?.name ?? state.session?.server?.name ?? 'DSH';
}

function baseUrl() {
  return state.session?.baseUrl ?? location.origin;
}

function isNative() {
  return typeof window.DSHNative === 'object' && window.DSHNative !== null;
}

function isHarmony() {
  return /HarmonyOS|OpenHarmony/iu.test(navigator.userAgent) || isNative();
}

function defaultDeviceName() {
  const ua = navigator.userAgent;
  if (isNative()) return 'HarmonyOS 手机';
  if (/iPhone/iu.test(ua)) return 'iPhone';
  if (/Android/iu.test(ua)) return 'Android 手机';
  if (/HarmonyOS/iu.test(ua)) return 'HarmonyOS 手机';
  return '我的手机';
}

function deviceId() {
  try {
    const stored = localStorage.getItem(LS_DEVICE);
    if (typeof stored === 'string' && stored.startsWith('dev_')) return stored;
    const created = `dev_${uid('').replace(/[^a-z0-9]/giu, '').slice(-16)}`;
    localStorage.setItem(LS_DEVICE, created);
    return created;
  } catch {
    return `dev_${Math.random().toString(36).slice(2, 14)}`;
  }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(LS_SESSION);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (value !== null && typeof value === 'object' && typeof value.token === 'string' && typeof value.baseUrl === 'string') return value;
  } catch { /* ignore */ }
  return null;
}

function saveSession(session) {
  try { localStorage.setItem(LS_SESSION, JSON.stringify(session)); } catch { /* storage full */ }
}

function clearSession() {
  try { localStorage.removeItem(LS_SESSION); } catch { /* ignore */ }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(LS_PREFS);
    if (raw !== null) state.prefs = { ...state.prefs, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  state.deviceName = state.prefs.deviceName || '';
}

function savePrefs(patch = {}) {
  state.prefs = { ...state.prefs, ...patch };
  try { localStorage.setItem(LS_PREFS, JSON.stringify(state.prefs)); } catch { /* ignore */ }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(LS_CACHE);
    if (raw === null) return;
    const cache = JSON.parse(raw);
    if (cache?.baseUrl !== baseUrl() || !Array.isArray(cache.tasks)) return;
    state.tasks = new Map(cache.tasks.map((task) => [task.id, task]));
    state.order = cache.tasks.map((task) => task.id);
    state.summary = { ...state.summary, ...(cache.summary ?? {}) };
    state.loading = false;
  } catch { /* ignore */ }
}

function saveCache() {
  try {
    const tasks = state.order.slice(0, 120).map((id) => state.tasks.get(id)).filter(Boolean);
    localStorage.setItem(LS_CACHE, JSON.stringify({ baseUrl: baseUrl(), tasks, summary: state.summary, at: Date.now() }));
  } catch { /* ignore */ }
}

/* ---------------- theme ---------------- */

const themeMedia = window.matchMedia('(prefers-color-scheme: light)');

function resolvedTheme() {
  if (state.prefs.theme === 'light') return 'light';
  if (state.prefs.theme === 'dark') return 'dark';
  return themeMedia.matches ? 'light' : 'dark';
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta !== null) meta.setAttribute('content', theme === 'light' ? '#f3f6fc' : '#070b16');
}

themeMedia.addEventListener?.('change', () => {
  if (state.prefs.theme === 'auto') { applyTheme(); if (state.screen === 'settings') render(); }
});

/* ---------------- api ---------------- */

class ApiError extends Error {
  constructor(message, { status = 0, code = 'error' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function api(path, { method = 'GET', body, base, auth = true, timeout = 20_000 } = {}) {
  const root = normalizeBase(base ?? state.session?.baseUrl ?? '');
  if (root.length === 0) throw new ApiError('尚未连接电脑');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { accept: 'application/json' };
    if (auth && state.session?.token) headers.authorization = `Bearer ${state.session.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
    const response = await fetch(`${root}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await response.text();
    let payload;
    try { payload = text.length > 0 ? JSON.parse(text) : null; } catch {
      throw new ApiError(`服务返回了无效数据 (${response.status})`, { status: response.status, code: 'bad_response' });
    }
    if (response.status === 401 && auth) {
      onUnauthorized();
      throw new ApiError('配对已失效，请重新扫码', { status: 401, code: 'unauthorized' });
    }
    if (!response.ok || payload?.ok === false) {
      throw new ApiError(payload?.error?.message ?? `请求失败 (${response.status})`, {
        status: response.status,
        code: payload?.error?.code ?? 'http_error',
      });
    }
    return payload?.data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new ApiError('连接超时，请检查电脑和局域网');
    if (error instanceof ApiError) throw error;
    throw new ApiError('无法连接电脑，请检查地址和网络');
  } finally {
    clearTimeout(timer);
  }
}

function onUnauthorized() {
  if (state.authLost) return;
  state.authLost = true;
  clearSession();
  state.session = null;
  state.me = null;
  closeRealtime();
  state.screen = 'connect';
  history.replaceState(null, '', '#/connect');
  render();
  toast('配对已失效，请重新扫码', 'err');
  setTimeout(() => { state.authLost = false; }, 1200);
}

/* ---------------- toast / modal ---------------- */

let toastTimer;
function toast(message, type = '') {
  if (toastEl === null) return;
  toastEl.textContent = String(message ?? '');
  toastEl.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 2400);
}

function closeModal() {
  const resolve = state.confirmResolve;
  state.confirmResolve = undefined;
  modalRoot.replaceChildren();
  if (typeof resolve === 'function') resolve(false);
}

function openSheet(html) {
  modalRoot.innerHTML = `<div class="modal-root"><div class="modal-backdrop" data-close></div>${html}</div>`;
}

function confirmDialog({ title, message, okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
    openSheet(`<div class="dialog" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      <div class="sheet-actions">
        <button class="btn-cancel" data-confirm="0" type="button">${esc(cancelText)}</button>
        <button class="${danger ? 'btn-danger' : 'btn-ok'}" data-confirm="1" type="button">${esc(okText)}</button>
      </div>
    </div>`);
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text ?? ''));
    toast('已复制', 'ok');
  } catch {
    const area = document.createElement('textarea');
    area.value = String(text ?? '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try { document.execCommand('copy'); toast('已复制', 'ok'); } catch { toast('复制失败，请手动选择'); }
    area.remove();
  }
}

function haptic() {
  try {
    if (typeof window.DSHNative?.haptic === 'function') { window.DSHNative.haptic(); return; }
    if (navigator.vibrate) navigator.vibrate(8);
  } catch { /* ignore */ }
}

/* ---------------- realtime ---------------- */

function wsUrl(ticket) {
  const root = baseUrl().replace(/^http/iu, 'ws');
  const since = state.lastSeq > 0 ? `&since=${state.lastSeq}` : '';
  return `${root}/ws?ticket=${encodeURIComponent(ticket)}${since}`;
}

function sseUrl() {
  const since = state.lastSeq > 0 ? `&since=${state.lastSeq}` : '';
  return `${baseUrl()}/api/v1/events?token=${encodeURIComponent(state.session?.token ?? '')}${since}`;
}

async function connectRealtime() {
  if (!state.session || state.screen === 'connect') return;
  closeRealtime();
  state.closing = false;
  state.connState = 'connecting';
  updateConnUI();
  if (state.bridgeFailures >= 2) {
    startSse();
    return;
  }
  try {
    const ticket = await api('/api/v1/ws-ticket', { method: 'POST' });
    if (!ticket?.ticket) throw new ApiError('无法获取实时连接票据');
    const socket = new WebSocket(wsUrl(ticket.ticket));
    state.ws = socket;
    socket.onopen = () => {
      state.connState = 'online';
      state.bridgeFailures = 0;
      state.lastPong = Date.now();
      updateConnUI();
      startPing();
    };
    socket.onmessage = (event) => {
      try { handleFrame(JSON.parse(event.data)); } catch { /* ignore malformed frame */ }
    };
    socket.onerror = () => { try { socket.close(); } catch { /* ignore */ } };
    socket.onclose = () => {
      stopPing();
      if (state.ws === socket) state.ws = null;
      if (state.closing) return;
      state.bridgeFailures += 1;
      state.connState = 'offline';
      updateConnUI();
      scheduleReconnect();
    };
  } catch (error) {
    if (error?.status === 401) return;
    state.bridgeFailures += 1;
    state.connState = 'offline';
    updateConnUI();
    scheduleReconnect();
  }
}

function startPing() {
  stopPing();
  state.pingTimer = setInterval(() => {
    const socket = state.ws;
    if (socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
      if (state.lastPong > 0 && Date.now() - state.lastPong > 75_000) {
        try { socket.close(); } catch { /* ignore */ }
      }
    }
  }, 20_000);
}

function stopPing() {
  if (state.pingTimer !== null) clearInterval(state.pingTimer);
  state.pingTimer = null;
}

function scheduleReconnect() {
  if (state.session === null) return;
  if (state.reconnectTimer !== null) clearTimeout(state.reconnectTimer);
  const attempt = Math.min(state.bridgeFailures, 5);
  const delay = Math.min(15_000, 800 * (2 ** attempt)) + Math.floor(Math.random() * 300);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.session !== null) void connectRealtime();
  }, delay);
}

function closeRealtime() {
  state.closing = true;
  if (state.reconnectTimer !== null) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  stopPing();
  if (state.ws !== null) {
    try { state.ws.close(); } catch { /* ignore */ }
    state.ws = null;
  }
  if (state.sse !== null) {
    try { state.sse.close(); } catch { /* ignore */ }
    state.sse = null;
  }
  setTimeout(() => { state.closing = false; }, 0);
}

function startSse() {
  if (state.session === null || state.sse !== null) return;
  if (typeof EventSource !== 'function') { scheduleReconnect(); return; }
  try {
    const source = new EventSource(sseUrl());
    state.sse = source;
    const types = ['hello', 'task.updated', 'task.created', 'task.message', 'task.removed', 'summary', 'bridge.status', 'devices.changed', 'pong'];
    for (const type of types) {
      source.addEventListener(type, (event) => {
        try { handleFrame(JSON.parse(event.data)); } catch { /* ignore */ }
      });
    }
    source.onopen = () => { state.connState = 'online'; updateConnUI(); };
    source.onerror = () => {
      state.connState = 'offline';
      updateConnUI();
      if (source.readyState === EventSource.CLOSED) {
        state.sse = null;
        state.bridgeFailures = 0;
        scheduleReconnect();
      }
    };
  } catch {
    state.bridgeFailures = 0;
    scheduleReconnect();
  }
}

function handleFrame(frame) {
  if (frame === null || typeof frame !== 'object') return;
  if (frame.type === 'hello') {
    if (typeof frame.seq === 'number') state.lastSeq = Math.max(state.lastSeq, frame.seq);
    state.connState = 'online';
    state.lastPong = Date.now();
    if (frame.payload?.server) state.bridge = { ...(state.bridge ?? {}), ...frame.payload.server };
    updateConnUI();
    if (state.screen === 'tasks') { void loadTasks({ silent: true }); }
    if (state.detailId !== null) scheduleDetailRefresh();
    return;
  }
  if (frame.type === 'pong') { state.lastPong = Date.now(); return; }
  if (typeof frame.seq === 'number') {
    if (frame.seq <= state.lastSeq) return;
    state.lastSeq = frame.seq;
  }
  switch (frame.type) {
    case 'task.updated':
    case 'task.created': {
      const task = frame.payload;
      if (task?.id) {
        const previous = state.tasks.get(task.id);
        upsertTask(task);
        notifyTransition(previous, task);
        if (state.screen === 'tasks') schedulePaint();
        if (state.detailId === task.id) {
          updateDetailChrome(task);
          scheduleDetailRefresh();
        }
      }
      break;
    }
    case 'task.message': {
      const taskId = frame.payload?.taskId;
      if (taskId && state.detailId === taskId) scheduleDetailRefresh();
      if (state.screen === 'tasks') schedulePaint();
      break;
    }
    case 'task.removed': {
      const id = frame.payload?.id;
      if (typeof id === 'string') removeTask(id);
      break;
    }
    case 'summary': {
      if (frame.payload !== null && typeof frame.payload === 'object') {
        state.summary = { ...state.summary, ...frame.payload };
        updateSummary();
        updateFilterCounts();
      }
      break;
    }
    case 'bridge.status': {
      state.bridge = frame.payload ?? state.bridge;
      updateConnUI();
      break;
    }
    default:
      break;
  }
}

function notifyTransition(previous, next) {
  if (previous?.status === 'running' && (next.status === 'done' || next.status === 'error')) {
    if (state.prefs.notify && document.hidden && typeof Notification === 'function' && Notification.permission === 'granted') {
      try {
        new Notification(next.status === 'done' ? '任务已完成' : '任务执行出错', {
          body: trimText(next.title ?? '', 80),
          icon: '/app/icons/icon-192.png',
          tag: next.id,
        });
      } catch { /* notifications unavailable */ }
    }
  }
  if (next?.id) state.prevStatus.set(next.id, next.status);
}

/* ---------------- data loading ---------------- */

async function loadMe() {
  const data = await api('/api/v1/me');
  state.me = data;
  if (data?.server) state.session = { ...state.session, server: data.server };
  if (data?.model) state.model = data.model;
  if (state.session) saveSession(state.session);
  const latencyStart = performance.now();
  try {
    await api('/api/v1/health', { auth: false, timeout: 5000 });
    state.latency = Math.max(1, Math.round(performance.now() - latencyStart));
    state.latencyAt = Date.now();
  } catch { /* keep previous latency */ }
}

async function loadTasks({ silent = false } = {}) {
  const subagents = state.prefs.showSubagents ? '1' : '0';
  const data = await api(`/api/v1/tasks?limit=${TASK_LIMIT}&subagents=${subagents}`);
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  state.tasks = new Map(tasks.map((task) => [task.id, task]));
  state.order = tasks.map((task) => task.id);
  state.summary = { ...state.summary, ...(data?.summary ?? {}) };
  state.loading = false;
  state.error = '';
  for (const task of tasks) {
    if (!state.prevStatus.has(task.id)) state.prevStatus.set(task.id, task.status);
  }
  if (state.draft.cwd.length === 0) {
    const recent = tasks.find((task) => typeof task.cwd === 'string' && task.cwd.length > 0 && !task.isSubagent);
    if (recent) state.draft.cwd = recent.cwd;
  }
  saveCache();
  if (state.screen === 'tasks') paintTasks();
  if (state.screen === 'detail' && state.detailId !== null && state.detail !== null) {
    const fresh = state.tasks.get(state.detailId);
    if (fresh) updateDetailChrome(fresh);
  }
  if (!silent) updateConnUI();
}

async function loadPresets() {
  try {
    const data = await api('/api/v1/presets');
    state.presets = Array.isArray(data?.presets) ? data.presets : [];
    state.defaultPreset = typeof data?.defaultId === 'string' ? data.defaultId : '';
    if (data?.model) state.model = data.model;
  } catch { /* optional */ }
}

async function loadWorkspaces() {
  try {
    const data = await api('/api/v1/workspaces');
    state.workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
  } catch { /* optional */ }
}

async function enterApp() {
  state.loading = true;
  state.error = '';
  state.bridgeFailures = 0;
  loadCache();
  if (state.screen === 'tasks') paintTasks();
  const results = await Promise.allSettled([loadMe(), loadTasks(), loadPresets(), loadWorkspaces()]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed !== undefined) {
    const error = failed.reason;
    if (error?.status !== 401) {
      state.error = error?.message ?? '连接失败';
      state.connState = 'offline';
      toast(state.error, 'err');
    }
  }
  state.loading = false;
  if (state.screen === 'tasks') paintTasks();
  if (state.session !== null) void connectRealtime();
  startTimers();
}

async function loadDetail(id, { silent = false } = {}) {
  const seq = ++state.detailSeq;
  if (!silent) {
    state.detail = state.detailId === id ? state.detail : null;
    state.detailError = '';
  }
  try {
    const data = await api(`/api/v1/tasks/${encodeURIComponent(id)}`);
    if (seq !== state.detailSeq || state.detailId !== id) return;
    state.detail = data;
    state.detailError = '';
    state.pendingPrompts = state.pendingPrompts.filter((pending) => {
      return !(data?.messages ?? []).some((message) => message.role === 'user' && message.text === pending.text);
    });
    if (state.screen === 'detail') {
      paintDetailChat();
      updateDetailChrome(data.task);
    }
  } catch (error) {
    if (seq !== state.detailSeq || state.detailId !== id) return;
    state.detailError = error?.message ?? '读取任务失败';
    if (!silent) paintDetailChat();
  }
}

function scheduleDetailRefresh() {
  if (state.detailTimer !== null) clearTimeout(state.detailTimer);
  state.detailTimer = setTimeout(() => {
    state.detailTimer = null;
    if (state.detailId !== null && state.session !== null) void loadDetail(state.detailId, { silent: true });
  }, 320);
}

function schedulePaint() {
  if (state.paintTimer !== null) return;
  state.paintTimer = requestAnimationFrame(() => {
    state.paintTimer = null;
    if (state.screen === 'tasks') paintTasks();
  });
}

function upsertTask(task) {
  if (!task?.id) return;
  state.tasks.set(task.id, task);
  if (!state.order.includes(task.id)) state.order.unshift(task.id);
  refreshSummary();
}

function removeTask(id) {
  state.tasks.delete(id);
  state.order = state.order.filter((taskId) => taskId !== id);
  refreshSummary();
  if (state.screen === 'tasks') paintTasks();
  if (state.detailId === id) navigate('/tasks', { replace: true });
}

function refreshSummary() {
  const counts = { running: 0, done: 0, error: 0, idle: 0 };
  for (const task of state.tasks.values()) {
    if (counts[task.status] !== undefined) counts[task.status] += 1;
  }
  state.summary = {
    ...state.summary,
    ...counts,
    total: Math.max(state.summary.total ?? 0, state.tasks.size),
  };
  updateSummary();
  updateFilterCounts();
}

/* ---------------- timers ---------------- */

function startTimers() {
  if (state.clockTimer === null) {
    state.clockTimer = setInterval(updateRelativeTimes, 30_000);
  }
  if (state.refreshTimer === null) {
    state.refreshTimer = setInterval(() => {
      if (state.session !== null && state.connState !== 'online') void loadTasks({ silent: true }).catch(() => {});
    }, 20_000);
  }
  if (state.tasksTimer === null) {
    state.tasksTimer = setInterval(() => {
      if (state.session === null || document.visibilityState !== 'visible') return;
      void pollTasks();
    }, 12_000);
  }
  if (state.detailPollTimer === null) {
    state.detailPollTimer = setInterval(() => {
      if (state.session === null || state.screen !== 'detail' || state.detailId === null) return;
      if (document.visibilityState !== 'visible') return;
      const current = state.detail?.task ?? state.tasks.get(state.detailId);
      if (current === undefined || current.status === 'running') {
        void loadDetail(state.detailId, { silent: true });
      }
    }, 2_600);
  }
}

async function pollTasks() {
  if (state.pollingTasks) return;
  state.pollingTasks = true;
  try { await loadTasks({ silent: true }); } catch { /* keep the last good list */ } finally { state.pollingTasks = false; }
}

function updateRelativeTimes() {
  for (const element of $$('[data-ts]')) {
    const value = Number(element.dataset.ts);
    if (Number.isFinite(value)) element.textContent = relTime(value);
  }
}

/* ---------------- routing ---------------- */

function parseRoute() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (hash.startsWith('pair=')) return { name: 'connect' };
  const parts = hash.replace(/^\//u, '').split('/');
  if (parts[0] === 'task' && parts[1]) return { name: 'detail', id: decodeURIComponent(parts.slice(1).join('/')) };
  if (parts[0] === 'new') return { name: 'new' };
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'connect') return { name: 'connect' };
  return { name: 'tasks' };
}

function navigate(path, { replace = false } = {}) {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`;
  closeModal();
  if (location.hash === target) { applyRoute(); return; }
  if (replace) {
    history.replaceState(null, '', target);
    applyRoute();
  } else {
    location.hash = target;
  }
}

function applyRoute() {
  closeModal();
  const route = parseRoute();
  if (route.name !== 'connect' && state.session === null) {
    state.screen = 'connect';
    render();
    return;
  }
  if (route.name === 'connect' && state.session !== null) {
    navigate('/tasks', { replace: true });
    return;
  }
  state.screen = route.name;
  if (route.name === 'detail') {
    if (state.detailId !== route.id) {
      state.detailId = route.id;
      state.detail = null;
      state.detailError = '';
      state.pendingPrompts = [];
      state.chatAuto = true;
    }
  } else if (state.detailId !== null) {
    state.detailId = null;
    state.detail = null;
    state.pendingPrompts = [];
  }
  render();
  if (route.name === 'detail') void loadDetail(route.id);
  if (route.name === 'new') {
    if (state.draft.cwd.length === 0) {
      state.draft.cwd = state.prefs.lastCwd || state.workspaces.find((workspace) => workspace.available)?.path || '';
    }
    void ensureComposeData();
  }
  if (route.name === 'settings') void loadSettingsData();
}

async function ensureComposeData() {
  if (state.workspaces.length === 0) await loadWorkspaces();
  if (state.presets.length === 0) await loadPresets();
  if (state.screen === 'new') updateComposeChrome();
}

async function loadSettingsData() {
  if (state.me === null) await loadMe().catch(() => {});
  if (state.bridge === null) {
    try { const health = await api('/api/v1/health', { auth: false, timeout: 5000 }); state.bridge = health; } catch { /* ignore */ }
  }
  if (state.screen === 'settings') updateSettingsChrome();
}

/* ---------------- rendering ---------------- */

function render() {
  const seq = ++state.screenSeq;
  switch (state.screen) {
    case 'connect': app.innerHTML = connectHtml(); break;
    case 'detail': app.innerHTML = detailHtml(); break;
    case 'new': app.innerHTML = newTaskHtml(); break;
    case 'settings': app.innerHTML = settingsHtml(); break;
    case 'tasks':
    default: app.innerHTML = tasksHtml(); break;
  }
  updateConnUI();
  if (state.screen === 'tasks') updateSummary();
  if (state.screen === 'detail') {
    paintDetailChat();
    requestAnimationFrame(() => {
      if (seq !== state.screenSeq) return;
      scrollChatBottom(true);
    });
  }
  if (state.screen === 'new') updateComposeChrome();
  if (state.screen === 'settings') updateSettingsChrome();
  updateRelativeTimes();
}

/* ---------- tasks screen ---------- */

function tasksHtml() {
  const counts = filterCounts();
  return `<div class="screen tasks-screen">
  <header class="app-header">
    <div class="header-left">
      <div class="logo-badge">${icon('sparkles')}</div>
      <div class="header-titles">
        <h1>任务</h1>
        <p><span class="live-dot" id="conn-dot"></span><span id="conn-text">连接中…</span></p>
      </div>
    </div>
    <div class="header-actions">
      <button class="icon-btn" data-action="search-toggle" type="button" aria-label="搜索">${icon('search')}</button>
      <button class="icon-btn" data-action="refresh" type="button" aria-label="刷新">${icon('refresh')}</button>
      <button class="icon-btn" data-action="settings" type="button" aria-label="设置">${icon('settings')}</button>
    </div>
  </header>
  <main class="scroll" id="tasks-scroll">
    <section class="hello">
      <h2>${greeting()}，<span class="grad">${esc(serverName())}</span></h2>
      <p>${todayLine()}</p>
    </section>
    ${state.error ? `<div class="offline-bar">${icon('alert')}<span>${esc(state.error)}</span><button data-action="retry" type="button">重试</button></div>` : ''}
    <section class="overview">
      <div class="overview-main">
        <div>
          <div class="overview-label"><span class="live-dot"></span> 进行中</div>
          <div class="overview-value" id="sum-running">${counts.running}</div>
          <div class="overview-sub" id="sum-sub">共 ${counts.all} 个任务 · 今日 ${state.summary.today ?? 0} 个</div>
        </div>
        <svg class="overview-spark" viewBox="0 0 90 44" aria-hidden="true"><path d="M2 34 C12 34, 14 18, 24 18 S38 30, 46 24 S60 8, 68 12 S82 6, 88 4" fill="none" stroke="url(#sparkGrad)" stroke-width="2" stroke-linecap="round"/><defs><linearGradient id="sparkGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5B8CFF"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs></svg>
      </div>
      <div class="overview-grid">
        <div class="overview-stat"><b id="sum-total">${state.summary.total ?? 0}</b><span>全部任务</span></div>
        <div class="overview-stat ok"><b id="sum-done">${state.summary.done ?? 0}</b><span>已结束</span></div>
        <div class="overview-stat err"><b id="sum-error">${state.summary.error ?? 0}</b><span>出错</span></div>
      </div>
    </section>
    <div class="filters" id="filters">
      <button class="chip ${state.filter === 'all' ? 'active' : ''}" data-filter="all" type="button">全部 <b data-count="all">${counts.all}</b></button>
      <button class="chip ${state.filter === 'running' ? 'active' : ''}" data-filter="running" type="button">运行中 <b data-count="running">${counts.running}</b></button>
      <button class="chip ${state.filter === 'done' ? 'active' : ''}" data-filter="done" type="button">已结束 <b data-count="done">${counts.done}</b></button>
      <button class="chip ${state.filter === 'error' ? 'active' : ''}" data-filter="error" type="button">出错 <b data-count="error">${counts.error}</b></button>
    </div>
    <div class="search-bar ${state.query.length > 0 ? '' : 'hidden'}" id="search-bar">
      <div class="search-wrap">${icon('search')}<input id="search-input" type="search" placeholder="搜索任务标题、内容或工作目录" value="${esc(state.query)}" autocomplete="off"></div>
      <button class="icon-btn small" data-action="search-close" type="button" aria-label="关闭搜索">${icon('close')}</button>
    </div>
    <div class="pull-hint" id="pull-hint">${icon('refresh')} 下拉刷新</div>
    <div class="task-list" id="task-list">${taskListHtml()}</div>
    <div class="section-note">任务来自这台电脑上的 DSH，状态与电脑端实时同步。拉取更多历史会话请使用电脑。</div>
  </main>
  ${tabbar('tasks')}
</div>`;
}

function tabbar(active) {
  return `<nav class="tabbar">
    <button class="tab ${active === 'tasks' ? 'active' : ''}" data-nav="tasks" type="button">${icon('tasks')}<span>任务</span></button>
    <button class="tab tab-create" data-nav="new" type="button"><span class="tab-fab">${icon('plus')}</span><span>新建</span></button>
    <button class="tab ${active === 'settings' ? 'active' : ''}" data-nav="settings" type="button">${icon('settings')}<span>我的</span></button>
  </nav>`;
}

function filterCounts() {
  const counts = { all: 0, running: 0, done: 0, cancelled: 0, error: 0, idle: 0 };
  for (const task of state.tasks.values()) {
    counts.all += 1;
    if (counts[task.status] !== undefined) counts[task.status] += 1;
  }
  counts.all = Math.max(counts.all, state.summary.total ?? 0);
  counts.done += counts.idle + counts.cancelled;
  return counts;
}

function visibleTasks() {
  const query = state.query.trim().toLowerCase();
  const tasks = [];
  for (const id of state.order) {
    const task = state.tasks.get(id);
    if (!task) continue;
    if (state.filter === 'running' && task.status !== 'running') continue;
    if (state.filter === 'done' && task.status !== 'done' && task.status !== 'idle' && task.status !== 'cancelled') continue;
    if (state.filter === 'error' && task.status !== 'error') continue;
    if (query.length > 0) {
      const haystack = `${task.title ?? ''}\n${task.lastText ?? ''}\n${task.cwdName ?? ''}\n${task.cwd ?? ''}`.toLowerCase();
      if (!haystack.includes(query)) continue;
    }
    tasks.push(task);
  }
  tasks.sort((left, right) => {
    if (left.status === 'running' && right.status !== 'running') return -1;
    if (right.status === 'running' && left.status !== 'running') return 1;
    return (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0);
  });
  return tasks;
}

function taskListHtml() {
  if (state.loading && state.tasks.size === 0) return skeletonCards(4);
  const tasks = visibleTasks();
  if (tasks.length === 0) return emptyTasksHtml();
  return tasks.map(taskCardHtml).join('');
}

function skeletonCards(count) {
  return Array.from({ length: count }, () => `<article class="task-card skeleton">
    <div class="sk-line" style="width:34%;height:9px"></div>
    <div class="sk-line" style="width:82%;height:14px;margin-top:12px"></div>
    <div class="sk-line" style="width:64%;height:10px;margin-top:9px"></div>
    <div class="sk-line" style="width:48%;height:8px;margin-top:14px"></div>
  </article>`).join('');
}

function emptyTasksHtml() {
  let title = '还没有任务';
  let text = '在手机上创建第一个任务，或在电脑上开始一段对话，这里会实时出现。';
  if (state.query.trim().length > 0) { title = '没有找到匹配的任务'; text = '换个关键词试试，或清空搜索。'; }
  else if (state.filter === 'running') { title = '没有运行中的任务'; text = '电脑端空闲中。点下方「新建」下发一个任务。'; }
  else if (state.filter === 'done') { title = '还没有已结束的任务'; text = '任务结束或被中断后会出现在这里，并保留完整对话。'; }
  else if (state.filter === 'error') { title = '没有出错的任务'; text = '很好，目前没有失败记录。'; }
  return `<div class="empty">
    <div class="empty-icon">${icon(state.filter === 'error' ? 'check' : 'tasks')}</div>
    <b>${esc(title)}</b>
    <p>${esc(text)}</p>
    ${state.query.length > 0 ? '<button class="chip" data-action="search-close" type="button">清空搜索</button>' : '<button class="chip" data-nav="new" type="button">新建任务</button>'}
  </div>`;
}

function taskCardHtml(task) {
  const meta = statusMeta(task.status);
  const flash = state.flashId === task.id ? ' flash' : '';
  const rawPreview = oneLine(task.lastText ?? '', 160);
  const who = task.lastRole === 'assistant' && !/^DSH\b/iu.test(rawPreview) ? 'DSH' : task.lastRole === 'user' ? '你' : '';
  const preview = task.lastText
    ? `<p class="task-preview">${who ? `<span class="who">${who}</span>` : ''}${esc(rawPreview)}</p>`
    : (task.statusReason && task.status === 'error' ? `<p class="task-preview error-text">${esc(oneLine(task.statusReason, 160))}</p>` : '');
  const model = task.model?.model ? `<span class="task-model">${esc(shortModel(task.model.model))}</span>` : '';
  const turn = task.turn ? `<span>第 ${task.turn} 轮</span>` : '';
  const children = task.childCount ? `<span class="task-badge">${task.childCount} 个子任务</span>` : '';
  const live = task.live ? `<span>${icon('wifi')} 在线</span>` : '';
  return `<article class="task-card ${task.status}${flash}" data-task="${esc(task.id)}" tabindex="0" role="button" aria-label="${esc(task.title ?? '任务')}">
    <div class="task-top">
      <span class="status ${meta.cls}"><i></i>${meta.label}</span>
      <span class="task-time" data-ts="${Number(task.updatedAt) || 0}">${relTime(task.updatedAt)}</span>
    </div>
    <h3>${esc(task.title || '未命名任务')}</h3>
    ${preview}
    <div class="task-meta">
      <span>${icon('folder')}<span class="ellipsis">${esc(task.cwdName || '未知目录')}</span></span>
      ${model}${turn}${children}${live}
    </div>
  </article>`;
}

function paintTasks() {
  if (state.screen !== 'tasks') return;
  const list = $('#task-list');
  if (list !== null) list.innerHTML = taskListHtml();
  updateSummary();
  updateFilterCounts();
  updateFilterChips();
  updateConnUI();
  state.flashId = undefined;
}

function updateSummary() {
  const counts = filterCounts();
  const set = (id, value) => { const element = document.getElementById(id); if (element !== null) element.textContent = String(value); };
  set('sum-running', counts.running);
  set('sum-total', counts.all);
  set('sum-done', counts.done);
  set('sum-error', counts.error);
  set('sum-sub', `共 ${counts.all} 个任务 · 今日 ${state.summary.today ?? 0} 个`);
}

function updateFilterCounts() {
  const counts = filterCounts();
  for (const element of $$('[data-count]')) {
    const key = element.dataset.count;
    if (counts[key] !== undefined) element.textContent = String(counts[key]);
  }
}

function updateFilterChips() {
  for (const chip of $$('[data-filter]')) {
    chip.classList.toggle('active', chip.dataset.filter === state.filter);
  }
}

function updateConnUI() {
  const dot = document.getElementById('conn-dot');
  const text = document.getElementById('conn-text');
  if (dot === null || text === null) return;
  const labels = {
    online: '实时同步中',
    connecting: '正在连接…',
    offline: '连接中断，正在重试',
    polling: '轮询同步中',
  };
  text.textContent = `${serverName()} · ${labels[state.connState] ?? '连接中'}`;
  dot.className = 'live-dot';
  dot.style.background = state.connState === 'online' ? 'var(--ok)' : state.connState === 'connecting' ? 'var(--warn)' : 'var(--danger)';
  dot.style.boxShadow = state.connState === 'online'
    ? '0 0 0 3px rgba(52,211,153,.14)'
    : state.connState === 'connecting'
      ? '0 0 0 3px rgba(251,191,36,.14)'
      : '0 0 0 3px rgba(248,113,113,.14)';
}

/* ---------- connect screen ---------- */

function connectHtml() {
  const pending = state.scanPending;
  const codeValue = state.manualCode || (pending?.code ? displayCode(pending.code) : '');
  const recent = recentServers();
  return `<div class="screen connect">
    <div class="connect-hero">
      <div class="logo-badge">${icon('sparkles')}</div>
      <h1>连接你的 DSH</h1>
      <p>扫描电脑上的二维码，实时查看任务、下发新任务。数据只在你的局域网内流动。</p>
    </div>
    ${pending ? `<div class="qr-pending"><div class="check">${icon('check')}</div><div><b>已读取二维码</b><span>${esc(pending.name || pending.baseUrl)} · ${esc(pending.baseUrl.replace(/^https?:\/\//u, ''))}</span></div></div>` : ''}
    ${state.connectError ? `<div class="offline-bar">${icon('alert')}<span>${esc(state.connectError)}</span></div>` : ''}
    <div class="connect-card">
      <h2>扫码连接</h2>
      <p class="sub">在电脑上打开 DSH 随行配对页，用手机扫描二维码。</p>
      <button class="big-scan" data-action="scan" type="button" ${state.pairing ? 'disabled' : ''}>${icon('scan')} ${state.pairing ? '正在连接…' : '扫一扫电脑上的二维码'}</button>
      <button class="btn-ghost" data-action="manual-toggle" type="button">${state.showManual || pending ? '收起手动输入' : '手动输入配对码'}</button>
      <form id="manual-form" class="${state.showManual || pending || state.connectError ? '' : 'hidden'}" autocomplete="off">
        <div class="field">
          <label for="pair-code">配对码</label>
          <input class="input code" id="pair-code" name="code" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="9" placeholder="ABCD-EFGH" value="${esc(codeValue)}">
        </div>
        <div class="field">
          <label for="device-name">设备名称</label>
          <input class="input" id="device-name" name="deviceName" maxlength="24" placeholder="${esc(defaultDeviceName())}" value="${esc(state.deviceName || state.prefs.deviceName || '')}">
        </div>
        <button class="btn-primary" type="submit" ${state.pairing ? 'disabled' : ''}>${state.pairing ? '正在连接…' : '连接电脑'}</button>
      </form>
    </div>
    <div class="connect-card">
      <h2>怎么找到二维码？</h2>
      <div class="steps-mini">
        <div><b>1</b><span>在电脑上确认 DSH 已启动，并加载了「DSH 随行」插件。</span></div>
        <div><b>2</b><span>用电脑浏览器打开插件输出的配对页地址（形如 <code>http://127.0.0.1:&lt;端口&gt;/pair</code>，端口见插件启动时的输出）。</span></div>
        <div><b>3</b><span>手机与电脑连同一个 Wi-Fi，然后扫描页面上的二维码。</span></div>
      </div>
    </div>
    ${recent.length > 0 ? `<div class="connect-card"><h2>最近连接</h2><div class="recent-list">${recent.map((item) => `<div class="recent-item">${icon('server')}<span class="grow">${esc(item.name)} · ${esc(item.baseUrl.replace(/^https?:\/\//u, ''))}</span><button class="x" data-action="forget-server" data-server="${esc(item.baseUrl)}" type="button" aria-label="移除">${icon('close')}</button></div>`).join('')}</div></div>` : ''}
    <div class="connect-foot">连接后，手机只保存一个设备令牌，可随时在电脑端移除。<br><b>不要把配对页或二维码发到公网。</b></div>
  </div>`;
}

function recentServers() {
  try {
    const raw = localStorage.getItem('dsh.bridge.recent.v1');
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.slice(0, 4) : [];
  } catch { return []; }
}

function rememberServer(entry) {
  try {
    const list = recentServers().filter((item) => item.baseUrl !== entry.baseUrl);
    list.unshift(entry);
    localStorage.setItem('dsh.bridge.recent.v1', JSON.stringify(list.slice(0, 4)));
  } catch { /* ignore */ }
}

/* ---------- detail screen ---------- */

function detailHtml() {
  const task = state.detail?.task ?? (state.detailId ? state.tasks.get(state.detailId) : undefined);
  if (task === undefined) {
    return `<div class="screen detail">
      <header class="detail-header"><button class="icon-btn" data-action="back" type="button">${icon('back')}</button><div class="detail-title"><h1>任务详情</h1><div class="detail-sub"><span class="task-time">正在读取…</span></div></div></header>
      <div class="chat">${detailSkeleton()}</div>
    </div>`;
  }
  const meta = statusMeta(task.status);
  const model = task.model?.model ? `<span class="meta-pill">${icon('cpu')}<span>${esc(shortModel(task.model.model))}</span></span>` : '';
  const turn = task.turn ? `<span class="meta-pill">${icon('refresh')}<span>第 ${task.turn} 轮</span></span>` : '';
  const cwd = `<span class="meta-pill">${icon('folder')}<span>${esc(task.cwdName || task.cwd || '未知目录')}</span></span>`;
  const reason = task.status === 'error' && task.statusReason ? `<span class="meta-pill" style="color:var(--danger);border-color:rgba(248,113,113,.24)">${icon('alert')}<span>${esc(oneLine(task.statusReason, 60))}</span></span>` : '';
  const composer = task.isSubagent
    ? `<div class="composer"><div class="composer-hint">子任务会话请在电脑端继续</div></div>`
    : `<div class="composer">
        <div class="composer-box">
          <textarea id="chat-input" rows="1" placeholder="${task.status === 'running' ? '任务运行中，消息会排队…' : '继续这个任务…'}" maxlength="${MAX_PROMPT}"></textarea>
          <button class="send-btn" id="send-btn" data-action="send-prompt" type="button" aria-label="发送">${icon('send')}</button>
        </div>
        <div class="composer-hint" id="composer-hint">${task.status === 'running' ? 'DSH 正在执行，新消息将在当前轮结束后处理' : '发送后电脑端会继续这个会话'}</div>
      </div>`;
  return `<div class="screen detail">
    <header class="detail-header">
      <button class="icon-btn" data-action="back" type="button" aria-label="返回">${icon('back')}</button>
      <div class="detail-title">
        <h1 id="detail-title">${esc(task.title || '任务详情')}</h1>
        <div class="detail-sub">
          <span class="status ${meta.cls}" id="detail-status"><i></i>${meta.label}</span>
          <span class="task-time" data-ts="${Number(task.updatedAt) || 0}">${relTime(task.updatedAt)}</span>
        </div>
      </div>
      <button class="icon-btn" data-action="task-menu" type="button" aria-label="更多">${icon('more')}</button>
    </header>
    <div class="detail-meta">${cwd}${model}${turn}${reason}</div>
    ${state.detail?.degraded ? `<div class="offline-bar" style="margin:0 16px 8px">${icon('info')}<span>该会话日志较旧，仅显示最近的消息。</span></div>` : ''}
    ${state.detailError ? `<div class="offline-bar" style="margin:0 16px 8px">${icon('alert')}<span>${esc(state.detailError)}</span><button data-action="retry-detail" type="button">重试</button></div>` : ''}
    <div class="chat" id="chat"></div>
    <button class="jump-bottom" id="jump-bottom" data-action="jump-bottom" type="button" aria-label="回到底部">${icon('down')}</button>
    ${composer}
  </div>`;
}

function detailSkeleton() {
  return `<div class="msg msg-assistant"><div class="assistant-card"><div class="sk-line" style="width:30%;height:8px"></div><div class="sk-line" style="width:88%;height:11px;margin-top:11px"></div><div class="sk-line" style="width:72%;height:11px;margin-top:7px"></div></div></div>
    <div class="msg msg-user"><div class="bubble" style="width:58%;height:38px"></div></div>
    <div class="msg msg-assistant"><div class="assistant-card"><div class="sk-line" style="width:44%;height:8px"></div><div class="sk-line" style="width:80%;height:11px;margin-top:11px"></div></div></div>`;
}

function paintDetailChat() {
  const chat = $('#chat');
  if (chat === null) return;
  const atBottom = isChatNearBottom();
  if (state.detail === null) {
    chat.innerHTML = detailSkeleton();
    return;
  }
  const messages = [...(state.detail.messages ?? [])];
  for (const pending of state.pendingPrompts) {
    if (!messages.some((message) => message.role === 'user' && message.text === pending.text)) messages.push(pending);
  }
  if (messages.length === 0) {
    chat.innerHTML = `<div class="empty"><div class="empty-icon">${icon('sparkles')}</div><b>${state.detail.task.status === 'running' ? 'DSH 正在准备…' : '还没有消息'}</b><p>${state.detail.task.status === 'running' ? '模型开始输出后，这里会实时出现。' : '在下方输入消息，继续这个任务。'}</p></div>`;
  } else {
    chat.innerHTML = messages.map(messageHtml).join('');
  }
  updateDetailChrome(state.detail.task);
  if (atBottom || state.chatAuto) requestAnimationFrame(() => scrollChatBottom(true));
}

function messageHtml(message) {
  if (message === null || typeof message !== 'object') return '';
  if (message.role === 'divider') {
    const isStart = message.kind === 'turn-start';
    const iconName = isStart ? 'play' : message.status === 'done' ? 'check' : message.status === 'stopped' ? 'stop' : 'alert';
    const label = isStart ? `第 ${message.turn ?? '?'} 轮` : (message.reason || '本轮结束');
    return `<div class="divider"><span>${icon(iconName)}${esc(label)}</span></div>`;
  }
  if (message.role === 'user') {
    return `<div class="msg msg-user"><div class="bubble">${esc(message.text)}</div><div class="msg-time">${fmtClock(message.at)}</div></div>`;
  }
  if (message.role === 'system') {
    return `<div class="msg msg-assistant msg-error"><div class="assistant-card"><div class="msg-head">${icon('alert')}<b>错误</b><span class="msg-time">${fmtClock(message.at)}</span></div><div class="md"><p>${esc(message.text)}</p></div></div></div>`;
  }
  if (message.role === 'tool' || message.role === 'tool-result') {
    const tool = message.tool ?? {};
    const softCancel = state.detail?.task?.status === 'cancelled' || /(?:aborted|interrupted|cancelled|canceled|已中断)/iu.test(String(tool.result ?? ''));
    const stateText = tool.status === 'running' ? '执行中' : tool.isError ? (softCancel ? '已中断' : '失败') : tool.status === 'done' ? '完成' : '';
    const stateClass = tool.isError ? (softCancel ? 'warn' : 'err') : '';
    const body = tool.result ? `<pre>${esc(tool.result)}</pre>` : '';
    return `<details class="tool-call" ${tool.result ? '' : 'open'}>
      <summary><span class="tool-ico">${icon('terminal')}</span><span class="tool-name">${esc(tool.name || '工具')}</span><span class="tool-arg">${esc(tool.args || '')}</span><span class="tool-state ${stateClass}">${stateText}</span></summary>
      ${body}
    </details>`;
  }
  const reasoning = message.reasoning
    ? `<details class="reasoning"><summary>${icon('chevron')}思考过程</summary><div class="reasoning-body">${esc(message.reasoning)}</div></details>`
    : '';
  const text = message.text
    ? `<div class="md">${renderMarkdown(message.text)}</div>`
    : message.reasoning
      ? ''
      : `<div class="md"><p class="muted">（本轮没有文本输出）</p></div>`;
  const model = message.model?.model ? `<span class="task-model">${esc(shortModel(message.model.model))}</span>` : '';
  return `<div class="msg msg-assistant"><div class="assistant-card">
    <div class="msg-head"><span class="mini-logo">${icon('sparkles')}</span><b>DSH</b>${model}<span class="msg-time">${fmtClock(message.at)}</span></div>
    ${reasoning}${text}
  </div></div>`;
}

function updateDetailChrome(task) {
  if (task === undefined || task === null) return;
  const title = $('#detail-title');
  if (title !== null) title.textContent = task.title || '任务详情';
  const status = $('#detail-status');
  if (status !== null) {
    const meta = statusMeta(task.status);
    status.className = `status ${meta.cls}`;
    status.innerHTML = `<i></i>${meta.label}`;
  }
  for (const element of $$('.detail-sub [data-ts]')) {
    element.dataset.ts = String(Number(task.updatedAt) || 0);
    element.textContent = relTime(task.updatedAt);
  }
  const hint = $('#composer-hint');
  if (hint !== null) {
    hint.textContent = task.status === 'running' ? 'DSH 正在执行，新消息将在当前轮结束后处理' : '发送后电脑端会继续这个会话';
  }
  const input = $('#chat-input');
  if (input !== null) {
    input.placeholder = task.status === 'running' ? '任务运行中，消息会排队…' : '继续这个任务…';
  }
  const send = $('#send-btn');
  if (send !== null) send.disabled = false;
}

function isChatNearBottom() {
  const chat = $('#chat');
  if (chat === null) return true;
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 90;
}

function scrollChatBottom(force = false) {
  const chat = $('#chat');
  if (chat === null) return;
  if (!force && !state.chatAuto) return;
  chat.scrollTop = chat.scrollHeight;
  state.chatAuto = true;
  const jump = $('#jump-bottom');
  if (jump !== null) jump.classList.remove('show');
}

/* ---------- new task screen ---------- */

function newTaskHtml() {
  const workspace = state.workspaces.find((item) => item.path === state.draft.cwd);
  const preset = state.presets.find((item) => item.id === state.draft.preset);
  const cwdLabel = workspace?.title || state.draft.cwd || '选择工作目录';
  const presetLabel = preset?.name || (state.defaultPreset ? '默认预设' : '未选择');
  return `<div class="screen compose-screen">
    <header class="app-header">
      <div class="header-left">
        <button class="icon-btn" data-action="back" type="button" aria-label="返回">${icon('back')}</button>
        <div class="header-titles"><h1>新建任务</h1><p>在电脑上执行</p></div>
      </div>
      <div class="header-actions"><button class="icon-btn" data-nav="tasks" type="button" aria-label="任务列表">${icon('tasks')}</button></div>
    </header>
    <main class="scroll">
      <section class="compose-hero"><h2>让 DSH 做什么？</h2><p>任务会下发到 ${esc(serverName())}，并在电脑上执行。</p></section>
      <div class="prompt-card">
        <textarea id="prompt-input" maxlength="${MAX_PROMPT}" placeholder="例如：检查当前项目的测试失败项并修复，修完后运行一遍完整测试。">${esc(state.draft.prompt)}</textarea>
        <div class="prompt-foot"><span>支持多行，Ctrl / ⌘ + Enter 发送</span><span class="count" id="prompt-count">0 / ${MAX_PROMPT}</span></div>
      </div>
      <div class="quick-prompts">
        <button type="button" data-quick="总结当前工作目录的项目结构，列出关键文件与入口。">总结项目结构</button>
        <button type="button" data-quick="运行测试，定位失败项并修复，最后再跑一遍确认。">运行并修复测试</button>
        <button type="button" data-quick="检查最近的改动，指出潜在风险与需要补的测试。">检查改动风险</button>
        <button type="button" data-quick="为当前项目写一份简洁的 README，说明安装、运行与目录结构。">写 README</button>
      </div>
      <div class="field-card">
        <div class="fc-head"><div class="fc-label">${icon('folder')} 工作目录</div><button class="fc-edit" data-action="pick-workspace" type="button">更换</button></div>
        <div class="fc-value"><span class="ellipsis">${esc(cwdLabel)}</span>${icon('chevron')}</div>
        <div class="fc-hint">${state.draft.cwd ? esc(state.draft.cwd) : '任务将在所选目录中运行'}</div>
      </div>
      <div class="field-card">
        <div class="fc-head"><div class="fc-label">${icon('sparkles')} Agent 预设</div><button class="fc-edit" data-action="pick-preset" type="button">更换</button></div>
        <div class="fc-value"><span class="ellipsis">${esc(presetLabel)}</span>${icon('chevron')}</div>
        <div class="fc-hint">${state.model ? `默认模型 ${esc(shortModel(state.model.model))}` : '使用电脑端默认模型'}</div>
      </div>
      ${state.createError ? `<div class="offline-bar">${icon('alert')}<span>${esc(state.createError)}</span></div>` : ''}
      <div class="create-bar">
        <button class="btn-primary" id="create-btn" data-action="create-task" type="button" ${state.creating ? 'disabled' : ''}>${icon('send')}${state.creating ? '正在下发…' : '发送到电脑'}</button>
        <div class="compose-note">下发后可在手机实时查看进度，也可随时中断。</div>
      </div>
    </main>
  </div>`;
}

function updateComposeChrome() {
  const count = $('#prompt-count');
  if (count !== null) {
    count.textContent = `${state.draft.prompt.length} / ${MAX_PROMPT}`;
    count.classList.toggle('warn', state.draft.prompt.length > MAX_PROMPT * 0.9);
  }
  const button = $('#create-btn');
  if (button !== null) button.disabled = state.creating;
}

/* ---------- settings screen ---------- */

function settingsHtml() {
  const theme = state.prefs.theme;
  const connected = state.connState === 'online';
  const install = state.installPrompt !== null;
  return `<div class="screen settings-screen">
    <header class="app-header">
      <div class="header-left"><div class="logo-badge">${icon('sparkles')}</div><div class="header-titles"><h1>我的</h1><p>连接、通知与关于</p></div></div>
      <div class="header-actions"><button class="icon-btn" data-nav="tasks" type="button" aria-label="任务">${icon('tasks')}</button></div>
    </header>
    <main class="scroll">
      <section class="settings-title"><h2>连接</h2><p>${esc(serverName())} · ${connected ? '实时连接正常' : '连接可能已中断'}</p></section>
      <div class="settings-group">
        <h3>当前电脑</h3>
        <div class="settings-card">
          <div class="setting-row">
            <div class="setting-icon">${icon('server')}</div>
            <div class="setting-main"><b>${esc(serverName())}</b><span>${esc(baseUrl().replace(/^https?:\/\//u, ''))}</span></div>
            <span class="chev" style="color:${connected ? 'var(--ok)' : 'var(--warn)'}">${connected ? '在线' : '重连中'}</span>
          </div>
          <div class="setting-row">
            <div class="setting-icon">${icon('wifi')}</div>
            <div class="setting-main"><b>延迟</b><span>${state.latency > 0 ? `${state.latency} ms · 局域网` : '检测中…'}</span></div>
            <button class="fc-edit" data-action="test-latency" type="button">重测</button>
          </div>
          <div class="setting-row">
            <div class="setting-icon">${icon('phone')}</div>
            <div class="setting-main"><b>${esc(state.me?.device?.name ?? state.session?.device?.name ?? '本机')}</b><span>${esc(state.me?.device?.platform ?? (isNative() ? 'HarmonyOS' : 'Web'))} · 设备令牌已保存</span></div>
          </div>
        </div>
      </div>
      <div class="settings-group">
        <h3>体验</h3>
        <div class="settings-card">
          <div class="setting-row">
            <div class="setting-icon">${icon('moon')}</div>
            <div class="setting-main"><b>外观</b><span>深色更适合夜间查看任务</span></div>
            <div class="segmented">
              <button class="${theme === 'dark' ? 'on' : ''}" data-theme-choice="dark" type="button">深色</button>
              <button class="${theme === 'light' ? 'on' : ''}" data-theme-choice="light" type="button">浅色</button>
              <button class="${theme === 'auto' ? 'on' : ''}" data-theme-choice="auto" type="button">跟随</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-icon">${icon('bell')}</div>
            <div class="setting-main"><b>任务完成通知</b><span>${typeof Notification === 'function' && Notification.permission === 'granted' ? '已允许系统通知' : '需要系统通知权限'}</span></div>
            <button class="switch ${state.prefs.notify ? 'on' : ''}" data-action="toggle-notify" type="button" aria-label="任务完成通知"></button>
          </div>
          <div class="setting-row">
            <div class="setting-icon">${icon('tasks')}</div>
            <div class="setting-main"><b>显示子任务</b><span>默认隐藏，保持列表清爽</span></div>
            <button class="switch ${state.prefs.showSubagents ? 'on' : ''}" data-action="toggle-subagents" type="button" aria-label="显示子任务"></button>
          </div>
        </div>
      </div>
      <div class="settings-group">
        <h3>应用</h3>
        <div class="settings-card">
          ${install ? `<div class="setting-row" data-action="install"><div class="setting-icon">${icon('down')}</div><div class="setting-main"><b>安装到桌面</b><span>像原生 App 一样全屏打开</span></div><span class="chev">${icon('chevron')}</span></div>` : ''}
          <div class="setting-row" data-action="copy-diagnostics"><div class="setting-icon">${icon('copy')}</div><div class="setting-main"><b>复制诊断信息</b><span>服务器、版本、连接状态</span></div><span class="chev">${icon('chevron')}</span></div>
          <div class="setting-row" data-action="reconnect"><div class="setting-icon">${icon('refresh')}</div><div class="setting-main"><b>重新连接</b><span>刷新任务并重建实时通道</span></div><span class="chev">${icon('chevron')}</span></div>
          <div class="setting-row" data-action="change-server"><div class="setting-icon">${icon('external')}</div><div class="setting-main"><b>更换电脑</b><span>断开当前配对，重新扫码</span></div><span class="chev">${icon('chevron')}</span></div>
          <div class="setting-row danger" data-action="disconnect"><div class="setting-icon" style="color:var(--danger)">${icon('trash')}</div><div class="setting-main"><b>断开配对</b><span>电脑端会立即移除本机令牌</span></div><span class="chev">${icon('chevron')}</span></div>
        </div>
      </div>
      <div class="settings-group">
        <h3>关于</h3>
        <div class="settings-card about-card">
          <div class="logo-badge">${icon('sparkles')}</div>
          <b>DSH 随行</b>
          <span>v${APP_VERSION} · 协议 v${PROTOCOL}<br>DeepSeek Harness 手机桥接<br>局域网直连，不经过任何第三方服务器</span>
        </div>
      </div>
      <div class="section-note" style="text-align:center">在电脑浏览器打开 <b>http://127.0.0.1:${esc(String(state.bridge?.port ?? 8766))}/pair</b> 可重新配对或移除设备。</div>
    </main>
    ${tabbar('settings')}
  </div>`;
}

function updateSettingsChrome() {
  /* Settings is small enough to render as a unit; this hook keeps the
     contract for future incremental updates. */
}

/* ---------------- markdown ---------------- */

function renderMarkdown(source) {
  const raw = String(source ?? '').replace(/\r\n/gu, '\n').slice(0, 24_000);
  const blocks = [];
  let text = raw.replace(/```([\w+#.-]*)\n([\s\S]*?)```/gu, (_match, language, code) => {
    const index = blocks.length;
    blocks.push(`<pre><code data-lang="${esc(language)}">${esc(code.replace(/\n$/u, ''))}</code></pre>`);
    return `\u0000B${index}\u0000`;
  });
  const inline = [];
  text = text.replace(/`([^`\n]+)`/gu, (_match, code) => {
    const index = inline.length;
    inline.push(`<code>${esc(code)}</code>`);
    return `\u0000I${index}\u0000`;
  });
  text = esc(text);
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu, (_match, label, url) => {
    return `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });
  text = text.replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/gu, '$1<em>$2</em>');
  const lines = text.split('\n');
  const output = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    output.push(`<p>${paragraph.join('<br>')}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list !== null) { output.push(`</${list}>`); list = null; }
  };
  const openList = (type) => {
    if (list === type) return;
    closeList();
    output.push(`<${type}>`);
    list = type;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\u0000B\d+\u0000$/u.test(trimmed)) {
      flushParagraph(); closeList(); output.push(trimmed); continue;
    }
    if (trimmed.length === 0) { flushParagraph(); closeList(); continue; }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/u);
    if (heading !== null) {
      flushParagraph(); closeList();
      const level = Math.min(4, heading[1].length);
      output.push(`<h${level}>${heading[2]}</h${level}>`);
      continue;
    }
    if (/^([-*_])\1{2,}$/u.test(trimmed)) { flushParagraph(); closeList(); output.push('<hr>'); continue; }
    if (/^>\s?/u.test(trimmed)) {
      flushParagraph(); closeList();
      output.push(`<blockquote>${trimmed.replace(/^>\s?/u, '')}</blockquote>`);
      continue;
    }
    const unordered = trimmed.match(/^[-*+]\s+(.*)$/u);
    if (unordered !== null) { flushParagraph(); openList('ul'); output.push(`<li>${unordered[1]}</li>`); continue; }
    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/u);
    if (ordered !== null) { flushParagraph(); openList('ol'); output.push(`<li>${ordered[1]}</li>`); continue; }
    paragraph.push(line);
  }
  flushParagraph();
  closeList();
  let html = output.join('\n');
  html = html.replace(/\u0000B(\d+)\u0000/gu, (_match, index) => blocks[Number(index)] ?? '');
  html = html.replace(/\u0000I(\d+)\u0000/gu, (_match, index) => inline[Number(index)] ?? '');
  return html;
}

/* ---------------- actions ---------------- */

async function pairWithCode({ code, baseUrl: targetBase, deviceName: name }) {
  if (state.pairing) return;
  const clean = normalizeCode(code);
  if (clean.length !== 8) { toast('请输入 8 位配对码', 'err'); return; }
  const root = normalizeBase(targetBase ?? state.scanPending?.baseUrl ?? location.origin);
  state.pairing = true;
  state.pairingMessage = '正在连接…';
  state.connectError = '';
  if (state.screen === 'connect') render();
  try {
    const data = await api('/api/v1/pair', {
      method: 'POST',
      base: root,
      auth: false,
      body: {
        code: clean,
        deviceId: deviceId(),
        name: oneLine(name || state.deviceName || state.prefs.deviceName || defaultDeviceName(), 24),
        platform: isHarmony() ? 'harmonyos' : 'web',
        appVersion: APP_VERSION,
      },
    });
    const session = {
      baseUrl: root,
      token: data.token,
      device: data.device,
      server: data.server,
      pairedAt: Date.now(),
    };
    state.session = session;
    state.me = null;
    state.scanPending = null;
    state.connectError = '';
    saveSession(session);
    rememberServer({ baseUrl: root, name: data.server?.name ?? root });
    history.replaceState(null, '', '#/tasks');
    state.screen = 'tasks';
    render();
    toast(`已连接 ${data.server?.name ?? '电脑'}`, 'ok');
    haptic();
    await enterApp();
  } catch (error) {
    state.connectError = error?.message ?? '配对失败';
    state.showManual = true;
    if (state.screen === 'connect') render();
  } finally {
    state.pairing = false;
    state.pairingMessage = '';
    if (state.screen === 'connect') render();
  }
}

async function handleScan() {
  haptic();
  if (isNative() && typeof window.DSHNative?.scan === 'function') {
    try {
      const result = window.DSHNative.scan();
      if (result && typeof result.then === 'function') {
        const value = await result;
        if (value) handleScanText(typeof value === 'string' ? value : value.originalValue ?? value.value);
      }
      return;
    } catch {
      toast('无法打开相机，请手动输入配对码', 'err');
      state.showManual = true;
      render();
      return;
    }
  }
  openSheet(`<div class="sheet"><div class="sheet-handle"></div><h3>用系统相机扫码</h3>
    <p class="sheet-sub">手机浏览器在局域网 HTTP 下无法直接调用相机。请用系统相机扫描电脑上的二维码，系统会打开本页并自动连接；也可以手动输入配对码。</p>
    <div class="steps-mini" style="margin-bottom:14px">
      <div><b>1</b><span>打开手机「相机」，对准电脑屏幕上的二维码。</span></div>
      <div><b>2</b><span>点击弹出的链接，App 会自动读取配对码并连接。</span></div>
      <div><b>3</b><span>如果无法扫码，直接在连接页输入 8 位配对码。</span></div>
    </div>
    <div class="sheet-actions"><button class="btn-cancel" data-close type="button">关闭</button><button class="btn-ok" data-modal-action="manual" type="button">手动输入</button></div>
  </div>`);
}

function handleScanText(text) {
  const parsed = parseScanText(text);
  if (parsed === null) { toast('二维码内容无法识别', 'err'); return; }
  if (parsed.url) {
    try {
      const target = new URL(parsed.url);
      if (location.protocol.startsWith('http') && target.origin !== location.origin) {
        location.href = target.href;
        return;
      }
    } catch { /* ignore */ }
  }
  state.scanPending = { baseUrl: parsed.baseUrl, code: parsed.code, name: parsed.name ?? '' };
  state.manualCode = displayCode(parsed.code);
  state.showManual = true;
  if (state.screen !== 'connect') {
    state.screen = 'connect';
    history.replaceState(null, '', '#/connect');
  }
  render();
  void pairWithCode({ code: parsed.code, baseUrl: parsed.baseUrl, deviceName: state.deviceName });
}

function openTaskMenu() {
  const task = state.detail?.task ?? (state.detailId ? state.tasks.get(state.detailId) : undefined);
  if (!task) return;
  const running = task.status === 'running';
  openSheet(`<div class="sheet"><div class="sheet-handle"></div><h3>任务操作</h3><p class="sheet-sub">${esc(task.title ?? '')}</p>
    <button class="sheet-option" data-modal-action="refresh-task" type="button"><span class="so-main"><b>刷新详情</b><span>重新读取最新消息</span></span><span class="check">${icon('refresh')}</span></button>
    <button class="sheet-option" data-modal-action="copy-id" type="button"><span class="so-main"><b>复制任务 ID</b><span>${esc(task.id)}</span></span><span class="check">${icon('copy')}</span></button>
    ${!task.isSubagent ? `<button class="sheet-option" data-modal-action="copy-cwd" type="button"><span class="so-main"><b>复制工作目录</b><span>${esc(task.cwd ?? '')}</span></span><span class="check">${icon('folder')}</span></button>` : ''}
    ${running ? `<button class="sheet-option" data-modal-action="cancel-task" type="button" style="color:var(--danger)"><span class="so-main"><b style="color:var(--danger)">中断任务</b><span>停止当前回合，历史保留</span></span><span class="check">${icon('stop')}</span></button>` : ''}
    <div class="sheet-actions"><button class="btn-cancel" data-close type="button">关闭</button></div>
  </div>`);
}

async function cancelCurrentTask() {
  const task = state.detail?.task ?? (state.detailId ? state.tasks.get(state.detailId) : undefined);
  if (!task) return;
  closeModal();
  const ok = await confirmDialog({ title: '中断这个任务？', message: '当前回合会被停止，已经产生的消息和文件改动会保留。', okText: '中断', danger: true });
  if (!ok) return;
  try {
    await api(`/api/v1/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST' });
    toast('已发送中断请求', 'ok');
    await loadTasks({ silent: true });
    if (state.detailId === task.id) { await loadDetail(task.id, { silent: true }); updateDetailChrome(state.tasks.get(task.id) ?? task); }
  } catch (error) {
    toast(error?.message ?? '中断失败', 'err');
  }
}

async function sendPrompt() {
  const input = $('#chat-input');
  if (input === null || state.detailId === null) return;
  const text = input.value.trim();
  if (text.length === 0) return;
  if (text.length > MAX_PROMPT) { toast('消息过长', 'err'); return; }
  const taskId = state.detailId;
  state.pendingPrompts.push({ id: `pending-${uid('')}`, role: 'user', text, at: Date.now() });
  input.value = '';
  autoGrow(input);
  paintDetailChat();
  const button = $('#send-btn');
  if (button !== null) button.disabled = true;
  try {
    await api(`/api/v1/tasks/${encodeURIComponent(taskId)}/prompt`, { method: 'POST', body: { prompt: text } });
    haptic();
    if (state.detailId === taskId) scheduleDetailRefresh();
  } catch (error) {
    state.pendingPrompts = state.pendingPrompts.filter((pending) => pending.text !== text);
    if (state.detailId === taskId) {
      const current = $('#chat-input');
      if (current !== null && current.value.length === 0) current.value = text;
      paintDetailChat();
    }
    toast(error?.message ?? '发送失败', 'err');
  } finally {
    if (button !== null) button.disabled = false;
  }
}

async function createTask() {
  if (state.creating) return;
  const prompt = state.draft.prompt.trim();
  if (prompt.length === 0) { toast('先写点任务内容', 'err'); $('#prompt-input')?.focus(); return; }
  if (prompt.length > MAX_PROMPT) { toast('任务内容过长', 'err'); return; }
  if (state.draft.cwd.length === 0) { openWorkspaceSheet(); toast('请选择工作目录', 'err'); return; }
  if (!state.draft.clientTaskId) state.draft.clientTaskId = uid('ct');
  state.creating = true;
  state.createError = '';
  updateComposeChrome();
  try {
    const data = await api('/api/v1/tasks', {
      method: 'POST',
      body: {
        prompt,
        cwd: state.draft.cwd,
        preset: state.draft.preset || undefined,
        clientTaskId: state.draft.clientTaskId,
      },
    });
    const task = data?.task;
    if (task) {
      upsertTask(task);
      state.flashId = task.id;
      state.draft = { prompt: '', cwd: state.draft.cwd, preset: state.draft.preset, clientTaskId: '' };
      savePrefs({ lastCwd: state.draft.cwd });
      haptic();
      toast('任务已下发', 'ok');
      navigate(`/task/${encodeURIComponent(task.id)}`);
    }
  } catch (error) {
    state.createError = error?.message ?? '下发失败';
    updateComposeChrome();
    toast(state.createError, 'err');
  } finally {
    state.creating = false;
    updateComposeChrome();
  }
}

function openWorkspaceSheet() {
  const current = state.draft.cwd;
  const rows = state.workspaces.map((workspace) => `<button class="sheet-option ${workspace.path === current ? 'on' : ''}" data-pick-workspace="${esc(workspace.path)}" type="button" ${workspace.available === false ? 'disabled' : ''}>
    <span class="setting-icon">${icon('folder')}</span>
    <span class="so-main"><b>${esc(workspace.title || workspace.path)}</b><span>${esc(workspace.path)}${workspace.available === false ? ' · 不可用' : ''}</span></span>
    <span class="check">${icon('check')}</span>
  </button>`).join('') || '<div class="section-note">电脑上还没有登记工作目录，请在下方输入一个绝对路径。</div>';
  openSheet(`<div class="sheet"><div class="sheet-handle"></div><h3>选择工作目录</h3><p class="sheet-sub">任务会在该目录中执行，可访问其中的文件。</p>
    ${rows}
    <div class="field" style="margin-top:14px"><label for="custom-cwd">或输入绝对路径</label><input class="input" id="custom-cwd" placeholder="/Users/you/project 或 D:\\project" value="${esc(current)}"></div>
    <div class="sheet-actions"><button class="btn-cancel" data-close type="button">取消</button><button class="btn-ok" data-modal-action="use-custom-cwd" type="button">使用此路径</button></div>
  </div>`);
}

function openPresetSheet() {
  const current = state.draft.preset;
  const rows = state.presets.map((preset) => `<button class="sheet-option ${preset.id === current ? 'on' : ''}" data-pick-preset="${esc(preset.id)}" type="button">
    <span class="setting-icon">${icon('sparkles')}</span>
    <span class="so-main"><b>${esc(preset.name || preset.id)}${preset.isDefault ? ' · 默认' : ''}</b><span>${esc(preset.description || preset.id)}</span></span>
    <span class="check">${icon('check')}</span>
  </button>`).join('');
  openSheet(`<div class="sheet"><div class="sheet-handle"></div><h3>Agent 预设</h3><p class="sheet-sub">决定这次任务的工具、提示词与权限组合。</p>
    <button class="sheet-option ${current === '' ? 'on' : ''}" data-pick-preset="" type="button"><span class="setting-icon">${icon('cpu')}</span><span class="so-main"><b>使用电脑默认</b><span>${state.defaultPreset ? esc(state.defaultPreset) : '由 DSH 运行时决定'}</span></span><span class="check">${icon('check')}</span></button>
    ${rows || '<div class="section-note">当前主机没有返回可用预设。</div>'}
    <div class="sheet-actions"><button class="btn-cancel" data-close type="button">取消</button></div>
  </div>`);
}

function openTheme() {
  savePrefs({ theme: state.prefs.theme });
}

async function toggleNotifications() {
  if (state.prefs.notify) {
    savePrefs({ notify: false });
    if (state.screen === 'settings') render();
    return;
  }
  if (typeof Notification !== 'function') { toast('当前环境不支持系统通知', 'err'); return; }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { toast('通知权限被拒绝，可在系统设置中开启', 'err'); return; }
  savePrefs({ notify: true });
  if (state.screen === 'settings') render();
  toast('已开启任务完成通知', 'ok');
}

async function disconnect() {
  const ok = await confirmDialog({ title: '断开这台手机？', message: '电脑端会立即移除本机令牌，之后需要重新扫码才能连接。', okText: '断开', danger: true });
  if (!ok) return;
  try { await api('/api/v1/self/revoke', { method: 'POST' }); } catch { /* token may already be gone */ }
  closeRealtime();
  clearSession();
  state.session = null;
  state.me = null;
  state.tasks = new Map();
  state.order = [];
  state.detail = null;
  state.detailId = null;
  state.screen = 'connect';
  history.replaceState(null, '', '#/connect');
  render();
  toast('已断开配对', 'ok');
}

function changeServer() {
  closeRealtime();
  clearSession();
  state.session = null;
  state.me = null;
  state.tasks = new Map();
  state.order = [];
  state.screen = 'connect';
  state.showManual = true;
  history.replaceState(null, '', '#/connect');
  render();
}

async function reconnect() {
  toast('正在重新连接…');
  state.bridgeFailures = 0;
  state.lastSeq = 0;
  closeRealtime();
  await enterApp();
}

async function copyDiagnostics() {
  const lines = [
    `DSH 随行 v${APP_VERSION} (protocol ${PROTOCOL})`,
    `server: ${serverName()}`,
    `baseUrl: ${baseUrl()}`,
    `conn: ${state.connState} / latency ${state.latency}ms`,
    `tasks: ${state.summary.total ?? 0} total, ${state.summary.running ?? 0} running`,
    `port: ${state.bridge?.port ?? '?'}`,
    `native: ${isNative() ? 'yes' : 'no'}`,
    `ua: ${navigator.userAgent}`,
  ];
  await copyText(lines.join('\n'));
}

function openInstallHelp() {
  openSheet(`<div class="sheet"><div class="sheet-handle"></div><h3>安装到桌面</h3><p class="sheet-sub">把 DSH 随行放到主屏幕，打开时没有浏览器地址栏。</p>
    <div class="steps-mini" style="margin-bottom:14px">
      <div><b>1</b><span>在手机浏览器中打开本页。</span></div>
      <div><b>2</b><span>点击浏览器菜单，选择「添加到主屏幕」。</span></div>
      <div><b>3</b><span>从主屏幕启动，体验与原生 App 一致。</span></div>
    </div>
    <div class="sheet-actions"><button class="btn-cancel" data-close type="button">知道了</button></div>
  </div>`);
}

/* ---------------- event handlers ---------------- */

function autoGrow(textarea) {
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(118, Math.max(26, textarea.scrollHeight))}px`;
}

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action],[data-nav],[data-task],[data-filter],[data-quick],[data-theme-choice]');
  if (target === null) return;
  if (target.dataset.nav) {
    haptic();
    navigate(`/${target.dataset.nav}`);
    return;
  }
  if (target.dataset.task) {
    haptic();
    navigate(`/task/${encodeURIComponent(target.dataset.task)}`);
    return;
  }
  if (target.dataset.filter) {
    state.filter = target.dataset.filter;
    paintTasks();
    return;
  }
  if (target.dataset.quick) {
    state.draft.prompt = target.dataset.quick;
    const input = $('#prompt-input');
    if (input !== null) { input.value = state.draft.prompt; autoGrow(input); }
    updateComposeChrome();
    return;
  }
  if (target.dataset.themeChoice) {
    savePrefs({ theme: target.dataset.themeChoice });
    applyTheme();
    render();
    return;
  }
  switch (target.dataset.action) {
    case 'scan': void handleScan(); break;
    case 'manual-toggle': state.showManual = !state.showManual; render(); break;
    case 'search-toggle': {
      const bar = $('#search-bar');
      bar?.classList.toggle('hidden');
      if (bar !== null && !bar.classList.contains('hidden')) $('#search-input')?.focus();
      break;
    }
    case 'search-close': {
      state.query = '';
      const input = $('#search-input');
      if (input !== null) input.value = '';
      paintTasks();
      $('#search-bar')?.classList.add('hidden');
      break;
    }
    case 'refresh': void loadTasks().then(() => toast('已刷新', 'ok')).catch((error) => toast(error.message, 'err')); break;
    case 'retry': void enterApp(); break;
    case 'settings': navigate('/settings'); break;
    case 'back': if (history.length > 1) history.back(); else navigate('/tasks', { replace: true }); break;
    case 'task-menu': openTaskMenu(); break;
    case 'send-prompt': void sendPrompt(); break;
    case 'jump-bottom': scrollChatBottom(true); break;
    case 'retry-detail': if (state.detailId !== null) void loadDetail(state.detailId); break;
    case 'create-task': void createTask(); break;
    case 'pick-workspace': openWorkspaceSheet(); break;
    case 'pick-preset': openPresetSheet(); break;
    case 'test-latency': void loadMe().then(() => { if (state.screen === 'settings') render(); toast('延迟已更新', 'ok'); }).catch((error) => toast(error.message, 'err')); break;
    case 'toggle-notify': void toggleNotifications(); break;
    case 'toggle-subagents': savePrefs({ showSubagents: !state.prefs.showSubagents }); void loadTasks({ silent: true }).then(() => { if (state.screen === 'settings') render(); }); break;
    case 'disconnect': void disconnect(); break;
    case 'change-server': void confirmDialog({ title: '更换电脑？', message: '当前配对会从这台手机上移除，需要重新扫描新电脑的二维码。', okText: '更换' }).then((ok) => { if (ok) changeServer(); }); break;
    case 'reconnect': void reconnect(); break;
    case 'copy-diagnostics': void copyDiagnostics(); break;
    case 'install': void promptInstall(); break;
    case 'reload': location.reload(); break;
    case 'forget-server': {
      const server = target.dataset.server;
      try {
        const list = recentServers().filter((item) => item.baseUrl !== server);
        localStorage.setItem('dsh.bridge.recent.v1', JSON.stringify(list));
      } catch { /* ignore */ }
      render();
      break;
    }
    default: break;
  }
});

app.addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target.id === 'pair-code') {
    const formatted = displayCode(target.value);
    target.value = formatted;
    state.manualCode = formatted;
  } else if (target.id === 'device-name') {
    state.deviceName = target.value;
  } else if (target.id === 'search-input') {
    state.query = target.value;
    paintTasks();
  } else if (target.id === 'prompt-input') {
    state.draft.prompt = target.value;
    updateComposeChrome();
    autoGrow(target);
  } else if (target.id === 'chat-input') {
    autoGrow(target);
  }
});

app.addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.target.id === 'manual-form') {
    const code = $('#pair-code')?.value ?? state.manualCode;
    const name = $('#device-name')?.value ?? state.deviceName;
    state.deviceName = name;
    savePrefs({ deviceName: name });
    void pairWithCode({ code, baseUrl: state.scanPending?.baseUrl ?? location.origin, deviceName: name });
  }
});

app.addEventListener('keydown', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  if (target.id === 'prompt-input' && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    void createTask();
  }
  if (target.id === 'chat-input' && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendPrompt();
  }
});

app.addEventListener('scroll', (event) => {
  if (event.target?.id === 'chat') {
    const chat = event.target;
    const near = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 90;
    state.chatAuto = near;
    const jump = $('#jump-bottom');
    if (jump !== null) jump.classList.toggle('show', !near && chat.scrollHeight > chat.clientHeight + 120);
  }
}, true);

modalRoot.addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) { closeModal(); return; }
  const confirm = event.target.closest('[data-confirm]');
  if (confirm !== null) {
    const resolve = state.confirmResolve;
    state.confirmResolve = undefined;
    closeModal();
    if (typeof resolve === 'function') resolve(confirm.dataset.confirm === '1');
    return;
  }
  const workspace = event.target.closest('[data-pick-workspace]');
  if (workspace !== null) {
    state.draft.cwd = workspace.dataset.pickWorkspace;
    savePrefs({ lastCwd: state.draft.cwd });
    closeModal();
    if (state.screen === 'new') render();
    return;
  }
  const preset = event.target.closest('[data-pick-preset]');
  if (preset !== null) {
    state.draft.preset = preset.dataset.pickPreset;
    closeModal();
    if (state.screen === 'new') render();
    return;
  }
  const action = event.target.closest('[data-modal-action]');
  if (action === null) return;
  switch (action.dataset.modalAction) {
    case 'manual':
      closeModal();
      state.showManual = true;
      if (state.screen !== 'connect') { state.screen = 'connect'; history.replaceState(null, '', '#/connect'); }
      render();
      setTimeout(() => $('#pair-code')?.focus(), 80);
      break;
    case 'use-custom-cwd': {
      const value = ($('#custom-cwd')?.value ?? '').trim();
      if (value.length === 0) { toast('请输入目录路径', 'err'); return; }
      state.draft.cwd = value;
      savePrefs({ lastCwd: value });
      closeModal();
      if (state.screen === 'new') render();
      break;
    }
    case 'refresh-task': closeModal(); if (state.detailId !== null) void loadDetail(state.detailId); break;
    case 'copy-id': closeModal(); void copyText(state.detail?.task?.id ?? state.detailId ?? ''); break;
    case 'copy-cwd': closeModal(); void copyText(state.detail?.task?.cwd ?? ''); break;
    case 'cancel-task': void cancelCurrentTask(); break;
    default: break;
  }
});

window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#pair=')) {
    const parsed = parsePairHash(location.hash);
    if (parsed !== null) {
      state.scanPending = parsed;
      state.manualCode = displayCode(parsed.code);
      state.screen = 'connect';
      history.replaceState(null, '', '#/connect');
      render();
      void pairWithCode({ code: parsed.code, baseUrl: parsed.baseUrl, deviceName: state.deviceName });
      return;
    }
  }
  applyRoute();
});

window.addEventListener('online', () => {
  state.error = '';
  if (state.session !== null) { state.bridgeFailures = 0; void connectRealtime(); void loadTasks({ silent: true }).catch(() => {}); }
});
window.addEventListener('offline', () => {
  state.connState = 'offline';
  updateConnUI();
  toast('网络已断开', 'err');
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installPrompt = event;
  if (state.screen === 'settings') render();
});

async function promptInstall() {
  if (state.installPrompt !== null) {
    const prompt = state.installPrompt;
    state.installPrompt = null;
    prompt.prompt();
    try { await prompt.userChoice; } catch { /* ignore */ }
    if (state.screen === 'settings') render();
    return;
  }
  openInstallHelp();
}

window.__dshScanResult = (value) => {
  const text = typeof value === 'string' ? value : value?.originalValue ?? value?.value ?? '';
  handleScanText(text);
};

/* pull to refresh */
app.addEventListener('touchstart', (event) => {
  const scroll = $('#tasks-scroll');
  if (state.screen !== 'tasks' || scroll === null || scroll.scrollTop > 0) { state.pullStart = null; return; }
  state.pullStart = event.touches[0]?.clientY ?? null;
  state.pullDistance = 0;
}, { passive: true });
app.addEventListener('touchmove', (event) => {
  if (state.pullStart === null) return;
  const y = event.touches[0]?.clientY ?? 0;
  state.pullDistance = Math.max(0, y - state.pullStart);
  const hint = $('#pull-hint');
  if (hint !== null && state.pullDistance > 20) hint.classList.add('show');
}, { passive: true });
app.addEventListener('touchend', () => {
  if (state.pullStart !== null && state.pullDistance > 64) {
    void loadTasks({ silent: true }).then(() => toast('已刷新', 'ok')).catch((error) => toast(error.message, 'err'));
  }
  $('#pull-hint')?.classList.remove('show');
  state.pullStart = null;
  state.pullDistance = 0;
}, { passive: true });

/* ---------------- boot ---------------- */

async function boot() {
  loadPrefs();
  applyTheme();
  const pair = parsePairHash(location.hash);
  if (pair !== null) {
    state.scanPending = pair;
    state.manualCode = displayCode(pair.code);
    state.screen = 'connect';
    history.replaceState(null, '', '#/connect');
    render();
    setTimeout(() => { void pairWithCode({ code: pair.code, baseUrl: pair.baseUrl, deviceName: state.deviceName }); }, 350);
    return;
  }
  const saved = loadSession();
  if (saved !== null) {
    const route = parseRoute();
    state.session = saved;
    state.screen = route.name === 'connect' ? 'tasks' : route.name;
    if (route.name === 'detail') state.detailId = route.id;
    if (route.name === 'connect') history.replaceState(null, '', '#/tasks');
    render();
    await enterApp();
    if (route.name === 'detail' || route.name === 'new' || route.name === 'settings') applyRoute();
  } else {
    state.screen = 'connect';
    history.replaceState(null, '', '#/connect');
    render();
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot().catch((error) => {
  console.error('[DSH]', error);
  app.innerHTML = `<div class="screen connect"><div class="connect-hero"><div class="logo-badge">${icon('alert')}</div><h1>启动失败</h1><p>${esc(error?.message ?? '未知错误')}</p></div><div class="connect-card"><button class="btn-primary" data-action="reload" type="button">重新加载</button></div></div>`;
});
