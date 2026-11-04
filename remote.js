/* ============================================================
   DSH 随行 · remote bootstrap
   ------------------------------------------------------------
   This page is static. Everything dynamic is tunnelled through an
   AES-256-GCM sealed MQTT room to the desktop bridge, which is the only
   party that can open the seal. The UI itself (app.js) is untouched: we
   shim fetch / WebSocket / EventSource and let it talk to a fake origin.
   ============================================================ */
'use strict';

const REMOTE_ORIGIN = 'https://dsh-remote.local';
const BROKERS = [
  'wss://broker-cn.emqx.io:8084/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];
const HELLO_TIMEOUT_MS = 12_000;
/**
 * Per-attempt budget, not the total: a lost frame should be re-asked in a few
 * seconds, not after thirteen. The desktop caches replies by request id, so a
 * retry replays the answer instead of re-running the request.
 */
const RPC_TIMEOUT_MS = 16_000;
const RPC_ATTEMPTS = 4;
// 电脑端 beat 间隔是 8 s；留 3 倍余量，避免手机侧网络抖动误报。
const PC_STALE_MS = 26_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const splash = document.getElementById('remote-splash');
const splashText = document.getElementById('remote-splash-text');
const splashSub = document.getElementById('remote-splash-sub');

function setSplash(text, sub) {
  if (splashText !== null && typeof text === 'string') splashText.textContent = text;
  if (splashSub !== null && typeof sub === 'string') splashSub.textContent = sub;
}

function hideSplash() {
  if (splash === null) return;
  splash.classList.add('is-hidden');
  setTimeout(() => splash.remove(), 420);
}

/* --------------------------- 登录态（15 天） --------------------------- */

const SESSION_KEY = 'dsh.phone.session.v1';

function loadSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    if (parsed === null || typeof parsed !== 'object') return null;
    if (typeof parsed.token !== 'string' || parsed.token.length < 20) return null;
    if (Number(parsed.expiresAt) <= Date.now()) { localStorage.removeItem(SESSION_KEY); return null; }
    return { token: parsed.token, expiresAt: Number(parsed.expiresAt), user: String(parsed.user ?? '') };
  } catch { return null; }
}

function saveSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* 无痕模式 */ }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

const LOGIN_STYLE = [
  'position:fixed', 'inset:0', 'z-index:2147483001', 'display:flex', 'align-items:center', 'justify-content:center',
  'padding:24px', 'background:linear-gradient(160deg,#101418 0%,#1b2430 100%)',
  'font:15px/1.5 system-ui,-apple-system,"HarmonyOS Sans","PingFang SC",sans-serif', 'color:#eef2f6',
].join(';');

/**
 * 拦住没有令牌的手机：只有电脑端认可的用户名口令才能进入界面。
 * 登录成功后令牌存本机 15 天，下次打开直接进。
 */
