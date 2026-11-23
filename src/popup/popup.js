import { SERVICES } from '../shared/domains.js';
import { LOCAL_PRESETS } from '../shared/proxy-parser.js';

const toggleEnabled = document.getElementById('toggle-enabled');
const statusCard = document.getElementById('status-card');
const statusTitle = document.getElementById('status-title');
const statusPills = document.getElementById('status-pills');
const statusDesc = document.getElementById('status-desc');
const servicesList = document.getElementById('services-list');
const routesList = document.getElementById('routes-list');
const addForm = document.getElementById('add-form');
const proxyInput = document.getElementById('proxy-input');
const proxyName = document.getElementById('proxy-name');
const formFeedback = document.getElementById('form-feedback');
const localPresetsEl = document.getElementById('local-presets');
const btnProbeAll = document.getElementById('btn-probe-all');
const btnOpenGemini = document.getElementById('btn-open-gemini');
const btnToggleLogs = document.getElementById('btn-toggle-logs');
const btnClearLogs = document.getElementById('btn-clear-logs');
const logsPanel = document.getElementById('logs-panel');
const logsList = document.getElementById('logs-list');

let currentState = null;

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp || { ok: false, error: 'Нет ответа от фонового сервиса' });
    });
  });
}

function showFeedback(text, kind = 'err') {
  if (!text) {
    formFeedback.className = 'feedback hidden';
    formFeedback.textContent = '';
    return;
  }
  formFeedback.className = `feedback ${kind}`;
  formFeedback.textContent = text;
}

function renderStatus(state) {
  statusCard.className = 'status-card';
  statusPills.textContent = '';

  if (state.proxyConflict) {
    statusCard.classList.add('status-err');
    statusTitle.textContent = 'Конфликт с другим расширением';
    statusDesc.textContent = state.proxyConflict;
    return;
  }

  if (!state.enabled) {
    statusCard.classList.add('status-neutral');
    statusTitle.textContent = 'Выключено';
    statusDesc.textContent = 'Весь трафик браузера идёт напрямую.';
    return;
  }

  if (state.routes.length === 0) {
    statusCard.classList.add('status-warn');
    statusTitle.textContent = 'Нужен хотя бы один прокси';
    statusDesc.textContent = 'Добавьте свой прокси или локальный порт NetZapret / Xray ниже.';
    return;
  }

  const active = state.routes.find((r) => r.id === state.activeRouteId);
  if (state.probing && !active) {
    statusCard.classList.add('status-warn');
    statusTitle.textContent = 'Проверяю маршруты…';
    statusDesc.textContent = 'Определяю страну выхода и задержку.';
    return;
  }

  if (!active) {
    statusCard.classList.add('status-err');
    statusTitle.textContent = 'Нет рабочего маршрута';
    statusDesc.textContent = 'Все маршруты недоступны, в заблокированном регионе или на паузе.';
    return;
  }

  if (active.exitCountry) {
    const p = document.createElement('span');
    p.className = 'status-pill';
    p.textContent = active.exitCountry;
    statusPills.appendChild(p);
  }
  if (active.latencyMs != null) {
    const p = document.createElement('span');
    p.className = 'status-pill';
    p.textContent = `${active.latencyMs} мс`;
    statusPills.appendChild(p);
  }

  if (active.proven) {
    statusCard.classList.add('status-ok');
    statusTitle.textContent = `Работает · ${active.name}`;
    statusDesc.textContent = 'Подтверждено живым открытием Google AI.';
  } else if (active.status === 'ok') {
    statusCard.classList.add('status-ok');
    statusTitle.textContent = `Готов · ${active.name}`;
    statusDesc.textContent = 'Выход проверен. Откройте Gemini для подтверждения.';
  } else {
    statusCard.classList.add('status-warn');
    statusTitle.textContent = state.probing ? 'Проверяю маршрут…' : `Активен · ${active.name}`;
    statusDesc.textContent = 'Домены Google AI уже направлены в этот прокси.';
  }
}

