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
const updateBanner = document.getElementById('update-banner');
const updateTitle = document.getElementById('update-title');
const btnUpdateDownload = document.getElementById('btn-update-download');
const btnUpdateNotes = document.getElementById('btn-update-notes');
const versionLabel = document.getElementById('version-label');
const btnCheckUpdate = document.getElementById('btn-check-update');

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
    statusDesc.textContent = 'Подтверждено живым открытием сервиса ИИ.';
  } else if (active.status === 'refused') {
    statusCard.classList.add('status-warn');
    statusTitle.textContent = `Отказ по региону · ${active.name}`;
    statusDesc.textContent = 'Прокси остаётся включённым. Смените сервер VPN или добавьте другой маршрут.';
  } else if (active.status === 'ok') {
    statusCard.classList.add('status-ok');
    statusTitle.textContent = `Готов · ${active.name}`;
    statusDesc.textContent = 'Выход проверен. Откройте Gemini, Claude или ChatGPT.';
  } else {
    statusCard.classList.add('status-warn');
    statusTitle.textContent = state.probing ? 'Проверяю маршрут…' : `Активен · ${active.name}`;
    statusDesc.textContent = 'Домены выбранных сервисов уже направлены в этот прокси.';
  }
}

const SERVICE_ICONS = {
  gemini:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c.6 5.2 4.8 9.4 10 10-5.2.6-9.4 4.8-10 10-.6-5.2-4.8-9.4-10-10C7.2 11.4 11.4 7.2 12 2Z"/></svg>',
  claude:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/><line x1="18.4" y1="5.6" x2="5.6" y2="18.4"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>',
  chatgpt:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.2a4.3 4.3 0 0 1 3.9 2.5 4.3 4.3 0 0 1 4.2 5.4 4.3 4.3 0 0 1-1.9 6.5 4.3 4.3 0 0 1-6.2 3.2 4.3 4.3 0 0 1-6.2-3.2 4.3 4.3 0 0 1-1.9-6.5 4.3 4.3 0 0 1 4.2-5.4A4.3 4.3 0 0 1 12 3.2Z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  aistudio:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="8 7 3 12 8 17"/><polyline points="16 7 21 12 16 17"/><line x1="13.5" y1="5" x2="10.5" y2="19"/></svg>',
  notebooklm:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3.5" width="16" height="17" rx="2.5"/><line x1="8" y1="8.5" x2="16" y2="8.5"/><line x1="8" y1="12.5" x2="16" y2="12.5"/><line x1="8" y1="16.5" x2="12.5" y2="16.5"/></svg>',
  labs:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6"/><path d="M10 3v5.5L5.2 18a2 2 0 0 0 1.8 2.9h10a2 2 0 0 0 1.8-2.9L14 8.5V3"/><line x1="7.5" y1="15" x2="16.5" y2="15"/></svg>',
  google_sorry:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v6c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3Z"/><polyline points="9 12.2 11.2 14.4 15.4 10"/></svg>'
};

function renderServices(state) {
  servicesList.textContent = '';
  SERVICES.forEach((service, idx) => {
    const active = Boolean(state.services?.[service.id]);
    const isLastOdd = SERVICES.length % 2 === 1 && idx === SERVICES.length - 1;

    const item = document.createElement('label');
    item.className = `service-item ${active ? 'active' : ''} ${isLastOdd ? 'span-full' : ''}`;

    const left = document.createElement('span');
    left.className = 'service-left';

    const icon = document.createElement('span');
    icon.className = `service-icon icon-${service.id}`;
    icon.innerHTML = SERVICE_ICONS[service.id] || '';

    const name = document.createElement('span');
    name.className = 'service-name';
    name.textContent = service.name;

    left.append(icon, name);

    const sw = document.createElement('span');
    sw.className = 'mini-switch';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = active;
    input.addEventListener('change', async () => {
      const resp = await send({
        type: 'TOGGLE_SERVICE',
        serviceId: service.id,
        enabled: input.checked
      });
      if (resp.ok && resp.state) render(resp.state);
    });

    const slider = document.createElement('span');
    slider.className = 'mini-slider';

    sw.append(input, slider);
    item.append(left, sw);
    servicesList.appendChild(item);
  });
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
    } else if (route.status === 'refused') {
      top.appendChild(makeBadge('Отказ по региону', 'badge-warn'));
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

function renderUpdate(state) {
  const info = state.updateInfo || {};
  const current = info.currentVersion || '0.1.0';

  if (info.checking) {
    versionLabel.textContent = `v${current} · проверяю…`;
    btnCheckUpdate.disabled = true;
  } else if (info.available) {
    versionLabel.textContent = `v${current} → v${info.latestVersion}`;
    btnCheckUpdate.disabled = false;
  } else if (info.error) {
    versionLabel.textContent = `v${current} · ${info.error}`;
    btnCheckUpdate.disabled = false;
  } else if (info.checkedAt) {
    versionLabel.textContent = `v${current} · актуально`;
    btnCheckUpdate.disabled = false;
  } else {
    versionLabel.textContent = `v${current}`;
    btnCheckUpdate.disabled = false;
  }

  if (info.available) {
    updateBanner.classList.remove('hidden');
    updateTitle.textContent = `Доступна NZ Chrome ${info.latestVersion}`;
    btnUpdateDownload.onclick = () => {
      chrome.tabs.create({ url: info.downloadUrl || info.releaseUrl });
    };
    btnUpdateNotes.onclick = () => {
      chrome.tabs.create({ url: info.releaseUrl });
    };
  } else {
    updateBanner.classList.add('hidden');
  }
}

function render(state) {
  currentState = state;
  toggleEnabled.checked = Boolean(state.enabled);
  renderUpdate(state);
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

btnCheckUpdate.addEventListener('click', async () => {
  btnCheckUpdate.disabled = true;
  versionLabel.textContent = `v${currentState?.updateInfo?.currentVersion || '0.1.0'} · проверяю…`;
  const resp = await send({ type: 'CHECK_UPDATE' });
  btnCheckUpdate.disabled = false;
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
