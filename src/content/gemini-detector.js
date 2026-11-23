// Детектор результата открытия Gemini / AI Studio / NotebookLM / Google Labs.
// По мотивам ls_log из confeden/Antigravity: таблица маршрутов получает
// реальное подтверждение работы или сигнал о региональном отказе.

(function () {
  const REFUSAL_URL_PATTERNS = [
    /\/unavailable/i,
    /not-available/i,
    /region-not-supported/i,
    /unsupported-country/i,
    /unsupported/i
  ];

  const REFUSAL_TEXT_PATTERNS = [
    /gemini isn['’]t currently supported in your country/i,
    /gemini is not available in your country/i,
    /not available in your country/i,
    /user location is not supported/i,
    /isn['’]t available in your region/i,
    /gemini пока недоступен в вашей стране/i,
    /недоступен в вашей стране/i,
    /недоступен в вашем регионе/i,
    /не поддерживается в вашей стране/i,
    /не поддерживается в вашем регионе/i
  ];

  const RELOAD_GUARD_KEY = 'gemini_access_auto_reloaded_at';
  let reported = null; // 'ok' | 'refusal'

  function detectGeoRefusal() {
    const href = location.href;
    if (REFUSAL_URL_PATTERNS.some((re) => re.test(href))) {
      return true;
    }
    const text = (document.body?.innerText || '').slice(0, 4000);
    return REFUSAL_TEXT_PATTERNS.some((re) => re.test(text));
  }

  function detectWorkingUi() {
    const host = location.hostname;
    if (host.includes('gemini.google.com')) {
      return Boolean(
        document.querySelector(
          'rich-textarea, [contenteditable="true"][role="textbox"], chat-window, input-area-v2, .ql-editor'
        )
      );
    }
    if (host.includes('aistudio.google.com')) {
      return Boolean(
        document.querySelector('ms-prompt-input, textarea, ms-app, .prompt-input-wrapper')
      );
    }
    if (host.includes('notebooklm.google')) {
      return Boolean(
        document.querySelector('mat-sidenav-container, notebook-list, [role="main"]')
      );
    }
    return Boolean(document.querySelector('main') && (document.body?.innerText || '').trim().length > 80);
  }

  function showSwitchBanner(routeName) {
    if (document.getElementById('gemini-access-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'gemini-access-banner';
    bar.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'right:16px',
      'z-index:2147483647',
      'background:#111827',
      'color:#f9fafb',
      'border:1px solid #374151',
      'border-radius:10px',
      'padding:12px 14px',
      'font:13px/1.4 system-ui,-apple-system,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)',
      'display:flex',
      'align-items:center',
      'gap:10px'
    ].join(';');

    const text = document.createElement('span');
    text.textContent = `NZ Chrome: маршрут переключён на «${routeName}».`;

    const btn = document.createElement('button');
    btn.textContent = 'Обновить';
    btn.style.cssText =
      'background:#2563eb;color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-weight:600;';
    btn.onclick = () => location.reload();

    const close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText =
      'background:transparent;color:#9ca3af;border:none;font-size:16px;cursor:pointer;padding:0 4px;';
    close.onclick = () => bar.remove();

    bar.append(text, btn, close);
    document.body?.appendChild(bar);
  }

  function showSorryMismatchBanner() {
    if (document.getElementById('gemini-access-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'gemini-access-banner';
    bar.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'right:16px',
      'z-index:2147483647',
      'background:#111827',
      'color:#f9fafb',
      'border:1px solid #374151',
      'border-radius:10px',
      'padding:12px 14px',
      'font:13px/1.4 system-ui,-apple-system,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'max-width:460px'
    ].join(';');

    const text = document.createElement('span');
    text.textContent =
      'NZ Chrome: google.com идёт напрямую (разные IP на проверке). Включить прокси для google.com?';

    const btn = document.createElement('button');
    btn.textContent = 'Включить и обновить';
    btn.style.cssText =
      'background:#2563eb;color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-weight:600;white-space:nowrap;';
    btn.onclick = () => {
      btn.disabled = true;
      chrome.runtime.sendMessage(
        { type: 'TOGGLE_SERVICE', serviceId: 'google_sorry', enabled: true },
        () => {
          void chrome.runtime.lastError;
          setTimeout(() => location.reload(), 300);
        }
      );
    };

    const close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText =
      'background:transparent;color:#9ca3af;border:none;font-size:16px;cursor:pointer;padding:0 4px;';
    close.onclick = () => bar.remove();

    bar.append(text, btn, close);
    document.body?.appendChild(bar);
  }

  function evaluate() {
    if (reported) return;

    // Страница антибот-проверки Google: если IP не совпадают из-за того, что google.com идёт напрямую
    if (
      (location.hostname === 'www.google.com' || location.hostname === 'google.com') &&
      location.pathname.startsWith('/sorry')
    ) {
      const text = document.body?.innerText || '';
      const isForAi = /gemini\.google\.com|aistudio\.google\.com|notebooklm\.google|labs\.google/i.test(
        location.search + ' ' + text
      );
      if (isForAi && text.includes('≠')) {
        reported = 'sorry_mismatch';
        showSorryMismatchBanner();
      }
      return;
    }

    if (detectGeoRefusal()) {
      reported = 'refusal';
      chrome.runtime.sendMessage(
        { type: 'GEO_REFUSAL', host: location.hostname, url: location.href },
        (resp) => {
          if (chrome.runtime.lastError || !resp?.switched) return;
          const lastReload = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
          // Автоперезагрузка не чаще раза в 30 секунд, чтобы не зациклиться
          if (Date.now() - lastReload > 30000) {
            sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
            location.reload();
          } else {
            showSwitchBanner(resp.newRouteName || 'запасной');
          }
        }
      );
      return;
    }

    if (detectWorkingUi()) {
      reported = 'ok';
      chrome.runtime.sendMessage({ type: 'PROOF_OK', host: location.hostname }, () => {
        void chrome.runtime.lastError;
      });
    }
  }

  // SPA-приложения Google рендерятся асинхронно — проверяем пару раз после загрузки
  setTimeout(evaluate, 1500);
  setTimeout(evaluate, 4000);

  const observer = new MutationObserver(() => {
    if (reported) {
      observer.disconnect();
      return;
    }
    evaluate();
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }
})();
