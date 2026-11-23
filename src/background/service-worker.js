import {
  PROBE_TRACE_HOST,
  PROBE_TRACE_URL,
  collectActiveDomains,
  defaultEnabledServices
} from '../shared/domains.js';
import { maskProxy, parseProxyInput } from '../shared/proxy-parser.js';
import { buildPacScript } from '../shared/pac-builder.js';
import {
  createRoute,
  isRouteBenched,
  isRouteProven,
  rankRoutes,
  recordGeoRefusal,
  recordProbeResult,
  recordProofOk,
  selectActiveRoutes
} from '../shared/route-table.js';

const STORAGE_KEY = 'gemini_access_state_v1';
const ALARM_WARM = 'warm_probe_alarm';
const MAX_LOGS = 40;
const PROBE_TIMEOUT_MS = 7000;

let probeChain = Promise.resolve();
let activeProbeOverride = null;
const authAttempts = new Map();

function defaultState() {
  return {
    enabled: true,
    services: defaultEnabledServices(),
    extraDomains: [],
    routes: [],
    activeRouteId: null,
    proxyConflict: null,
    probing: false,
    logs: []
  };
}

async function loadState() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const saved = raw[STORAGE_KEY];
  if (!saved || typeof saved !== 'object') {
    return defaultState();
  }
  return {
    ...defaultState(),
    ...saved,
    services: { ...defaultEnabledServices(), ...(saved.services || {}) },
    routes: Array.isArray(saved.routes) ? saved.routes : [],
    logs: Array.isArray(saved.logs) ? saved.logs : []
  };
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function appendLog(state, message, level = 'info') {
  const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  const logs = [{ time, level, message }, ...(state.logs || [])].slice(0, MAX_LOGS);
  return { ...state, logs };
}