function showLogin(relay, { user = '', reason = '' } = {}) {
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    layer.id = 'dsh-login';
    layer.style.cssText = LOGIN_STYLE;
    layer.innerHTML = `
      <form id="dsh-login-form" style="width:100%;max-width:360px;background:#fff;color:#15181d;border-radius:18px;padding:26px 22px;box-shadow:0 24px 60px rgba(0,0,0,.45)">
        <div style="font-size:19px;font-weight:700;margin-bottom:4px">连接我的电脑</div>
        <div style="font-size:13px;color:#5b6470;margin-bottom:18px">这台设备还没有登录，输入电脑上设置的用户名和密码。</div>
        <label style="display:block;font-size:12px;color:#5b6470;margin-bottom:6px">用户名</label>
        <input id="dsh-login-user" autocomplete="username" autocapitalize="off" spellcheck="false"
          value="${user.replace(/"/gu, '&quot;')}"
          style="width:100%;box-sizing:border-box;padding:12px 14px;font-size:16px;border:1px solid #d5dbe3;border-radius:10px;margin-bottom:14px" />
        <label style="display:block;font-size:12px;color:#5b6470;margin-bottom:6px">密码</label>
        <input id="dsh-login-pass" type="password" autocomplete="current-password"
          style="width:100%;box-sizing:border-box;padding:12px 14px;font-size:16px;border:1px solid #d5dbe3;border-radius:10px;margin-bottom:12px" />
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#5b6470;margin-bottom:16px">
          <input id="dsh-login-remember" type="checkbox" checked style="width:16px;height:16px" />
          这台手机记住我 15 天
        </label>
        <div id="dsh-login-error" style="min-height:18px;font-size:13px;color:#b3261e;margin-bottom:10px">${reason}</div>
        <button id="dsh-login-submit" type="submit"
          style="width:100%;padding:13px;font-size:16px;font-weight:600;color:#fff;background:#1f6feb;border:0;border-radius:10px">登录</button>
      </form>`;
    document.body.appendChild(layer);
    const form = layer.querySelector('#dsh-login-form');
    const userInput = layer.querySelector('#dsh-login-user');
    const passInput = layer.querySelector('#dsh-login-pass');
    const remember = layer.querySelector('#dsh-login-remember');
    const errorBox = layer.querySelector('#dsh-login-error');
    const submit = layer.querySelector('#dsh-login-submit');
    if (userInput.value === '') userInput.focus(); else passInput.focus();

    const finish = (ok) => { layer.remove(); resolve(ok); };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = userInput.value.trim();
      const password = passInput.value;
      if (name.length === 0 || password.length === 0) { errorBox.textContent = '用户名和密码都要填'; return; }
      submit.disabled = true;
      submit.textContent = '登录中…';
      errorBox.textContent = '';
      const reply = await relay.login({ user: name, password, remember: remember.checked });
      if (reply.ok === true && typeof reply.token === 'string') {
        saveSession({ token: reply.token, expiresAt: Number(reply.expiresAt) || 0, user: name });
        relay.session = { token: reply.token, expiresAt: Number(reply.expiresAt) || 0, user: name };
        finish(true);
        return;
      }
      submit.disabled = false;
      submit.textContent = '登录';
      passInput.value = '';
      if (reply.reason === 'locked') errorBox.textContent = `失败次数太多，请 ${Math.ceil(Number(reply.retryAfterSec ?? 300) / 60)} 分钟后再试`;
      else if (reply.reason === 'timeout') errorBox.textContent = '电脑端没有回应，检查网络后重试';
      else if (reply.reason === 'disabled') errorBox.textContent = '电脑端没有启用登录口令';
      else errorBox.textContent = '用户名或密码不对';
      passInput.focus();
    });
  });
}


// 电脑端的存活提示条：中继还连着、但电脑已经不吭声时，必须让用户看见，
// 否则手机上会一直显示「实时同步中」，而列表其实是旧的。
function setOfflineBanner(stale, text) {
  let bar = document.getElementById('dsh-remote-offline');
  if (!stale) {
    if (bar !== null) bar.remove();
    return;
  }
  if (bar === null) {
    bar = document.createElement('div');
    bar.id = 'dsh-remote-offline';
    bar.setAttribute('role', 'status');
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:2147483000',
      'padding:10px 14px', 'font:600 13px/1.5 system-ui,-apple-system,"HarmonyOS Sans",sans-serif',
      'color:#fff', 'background:#b3261e', 'text-align:center',
      'box-shadow:0 2px 10px rgba(0,0,0,.28)',
      'padding-top:calc(10px + env(safe-area-inset-top, 0px))',
    ].join(';');
    document.body.appendChild(bar);
  }
  bar.textContent = text ?? '电脑端已离线 · 手机与中转站正常，正在重连电脑…（列表可能不是最新）';
}


function b64(bytes) {
  let text = '';
  const view = new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 1) text += String.fromCharCode(view[index]);
  return btoa(text);
}

function unb64(text) {
  const raw = atob(String(text ?? ''));
  const out = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index);
  return out;
}