function renderServices(state) {
  servicesList.textContent = '';
  for (const service of SERVICES) {
    const active = Boolean(state.services?.[service.id]);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip ${active ? 'active' : ''}`;
    btn.textContent = service.name;
    btn.addEventListener('click', async () => {
      const resp = await send({
        type: 'TOGGLE_SERVICE',
        serviceId: service.id,
        enabled: !active
      });
      if (resp.ok && resp.state) render(resp.state);
    });
    servicesList.appendChild(btn);
  }
}

function formatBenchRemaining(benchedUntil) {
  const sec = Math.max(1, Math.ceil((benchedUntil - Date.now()) / 1000));
  if (sec >= 3600) return `${Math.ceil(sec / 3600)} ч`;
  if (sec >= 60) return `${Math.ceil(sec / 60)} мин`;
  return `${sec} с`;
}

function renderRoutes(state) {
  routesList.textContent = '';

  if (state.routes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = 'Список маршрутов пуст. Добавьте HTTP, HTTPS или SOCKS5 прокси.';
    routesList.appendChild(empty);
    return;
  }

  for (const route of state.routes) {
    const isActive = state.enabled && route.id === state.activeRouteId;
    const card = document.createElement('div');
    card.className = `route-card ${isActive ? 'is-active' : ''}`;

    const main = document.createElement('div');
    main.className = 'route-main';

    const top = document.createElement('div');
    top.className = 'route-top';

    const name = document.createElement('span');
    name.className = 'route-name';
    name.textContent = route.name;
    top.appendChild(name);

    if (isActive) {
      top.appendChild(makeBadge('Активен', 'badge-active'));
    }
    if (route.proven) {
      top.appendChild(makeBadge('Подтверждён', 'badge-ok'));
    } else if (route.status === 'checking') {
      top.appendChild(makeBadge('Проверка…', 'badge-warn'));
    } else if (route.status === 'blocked_region') {
      top.appendChild(makeBadge(`Регион ${route.exitCountry || 'RU'}`, 'badge-err'));
    } else if (route.benchedUntil > Date.now()) {
      top.appendChild(makeBadge(`Пауза ${formatBenchRemaining(route.benchedUntil)}`, 'badge-warn'));
    } else if (route.status === 'dead') {
      top.appendChild(makeBadge('Не ответил', 'badge-err'));
    }

    const addr = document.createElement('div');
    addr.className = 'route-addr';
    addr.textContent = route.masked;

    const meta = document.createElement('div');
    meta.className = 'route-meta';
    const metaParts = [];
    if (route.exitCountry) metaParts.push(`Выход: ${route.exitCountry}`);
    if (route.latencyMs != null) metaParts.push(`${route.latencyMs} мс`);
    if (route.lastError) metaParts.push(route.lastError);
    meta.textContent = metaParts.join(' · ') || 'Ещё не проверялся';

    main.append(top, addr, meta);

    const actions = document.createElement('div');
    actions.className = 'route-actions';

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = `icon-btn ${route.pinned ? 'pinned' : ''}`;
    pinBtn.title = route.pinned ? 'Снять закрепление' : 'Закрепить основным';
    pinBtn.textContent = '★';
    pinBtn.addEventListener('click', async () => {
      const resp = await send({ type: 'PIN_ROUTE', routeId: route.id });
      if (resp.ok && resp.state) render(resp.state);
    });

    const probeBtn = document.createElement('button');
    probeBtn.type = 'button';
    probeBtn.className = 'icon-btn';
    probeBtn.title = 'Проверить маршрут';
    probeBtn.textContent = '↻';
    probeBtn.addEventListener('click', async () => {
      probeBtn.disabled = true;
      const resp = await send({ type: 'PROBE_ROUTE', routeId: route.id });
      probeBtn.disabled = false;
      if (resp.ok && resp.state) render(resp.state);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn';
    delBtn.title = 'Удалить маршрут';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', async () => {
      const resp = await send({ type: 'DELETE_ROUTE', routeId: route.id });
      if (resp.ok && resp.state) render(resp.state);
    });

    actions.append(pinBtn, probeBtn, delBtn);
    card.append(main, actions);
    routesList.appendChild(card);
  }
}

function makeBadge(text, cls) {
  const el = document.createElement('span');
  el.className = `badge ${cls}`;
  el.textContent = text;
  return el;
}

function renderLogs(state) {
  logsList.textContent = '';
  if (!state.logs?.length) {
    const empty = document.createElement('div');
    empty.className = 'log-row';
    empty.textContent = 'Записей пока нет.';
    logsList.appendChild(empty);
    return;
  }
  for (const row of state.logs) {
    const div = document.createElement('div');
    div.className = `log-row ${row.level || 'info'}`;
    div.textContent = `[${row.time}] ${row.message}`;
    logsList.appendChild(div);
  }
}

function render(state) {
  currentState = state;
  toggleEnabled.checked = Boolean(state.enabled);
  renderStatus(state);
  renderServices(state);
  renderRoutes(state);
  renderLogs(state);
}

function initLocalPresets() {
  localPresetsEl.textContent = '';
  for (const preset of LOCAL_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn';
    btn.textContent = `${preset.label} — ${preset.value}`;
    btn.addEventListener('click', async () => {
      showFeedback('');
      const resp = await send({
        type: 'ADD_ROUTE',
        input: preset.value,
        name: preset.label.split(' (')[0]
      });
      if (!resp.ok) {
        showFeedback(resp.error, 'err');
        return;
      }
      if (resp.warning) showFeedback(resp.warning, 'warn');
      if (resp.state) render(resp.state);
    });
    localPresetsEl.appendChild(btn);
  }
}

toggleEnabled.addEventListener('change', async () => {
  const resp = await send({ type: 'TOGGLE_ENABLED', enabled: toggleEnabled.checked });
  if (resp.ok && resp.state) render(resp.state);
});

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showFeedback('');
  const resp = await send({
    type: 'ADD_ROUTE',
    input: proxyInput.value,
    name: proxyName.value
  });
  if (!resp.ok) {
    showFeedback(resp.error, 'err');
    return;
  }
  proxyInput.value = '';
  proxyName.value = '';
  if (resp.warning) {
    showFeedback(resp.warning, 'warn');
  }
  if (resp.state) render(resp.state);
});

btnProbeAll.addEventListener('click', async () => {
  btnProbeAll.disabled = true;
  const resp = await send({ type: 'PROBE_ALL' });
  btnProbeAll.disabled = false;
  if (resp.ok && resp.state) render(resp.state);
});

btnOpenGemini.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://gemini.google.com/app' });
});

btnToggleLogs.addEventListener('click', () => {
  logsPanel.classList.toggle('hidden');
});

btnClearLogs.addEventListener('click', async () => {
  const resp = await send({ type: 'CLEAR_LOGS' });
  if (resp.ok && resp.state) render(resp.state);
});

chrome.storage.onChanged.addListener(async () => {
  const resp = await send({ type: 'GET_STATE' });
  if (resp.ok && resp.state) render(resp.state);
});

initLocalPresets();
send({ type: 'GET_STATE' }).then((resp) => {
  if (resp.ok && resp.state) render(resp.state);
});