function parseCloudflareTrace(text) {
  const map = {};
  for (const line of String(text || '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return {
    country: map.loc || null,
    colo: map.colo || null
  };
}

async function checkProxyControl() {
  return new Promise((resolve) => {
    chrome.proxy.settings.get({ incognito: false }, (details) => {
      if (chrome.runtime.lastError) {
        resolve({ controllable: false, reason: chrome.runtime.lastError.message });
        return;
      }
      const level = details?.levelOfControl;
      if (level === 'controlled_by_other_extensions') {
        resolve({
          controllable: false,
          reason: 'Настройки прокси заняты другим расширением браузера.'
        });
        return;
      }
      if (level === 'not_controllable') {
        resolve({
          controllable: false,
          reason: 'Настройки прокси заблокированы политикой браузера.'
        });
        return;
      }
      resolve({ controllable: true, reason: null });
    });
  });
}

async function applyProxySettings(state, probeOverride = activeProbeOverride) {
  const control = await checkProxyControl();
  if (!control.controllable) {
    state.proxyConflict = control.reason;
    await updateBadge(state);
    return state;
  }
  state.proxyConflict = null;

  if (!state.enabled && !probeOverride) {
    await new Promise((resolve) => {
      chrome.proxy.settings.clear({ scope: 'regular' }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
    state.activeRouteId = null;
    await updateBadge(state);
    return state;
  }

  const now = Date.now();
  const activeRoutes = state.enabled
    ? selectActiveRoutes(state.routes, now, state.activeRouteId)
    : [];
  const domains = state.enabled
    ? collectActiveDomains(state.services, state.extraDomains)
    : [];

  state.activeRouteId = activeRoutes[0]?.id || null;

  if (activeRoutes.length === 0 && !probeOverride) {
    await new Promise((resolve) => {
      chrome.proxy.settings.clear({ scope: 'regular' }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
    await updateBadge(state);
    return state;
  }

  const pacScript = buildPacScript({
    domains,
    proxies: activeRoutes.map((r) => r.proxy),
    probeOverride
  });

  const setError = await new Promise((resolve) => {
    chrome.proxy.settings.set(
      {
        value: {
          mode: 'pac_script',
          pacScript: { data: pacScript }
        },
        scope: 'regular'
      },
      () => resolve(chrome.runtime.lastError?.message || null)
    );
  });

  if (setError) {
    state.proxyConflict = `Ошибка применения PAC: ${setError}`;
    state = appendLog(state, state.proxyConflict, 'error');
  }

  await updateBadge(state);
  return state;
}

async function updateBadge(state) {
  if (state.proxyConflict) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    return;
  }
  if (!state.enabled) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  if (state.probing) {
    await chrome.action.setBadgeText({ text: '...' });
    await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
    return;
  }

  const active = state.routes.find((r) => r.id === state.activeRouteId);
  if (!active) {
    await chrome.action.setBadgeText({ text: state.routes.length ? '!' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    return;
  }

  const text = active.exitCountry || 'ON';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({
    color: isRouteProven(active) ? '#16a34a' : '#2563eb'
  });
}

function enqueueProbe(task) {
  probeChain = probeChain.then(task, task);
  return probeChain;
}

async function probeRouteInternal(routeId) {
  let state = await loadState();
  const target = state.routes.find((r) => r.id === routeId);
  if (!target) return state;

  state.probing = true;
  state.routes = state.routes.map((r) =>
    r.id === routeId ? { ...r, status: 'checking', lastError: null } : r
  );
  await saveState(state);
  await updateBadge(state);

  const startedAt = Date.now();
  let probeResult = { ok: false, error: 'Неизвестная ошибка проверки' };

  try {
    activeProbeOverride = { host: PROBE_TRACE_HOST, proxy: target.proxy };
    await applyProxySettings(state, activeProbeOverride);
    // Даём Chromium время применить обновлённый PAC-скрипт
    await new Promise((r) => setTimeout(r, 250));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const resp = await fetch(`${PROBE_TRACE_URL}?t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal
      });
      if (!resp.ok) {
        probeResult = { ok: false, error: `HTTP ${resp.status} при проверке выхода` };
      } else {
        const text = await resp.text();
        const trace = parseCloudflareTrace(text);
        probeResult = {
          ok: true,
          country: trace.country,
          latencyMs: Date.now() - startedAt
        };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    probeResult = {
      ok: false,
      error: isAbort ? 'Таймаут подключения к прокси (7 с)' : 'Прокси не ответил или отклонил соединение'
    };
  } finally {
    activeProbeOverride = null;
  }

  state = await loadState();
  state.probing = false;
  state.routes = state.routes.map((r) =>
    r.id === routeId ? recordProbeResult(r, probeResult) : r
  );

  const updated = state.routes.find((r) => r.id === routeId);
  if (updated) {
    const label = `${updated.name} (${maskProxy(updated.proxy)})`;
    if (updated.status === 'ok') {
      state = appendLog(
        state,
        `Проверка ОК: ${label} — ${updated.exitCountry || '??'}, ${updated.latencyMs} мс`,
        'ok'
      );
    } else if (updated.status === 'blocked_region') {
      state = appendLog(
        state,
        `Заблокированный регион: ${label} выходит в ${updated.exitCountry}`,
        'warn'
      );
    } else {
      state = appendLog(state, `Не ответил: ${label} — ${updated.lastError}`, 'error');
    }
  }

  state = await applyProxySettings(state, null);
  await saveState(state);
  return state;
}

function probeRoute(routeId) {
  return enqueueProbe(() => probeRouteInternal(routeId));
}

async function probeAllRoutes() {
  const state = await loadState();
  for (const route of state.routes) {
    if (route.enabled) {
      await probeRoute(route.id);
    }
  }
  return loadState();
}

// Авторизация HTTP/HTTPS прокси (без сохранения пароля в логах и с защитой от зацикливания)
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy || !details.challenger) {
      callback({});
      return;
    }

    const attempts = (authAttempts.get(details.requestId) || 0) + 1;
    if (attempts > 2) {
      authAttempts.delete(details.requestId);
      callback({ cancel: true });
      return;
    }
    authAttempts.set(details.requestId, attempts);
    setTimeout(() => authAttempts.delete(details.requestId), 30000);

    loadState()
      .then((state) => {
        const host = details.challenger.host.toLowerCase();
        const port = details.challenger.port;
        const match = state.routes.find(
          (r) =>
            r.proxy.host.toLowerCase() === host &&
            r.proxy.port === port &&
            r.proxy.username !== null
        );
        if (match) {
          callback({
            authCredentials: {
              username: match.proxy.username,
              password: match.proxy.password || ''
            }
          });
        } else {
          callback({});
        }
      })
      .catch(() => callback({}));
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

chrome.runtime.onInstalled.addListener(async () => {
  const state = await loadState();
  const next = await applyProxySettings(state);
  await saveState(next);
  chrome.alarms.create(ALARM_WARM, { periodInMinutes: 10 });
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await loadState();
  const next = await applyProxySettings(state);
  await saveState(next);
  chrome.alarms.create(ALARM_WARM, { periodInMinutes: 10 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_WARM) return;
  const state = await loadState();
  if (!state.enabled || state.routes.length === 0) return;

  // Проверяем активный маршрут и маршруты, у которых истекла пауза штрафа
  const now = Date.now();
  const toCheck = state.routes.filter(
    (r) => r.enabled && (r.id === state.activeRouteId || (r.benchedUntil > 0 && !isRouteBenched(r, now)))
  );
  for (const r of toCheck) {
    await probeRoute(r.id);
  }
});

// Обработка сообщений от popup и контент-скрипта
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message || 'Внутренняя ошибка' }));
  return true;
});

function sanitizeStateForUi(state) {
  const ranked = rankRoutes(state.routes, Date.now(), state.activeRouteId);
  return {
    enabled: state.enabled,
    services: state.services,
    activeRouteId: state.activeRouteId,
    proxyConflict: state.proxyConflict,
    probing: state.probing,
    logs: state.logs,
    routes: ranked.map((r) => ({
      id: r.id,
      name: r.name,
      masked: maskProxy(r.proxy),
      scheme: r.proxy.scheme,
      isLocal: r.proxy.isLocal,
      pinned: r.pinned,
      enabled: r.enabled,
      status: r.status,
      exitCountry: r.exitCountry,
      latencyMs: r.latencyMs,
      proven: isRouteProven(r),
      benchedUntil: r.benchedUntil,
      lastError: r.lastError
    }))
  };
}

async function handleMessage(msg) {
  switch (msg?.type) {
    case 'GET_STATE': {
      let state = await loadState();
      const control = await checkProxyControl();
      if (state.proxyConflict !== control.reason) {
        state.proxyConflict = control.reason;
        await saveState(state);
        await updateBadge(state);
      }
      return { ok: true, state: sanitizeStateForUi(state) };
    }

    case 'TOGGLE_ENABLED': {
      let state = await loadState();
      state.enabled = Boolean(msg.enabled);
      state = appendLog(
        state,
        state.enabled ? 'Расширение включено' : 'Расширение выключено (трафик напрямую)'
      );
      state = await applyProxySettings(state);
      await saveState(state);
      return { ok: true, state: sanitizeStateForUi(state) };
    }

    case 'TOGGLE_SERVICE': {
      let state = await loadState();
      if (msg.serviceId in state.services) {
        state.services[msg.serviceId] = Boolean(msg.enabled);
        state = await applyProxySettings(state);
        await saveState(state);
      }
      return { ok: true, state: sanitizeStateForUi(state) };
    }

    case 'ADD_ROUTE': {
      const parsed = parseProxyInput(msg.input);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error };
      }

      let state = await loadState();
      const duplicate = state.routes.find(
        (r) =>
          r.proxy.scheme === parsed.proxy.scheme &&
          r.proxy.host === parsed.proxy.host &&
          r.proxy.port === parsed.proxy.port
      );
      if (duplicate) {
        return { ok: false, error: 'Такой прокси уже есть в списке.' };
      }

      const route = createRoute({
        name: (msg.name || '').trim() || (parsed.proxy.isLocal ? 'Локальный прокси' : 'Свой прокси'),
        proxy: parsed.proxy
      });
      state.routes.push(route);
      state = appendLog(state, `Добавлен маршрут: ${route.name} (${maskProxy(route.proxy)})`);
      state = await applyProxySettings(state);
      await saveState(state);

      // Запускаем проверку выхода асинхронно, чтобы popup сразу обновился
      probeRoute(route.id);

      return { ok: true, warning: parsed.warning, state: sanitizeStateForUi(state) };
    }

    case 'DELETE_ROUTE': {
      let state = await loadState();
      const removed = state.routes.find((r) => r.id === msg.routeId);
      state.routes = state.routes.filter((r) => r.id !== msg.routeId);
      if (removed) {
        state = appendLog(state, `Удалён маршрут: ${removed.name}`);
      }
      state = await applyProxySettings(state);
      await saveState(state);
      return { ok: true, state: sanitizeStateForUi(state) };
    }

    case 'PIN_ROUTE': {
      let state = await loadState();
      state.routes = state.routes.map((r) => ({
        ...r,
        pinned: r.id === msg.routeId ? !r.pinned : false
      }));
      const pinned = state.routes.find((r) => r.pinned);
      state = appendLog(
        state,
        pinned ? `Закреплён маршрут: ${pinned.name}` : 'Закрепление снято — выбор автоматический'
      );
      state = await applyProxySettings(state);
      await saveState(state);
      return { ok: true, state: sanitizeStateForUi(state) };
    }

    case 'PROBE_ROUTE': {
      const next = await probeRoute(msg.routeId);
      return { ok: true, state: sanitizeStateForUi(next) };
    }

    case 'PROBE_ALL': {
      const next = await probeAllRoutes();
      return { ok: true, state: sanitizeStateForUi(next) };
    }

    case 'CLEAR_LOGS': {
      let state = await loadState();
      state.logs = [];
      await saveState(state);
      return { ok: true, state: sanitizeStateForUi(state) };
    }

    case 'PROOF_OK': {
      let state = await loadState();
      if (!state.enabled || !state.activeRouteId) return { ok: true };
      const current = state.routes.find((r) => r.id === state.activeRouteId);
      if (!current) return { ok: true };

      const wasProven = isRouteProven(current);
      state.routes = state.routes.map((r) =>
        r.id === current.id ? recordProofOk(r) : r
      );
      if (!wasProven) {
        state = appendLog(
          state,
          `Подтверждено открытие ${msg.host || 'Gemini'} через «${current.name}»`,
          'ok'
        );
      }
      await saveState(state);
      await updateBadge(state);
      return { ok: true };
    }

    case 'GEO_REFUSAL': {
      let state = await loadState();
      if (!state.enabled || !state.activeRouteId) {
        return { ok: true, switched: false };
      }

      const prevId = state.activeRouteId;
      const prevRoute = state.routes.find((r) => r.id === prevId);
      state.routes = state.routes.map((r) =>
        r.id === prevId ? recordGeoRefusal(r) : r
      );
      state = appendLog(
        state,
        `Геоблок на ${msg.host || 'Gemini'} через «${prevRoute?.name || '?'}» — ищу другой маршрут`,
        'warn'
      );

      state = await applyProxySettings(state);
      await saveState(state);

      const newRoute = state.routes.find((r) => r.id === state.activeRouteId);
      const switched = Boolean(newRoute && newRoute.id !== prevId);
      if (switched) {
        state = appendLog(state, `Переключено на «${newRoute.name}»`, 'info');
        await saveState(state);
      }

      return {
        ok: true,
        switched,
        newRouteName: newRoute?.name || null
      };
    }

    default:
      return { ok: false, error: 'Неизвестная команда' };
  }
}