function unb64u(text) {
  const raw = String(text ?? '').replace(/-/gu, '+').replace(/_/gu, '/');
  return unb64(raw + '='.repeat((4 - (raw.length % 4)) % 4));
}

function randomId(bytes = 8) {
  const view = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(view, (value) => value.toString(16).padStart(2, '0')).join('');
}

function fail(message, detail) {
  setSplash(message, detail ?? '');
  if (splash !== null) splash.classList.add('is-error');
}

/* ------------------------------- crypto ------------------------------- */

async function makeSealer(keyB64, room) {
  const keyBytes = unb64u(keyB64);
  if (keyBytes.length !== 32) throw new Error('密钥长度不正确');
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return {
    async seal(object, aad) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(JSON.stringify(object));
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, plaintext);
      return JSON.stringify({ v: 1, n: b64(iv), c: b64(new Uint8Array(sealed)) });
    },
    async unseal(text, aad) {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || parsed.v !== 1) throw new Error('信封版本不正确');
      const iv = unb64(parsed.n);
      const blob = unb64(parsed.c);
      if (iv.length !== 12 || blob.length <= 16) throw new Error('信封内容不正确');
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, blob);
      return JSON.parse(decoder.decode(plaintext));
    },
    room,
  };
}

/* ------------------------------ transport ----------------------------- */

class Relay {
  constructor({ room, sealer }) {
    this.room = room;
    this.sealer = sealer;
    this.upTopic = `dshm/${room}/u`;
    this.downTopic = `dshm/${room}/d`;
    this.client = undefined;
    this.ready = false;
    this.pending = new Map();
    this.parts = new Map();
    this.sockets = new Map();
    this.phoneName = '手机';
    this.pcHello = null;
    this.pcSeenAt = 0;
    this.pcStale = false;
    this.staleTimer = undefined;
    this.onpc = () => {};
    this.onstate = () => {};
    this.onpcStale = () => {};
    this.onunauthorized = () => {};
    // 登录令牌：存在本机 localStorage，随每条上行消息带给电脑端。
    this.session = loadSession();
    this.authRequired = false;
    this.authUser = null;
    this.authWaiter = undefined;
    this.loginWaiter = undefined;
    this.stats = { rx: 0, tx: 0, err: 0, lastError: '', lastRxAt: 0 };
  }

  async connect() {
    for (const broker of BROKERS) {
      try {
        await this.connectOne(broker);
        return broker;
      } catch (error) {
        console.warn('[remote] broker failed', broker, error?.message);
      }
    }
    throw new Error('无法连接云端中继，请检查网络');
  }

