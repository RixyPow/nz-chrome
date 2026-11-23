// Всеядный парсер прокси-строк (идея из upstream.rs confeden/Antigravity):
// принимает host:port, user:pass@host:port, http://, https://, socks5://, socks4://.
// Пароль маскируется при любом выводе в интерфейс и журнал.

export const SUPPORTED_SCHEMES = new Set(['http', 'https', 'socks5', 'socks4']);

export const LOCAL_PRESETS = [
  { label: 'NetZapret / sing-box (HTTP 2080)', value: 'http://127.0.0.1:2080' },
  { label: 'NetZapret / sing-box (SOCKS5 2080)', value: 'socks5://127.0.0.1:2080' },
  { label: 'Xray / v2rayN (HTTP 10809)', value: 'http://127.0.0.1:10809' },
  { label: 'Xray / v2rayN (SOCKS5 10808)', value: 'socks5://127.0.0.1:10808' },
  { label: 'Clash / Mihomo (HTTP 7890)', value: 'http://127.0.0.1:7890' }
];

function isValidHost(host) {
  if (!host || host.length > 253) return false;
  // IPv6 в квадратных скобках поддерживается отдельно, здесь — имя или IPv4
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1);
    return /^[0-9a-fA-F:]+$/.test(inner) && inner.includes(':');
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) return false;
  if (host.startsWith('.') || host.endsWith('.') || host.startsWith('-') || host.endsWith('-')) {
    return false;
  }
  return host === 'localhost' || host.includes('.');
}

export function isLocalHost(host) {
  const h = (host || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
}

/**
 * Разбирает строку прокси. Возвращает { ok: true, proxy, warning? } или { ok: false, error }.
 */
export function parseProxyInput(input) {
  if (typeof input !== 'string') {
    return { ok: false, error: 'Пустая строка прокси.' };
  }
  const raw = input.trim();
  if (!raw) {
    return { ok: false, error: 'Введите адрес прокси, например host:port или socks5://127.0.0.1:2080.' };
  }

  let scheme = 'http';
  let rest = raw;

  const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = schemeMatch[2];
    if (scheme === 'socks' || scheme === 'socks5h') {
      scheme = 'socks5';
    }
    if (!SUPPORTED_SCHEMES.has(scheme)) {
      return {
        ok: false,
        error: `Протокол «${scheme}» не поддерживается. Нужен http://, https://, socks5:// или socks4://.`
      };
    }
  }

  // Убираем хвостовой слэш, если скопировали из браузера/конфига
  rest = rest.replace(/\/+$/, '');
  if (rest.includes('/') || /\s/.test(rest)) {
    return { ok: false, error: 'Адрес прокси не должен содержать пробелы или путь после порта.' };
  }

  // Отделяем логин:пароль, если есть (берём последний @ на случай @ в пароле)
  let username = null;
  let password = null;
  let hostPort = rest;
  const atIdx = rest.lastIndexOf('@');
  if (atIdx !== -1) {
    const creds = rest.slice(0, atIdx);
    hostPort = rest.slice(atIdx + 1);
    const colonIdx = creds.indexOf(':');
    if (colonIdx === -1) {
      username = decodeSafe(creds);
      password = '';
    } else {
      username = decodeSafe(creds.slice(0, colonIdx));
      password = decodeSafe(creds.slice(colonIdx + 1));
    }
    if (!username) {
      return { ok: false, error: 'Указан «@», но логин прокси пустой.' };
    }
  }

  // Отделяем host и port (учитывая IPv6 [::1]:port)
  let host = '';
  let portStr = '';
  if (hostPort.startsWith('[')) {
    const closeBracket = hostPort.indexOf(']');
    if (closeBracket === -1 || hostPort[closeBracket + 1] !== ':') {
      return { ok: false, error: 'Для IPv6 укажите порт: [::1]:2080.' };
    }
    host = hostPort.slice(0, closeBracket + 1).toLowerCase();
    portStr = hostPort.slice(closeBracket + 2);
  } else {
    const lastColon = hostPort.lastIndexOf(':');
    if (lastColon === -1) {
      return { ok: false, error: 'Не указан порт прокси (нужно host:port).' };
    }
    host = hostPort.slice(0, lastColon).toLowerCase();
    portStr = hostPort.slice(lastColon + 1);
  }

  if (!isValidHost(host)) {
    return { ok: false, error: `Некорректный адрес сервера: «${host}».` };
  }

  if (!/^\d+$/.test(portStr)) {
    return { ok: false, error: `Некорректный порт: «${portStr}».` };
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'Порт должен быть в диапазоне от 1 до 65535.' };
  }

  let warning = null;
  if ((scheme === 'socks5' || scheme === 'socks4') && username !== null) {
    warning = 'Браузеры Chromium не передают логин и пароль для SOCKS-прокси. Используйте HTTP/HTTPS прокси или локальный прокси без пароля.';
  }

  return {
    ok: true,
    warning,
    proxy: {
      scheme,
      host,
      port,
      username,
      password,
      isLocal: isLocalHost(host)
    }
  };
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Безопасное отображение прокси без пароля (для UI и журнала).
 */
export function maskProxy(proxy) {
  if (!proxy) return '';
  const auth = proxy.username ? `${proxy.username}:***@` : '';
  return `${proxy.scheme}://${auth}${proxy.host}:${proxy.port}`;
}

/**
 * Преобразует объект прокси в директиву PAC-скрипта.
 */
export function toPacDirective(proxy) {
  const hostPort = `${proxy.host}:${proxy.port}`;
  switch (proxy.scheme) {
    case 'https':
      return `HTTPS ${hostPort}`;
    case 'socks5':
      return `SOCKS5 ${hostPort}`;
    case 'socks4':
      return `SOCKS ${hostPort}`;
    case 'http':
    default:
      return `PROXY ${hostPort}`;
  }
}