  connectOne(broker) {
    return new Promise((resolve, reject) => {
      const client = mqtt.connect(broker, {
        clientId: `dshph_${randomId(6)}`,
        clean: true,
        keepalive: 40,
        reconnectPeriod: 3000,
        connectTimeout: 12_000,
        protocolVersion: 4,
      });
      this.client = client;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { client.end(true); } catch { /* ignore */ }
        reject(new Error('连接超时'));
      }, 13_000);

      client.on('connect', () => {
        this.onstate('online');
        client.subscribe(this.downTopic, { qos: 1 }, (error) => {
          if (settled) return;
          if (error) {
            settled = true;
            clearTimeout(timer);
            reject(error);
            return;
          }
          settled = true;
          clearTimeout(timer);
          this.ready = true;
          this.announce();
          resolve(broker);
        });
      });
      client.on('message', (_topic, payload) => { void this.onMessage(payload); });
      client.on('error', (error) => { console.warn('[remote] mqtt error', error?.message); });
      client.on('close', () => {
        this.ready = false;
        this.onstate('offline');
        this.failAll('中继连接中断');
      });
    });
  }

  announce() {
    void this.send({ t: 'hello', name: this.phoneName, ver: 1, ts: Date.now() });
  }

  /**
   * 电脑端每 8 s 发一次 beat。中继本身还连着的时候，MQTT 的 close 事件永远不会触发，
   * 所以「电脑死没死」只能靠 beat 静默来判断。
   */
  startStaleWatch() {
    if (this.staleTimer !== undefined) return;
    this.staleTimer = setInterval(() => {
      if (this.pcSeenAt === 0) return;
      const idle = Date.now() - this.pcSeenAt;
      const stale = idle > PC_STALE_MS;
      if (stale !== this.pcStale) {
        this.pcStale = stale;
        this.onpcStale(stale, stale
          ? `电脑端已离线 ${Math.round(idle / 1000)} 秒 · 正在重连…（列表可能不是最新）`
          : undefined);
      }
    }, 2000);
  }

  async onMessage(payload) {
    let message;
    try {
      message = await this.sealer.unseal(decoder.decode(payload), this.downTopic);
    } catch (error) {
      this.stats.err += 1;
      this.stats.lastError = `unseal: ${error?.message}`;
      return; // wrong key / corrupted frame: ignore
    }
    this.stats.rx += 1;
    this.stats.lastRxAt = Date.now();
    if (message === null || typeof message !== 'object') return;

    if (message.t === 'part') {
      const key = `part:${message.id}`;
      const entry = this.parts.get(key) ?? { chunks: [], total: Number(message.total) || 0 };
      entry.chunks[Number(message.seq) || 0] = unb64(message.d);
      this.parts.set(key, entry);
      if (entry.chunks.filter(Boolean).length < entry.total) return;
      this.parts.delete(key);
      const merged = new Uint8Array(entry.chunks.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of entry.chunks) { merged.set(part, offset); offset += part.length; }
      try { message = JSON.parse(decoder.decode(merged)); } catch { return; }
    }

    switch (message.t) {
      case 'hello':
      case 'beat':
        this.pcHello = { name: message.name, at: Date.now() };
        this.pcSeenAt = Date.now();
        this.onpc(this.pcHello);
        // 心跳本身就是「电脑端在听」的证据：超过 2 s 没回音的请求，趁这一刻重发（电脑端按 id 幂等）。
        for (const [, pending] of this.pending) {
          if (Date.now() - pending.at > 2_000) pending.retry?.();
        }
        break;
      case 'res': {
        const entry = this.pending.get(message.id);
        if (entry === undefined) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        // 令牌过期/被作废：电脑端回 401，这里立刻退回登录页，别让界面继续空转。
        if (Number(message.status) === 401) this.onunauthorized?.();
        entry.resolve(message);
        break;
      }
      case 'auth': {
        this.authRequired = message.required === true;
        this.authUser = typeof message.user === 'string' ? message.user : null;
        if (message.ok === true && Number(message.expiresAt) > 0 && this.session !== null) {
          this.session.expiresAt = Number(message.expiresAt);
          saveSession(this.session);
        }
        this.authWaiter?.({ required: this.authRequired, ok: message.ok === true, user: this.authUser });
        break;
      }
      case 'login': {
        this.loginWaiter?.(message);
        break;
      }
      case 'ws.open': {
        const socket = this.sockets.get(message.id);
        if (socket !== undefined) socket._open();
        break;
      }
      case 'ws.msg': {
        const socket = this.sockets.get(message.id);
        if (socket === undefined) break;
        if (Array.isArray(message.frames)) {
          for (const frame of message.frames) socket._message(frame);
        } else {
          socket._message(message);
        }
        break;
      }
      case 'ws.close':
      case 'ws.error': {
        const socket = this.sockets.get(message.id);
        if (socket !== undefined) socket._close(message.code ?? 1001, message.reason ?? message.message ?? '');
        break;
      }
      default:
        break;
    }
  }

  async send(object) {
    if (this.client === undefined || !this.ready) throw new Error('中继尚未就绪');
    // 令牌随每条上行消息一起走：电脑端逐条校验，重启中继也不会丢登录态。
    const payload = this.session !== null && object.token === undefined ? { ...object, token: this.session.token } : object;
    const sealed = await this.sealer.seal(payload, this.upTopic);
    this.client.publish(this.upTopic, sealed, { qos: 1 });
  }

  /** 问电脑端「这条链路要不要登录、我这个令牌还有效吗」。 */
  checkAuth(timeoutMs = 8_000) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (settled) return; settled = true; this.authWaiter = undefined; resolve(value); };
      this.authWaiter = done;
      this.send({ t: 'auth' }).catch(() => done({ required: false, ok: true }));
      setTimeout(() => done({ required: this.authRequired, ok: !this.authRequired }), timeoutMs);
    });
  }

  /** 交口令换令牌。 */
  login({ user, password, remember = true, timeoutMs = 15_000 }) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (settled) return; settled = true; this.loginWaiter = undefined; resolve(value); };
      this.loginWaiter = done;
      this.send({ t: 'login', user, password, remember, phone: this.phoneName })
        .catch((error) => done({ ok: false, reason: 'send-failed', message: String(error?.message ?? error) }));
      setTimeout(() => done({ ok: false, reason: 'timeout' }), timeoutMs);
    });
  }

  failAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    for (const [, socket] of this.sockets) socket._close(1001, reason);
  }

  /**
   * fetch()-lookalike over the relay with same-id retries. The desktop keeps a
   * short response cache keyed by request id, so a resend after a lost frame
   * replays the answer instead of re-running the request (POST included).
   */
  async request({ method, path, headers, body, gzip, timeout = RPC_TIMEOUT_MS, attempts = RPC_ATTEMPTS }) {
    const id = randomId(8);
    const encoded = body === undefined ? '' : b64(encoder.encode(body));
    return new Promise((resolve, reject) => {
      let attempt = 0;
      let settled = false;
      const entry = { at: Date.now(), timer: undefined, resolve: undefined, reject: undefined };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        fn(value);
      };
      entry.resolve = (message) => finish(resolve, message);
      entry.reject = (error) => finish(reject, error);
      this.pending.set(id, entry);

      // 前几次重发要快：首个请求常常正好撞上电脑端重连，4 s 才重试会把冷启动拖到 20 s+。
      const BACKOFF_MS = [1_200, 2_400, 4_800];
      const attemptOnce = () => {
        attempt += 1;
        this.send({ t: 'req', id, method, path, headers, body: encoded, gzip })
          .catch((error) => entry.reject(error));
        const delay = BACKOFF_MS[attempt - 1] ?? Math.round(timeout / attempts);
        entry.timer = setTimeout(() => {
          if (settled) return;
          if (attempt < attempts) attemptOnce();
          else entry.reject(new Error('中继请求超时'));
        }, delay);
      };
      // 收到 beat 说明下行是通的：把卡住的请求立刻重发一次（电脑端按请求 id 幂等，重发安全）。
      entry.retry = () => { if (!settled && attempt < attempts) attemptOnce(); };
      attemptOnce();
    });
  }
}

/* -------------------------------- shims ------------------------------- */

function installFetch(relay) {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function remoteFetch(input, init = {}) {
    const raw = typeof input === 'string' ? input : input?.url ?? String(input);
    let url;
    try { url = new URL(raw, location.href); } catch { return nativeFetch(input, init); }
    const isRemote = url.origin === REMOTE_ORIGIN;
    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/healthz');
    if (!isRemote && !isApi) return nativeFetch(input, init);

    const headers = {};
    const source = init.headers ?? {};
    if (source instanceof Headers) source.forEach((value, name) => { headers[name] = value; });
    else for (const [name, value] of Object.entries(source)) if (typeof value === 'string') headers[name] = value;

    let body;
    if (typeof init.body === 'string') body = init.body;
    const reply = await relay.request({
      method: String(init.method ?? 'GET').toUpperCase(),
      path: `${url.pathname}${url.search}`,
      headers,
      body,
      gzip: typeof DecompressionStream === 'function',
    });
    let bytes = unb64(reply.body ?? '');
    if (reply.enc === 'gzip' && typeof DecompressionStream === 'function') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const outHeaders = new Headers();
    for (const [name, value] of Object.entries(reply.headers ?? {})) {
      try { outHeaders.set(name, value); } catch { /* skip forbidden headers */ }
    }
    return new Response(bytes, { status: Number(reply.status) || 200, statusText: '', headers: outHeaders });
  };
}

function installWebSocket(relay) {
  class RemoteWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = RemoteWebSocket.CONNECTING;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this.id = randomId(8);
      this.binaryType = 'blob';
      relay.sockets.set(this.id, this);
      const parsed = new URL(this.url, REMOTE_ORIGIN);
      relay.send({ t: 'ws.open', id: this.id, path: `${parsed.pathname}${parsed.search}` }).catch(() => this._close(1006, 'open failed'));
      // 和真 WebSocket 一样，握手不能无限等：电脑侧丢了一帧就该快速失败，让上层重连。
      this.openTimer = setTimeout(() => {
        if (this.readyState === RemoteWebSocket.CONNECTING) this._close(1006, 'open timeout');
      }, 12_000);
    }

    _emit(type, event) {
      const handler = this[`on${type}`];
      if (typeof handler === 'function') { try { handler.call(this, event); } catch (error) { console.error(error); } }
      this.dispatchEvent(event);
    }

    _open() {
      if (this.readyState !== RemoteWebSocket.CONNECTING) return;
      if (this.openTimer !== undefined) { clearTimeout(this.openTimer); this.openTimer = undefined; }
      this.readyState = RemoteWebSocket.OPEN;
      this._emit('open', new Event('open'));
    }

    _message(message) {
      const data = message.bin === true ? unb64(message.data) : String(message.data ?? '');
      this._emit('message', new MessageEvent('message', { data }));
    }

    _close(code = 1000, reason = '') {
      if (this.readyState === RemoteWebSocket.CLOSED) return;
      if (this.openTimer !== undefined) { clearTimeout(this.openTimer); this.openTimer = undefined; }
      this.readyState = RemoteWebSocket.CLOSED;
      relay.sockets.delete(this.id);
      this._emit('close', new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
    }

    send(data) {
      if (this.readyState !== RemoteWebSocket.OPEN) throw new Error('WebSocket 未连接');
      const binary = typeof data !== 'string';
      relay.send({
        t: 'ws.msg',
        id: this.id,
        bin: binary,
        data: binary ? b64(new Uint8Array(data)) : data,
      }).catch((error) => { console.warn('[remote] ws send failed', error?.message); });
    }

    close(code = 1000, reason = '') {
      if (this.readyState >= RemoteWebSocket.CLOSING) return;
      this.readyState = RemoteWebSocket.CLOSING;
      relay.send({ t: 'ws.close', id: this.id }).catch(() => {});
      setTimeout(() => this._close(code, reason), 0);
    }
  }

  RemoteWebSocket.CONNECTING = 0;
  RemoteWebSocket.OPEN = 1;
  RemoteWebSocket.CLOSING = 2;
  RemoteWebSocket.CLOSED = 3;
  window.WebSocket = RemoteWebSocket;
  // The SSE fallback cannot work through the relay; make app.js go straight
  // back to the WebSocket reconnect path instead of failing twice.
  try { Object.defineProperty(window, 'EventSource', { value: undefined, writable: true, configurable: true }); } catch { window.EventSource = undefined; }
}

/* --------------------------------- boot ------------------------------- */

function renderManualEntry(reason) {
  const hash = new URLSearchParams(location.hash.slice(1));
  const prefill = hash.toString();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="remote-manual" id="remote-manual">
      <form id="remote-manual-form">
        <h2>连接你的电脑</h2>
        <p>${reason}</p>
        <input id="remote-manual-input" autocomplete="off" spellcheck="false" placeholder="粘贴电脑上显示的远程链接" value="${prefill.replace(/"/gu, '&quot;')}">
        <button type="submit">连接</button>
        <small>链接在电脑端「配对页 → 远程访问」里，形如 …/#r=…&amp;k=…&amp;t=…</small>
      </form>
    </div>`);
  const form = document.getElementById('remote-manual-form');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = document.getElementById('remote-manual-input')?.value?.trim() ?? '';
    const next = value.includes('#') ? value.slice(value.indexOf('#') + 1) : value.replace(/^#/u, '');
    if (next.length === 0) return;
    location.hash = next;
    location.reload();
  });
  hideSplash();
}

async function main() {
  const params = new URLSearchParams(location.hash.slice(1));
  const direct = params.get('b');
  if (typeof direct === 'string' && direct.length > 0) {
    const target = direct.replace(/\/+$/u, '');
    location.replace(`${target}/app`);
    return;
  }
  const room = params.get('r');
  const key = params.get('k');
  const token = params.get('t');
  const name = params.get('n') ?? 'DSH';

  if (!room || !key || !token) {
    renderManualEntry('这个页面需要电脑端生成的远程链接才能工作。');
    return;
  }

  setSplash('正在连接电脑…', '通过加密中继建立通道');
  let sealer;
  try {
    sealer = await makeSealer(key, room);
  } catch (error) {
    fail('链接密钥无效', String(error?.message ?? error));
    return;
  }

  const relay = new Relay({ room, sealer });

// 页面被关掉 / 切到后台时，尽力把隧道关掉，别让电脑端留着僵尸槽位。
// 手机被强杀时这段不会执行——所以电脑侧还有一层按活动时间的槽位回收。
function releaseChannels() {
  try {
    for (const [, socket] of relay.sockets) relay.send({ t: 'ws.close', id: socket.id }).catch(() => {});
  } catch { /* 已经没了 */ }
}
window.addEventListener('pagehide', releaseChannels);
window.addEventListener('beforeunload', releaseChannels);
  window.__DSH_RELAY__ = relay;
  relay.onpc = (pc) => setSplash(`已连接 ${pc.name}`, '正在同步任务…');
  relay.onstate = (state) => {
    if (state === 'offline') setSplash('中继断开，正在重连…', '网络切换后会自行恢复');
  };
  relay.onpcStale = (stale, text) => setOfflineBanner(stale, text);

  try {
    await relay.connect();
  } catch (error) {
    fail('无法建立中继连接', String(error?.message ?? error));
    return;
  }
  relay.startStaleWatch();

  await new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (relay.pcHello !== null || Date.now() - started > HELLO_TIMEOUT_MS) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
    relay.announce();
  });

  if (relay.pcHello === null) {
    fail('电脑端没有响应', '确认电脑上的 DSH 正在运行，且「远程访问」已开启');
    return;
  }

  // 登录闸门：没有有效令牌就先要口令；令牌 15 天内有效，过期自动再问。
  const authState = await relay.checkAuth();
  if (authState.required && !authState.ok) {
    relay.onunauthorized = () => {
      clearSession();
      relay.session = null;
    };
    hideSplash();
    const passed = await showLogin(relay, {
      user: authState.user ?? '',
      reason: relay.session === null ? '' : '登录已过期，请重新登录',
    });
    if (!passed) { fail('需要登录', '没有登录就无法访问这台电脑'); return; }
  } else if (authState.required) {
    relay.onunauthorized = () => {
      clearSession();
      relay.session = null;
      void showLogin(relay, { user: authState.user ?? '', reason: '登录已过期，请重新登录' })
        .then((ok) => { if (ok) location.reload(); });
    };
  }

  try {
    localStorage.setItem('dsh.bridge.session.v1', JSON.stringify({
      baseUrl: REMOTE_ORIGIN,
      token,
      server: { name },
      remote: { room: room.slice(0, 6) },
      at: Date.now(),
    }));
  } catch (error) {
    fail('浏览器拒绝写入本地存储', '请关闭无痕模式后重试');
    return;
  }

  installFetch(relay);
  installWebSocket(relay);
  hideSplash();
  try {
    await import('./app.js');
  } catch (error) {
    fail('界面加载失败', String(error?.message ?? error));
  }
}

window.__DSH_REMOTE__ = { origin: REMOTE_ORIGIN };
window.__DSH_RELAY__ = null;
void main();
