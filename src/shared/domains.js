// Сервисы ИИ и их домены.
// Вход в Google (accounts.google.com) и статика (gstatic/googleusercontent)
// намеренно НЕ включены, чтобы не ломать вход и не гонять лишний трафик через прокси.

export const SERVICES = [
  {
    id: 'gemini',
    name: 'Gemini',
    defaultEnabled: true,
    homeUrl: 'https://gemini.google.com/app',
    domains: [
      'gemini.google.com',
      'bard.google.com',
      'generativelanguage.googleapis.com',
      'alkalimakersuite-pa.clients6.google.com',
      'waa-pa.clients6.google.com',
      'proactivebackend-pa.googleapis.com',
      'content-push.googleapis.com',
      'geller-pa.googleapis.com'
    ]
  },
  {
    id: 'claude',
    name: 'Claude',
    defaultEnabled: true,
    homeUrl: 'https://claude.ai/',
    domains: [
      'claude.ai',
      'claude.com',
      'anthropic.com',
      'claudeusercontent.com'
    ]
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    defaultEnabled: true,
    homeUrl: 'https://chatgpt.com/',
    domains: [
      'chatgpt.com',
      'openai.com',
      'oaistatic.com',
      'oaiusercontent.com',
      'sora.com'
    ]
  },
  {
    id: 'aistudio',
    name: 'AI Studio',
    defaultEnabled: true,
    homeUrl: 'https://aistudio.google.com/',
    domains: [
      'aistudio.google.com',
      'makersuite.google.com',
      'generativelanguage.googleapis.com',
      'alkalimakersuite-pa.clients6.google.com',
      'ai.google.dev'
    ]
  },
  {
    id: 'notebooklm',
    name: 'NotebookLM',
    defaultEnabled: true,
    homeUrl: 'https://notebooklm.google.com/',
    domains: [
      'notebooklm.google.com',
      'notebooklm.google',
      'tailwind-pa.googleapis.com'
    ]
  },
  {
    id: 'labs',
    name: 'Google Labs',
    defaultEnabled: false,
    homeUrl: 'https://labs.google/',
    domains: [
      'labs.google',
      'labs.google.com',
      'aisandbox-pa.googleapis.com',
      'jules.google.com',
      'opal.withgoogle.com',
      'deepmind.google'
    ]
  },
  {
    id: 'google_sorry',
    name: 'Google (капча)',
    defaultEnabled: false,
    homeUrl: 'https://www.google.com/',
    // Префикс "=" означает строгое совпадение хоста (без поддоменов вроде accounts/mail/drive.google.com)
    domains: [
      '=google.com',
      '=www.google.com',
      '=ipv4.google.com',
      '=ipv6.google.com'
    ]
  }
];

// Страны, из которых сервисы ИИ стабильно отказывают в доступе (код ISO-3166 alpha-2).
export const BLOCKED_COUNTRIES = new Set([
  'RU', 'BY', 'CN', 'HK', 'MO', 'IR', 'KP', 'CU', 'SY'
]);

// Служебный домен для проверки выхода кандидата-прокси без затрагивания вкладок пользователя.
// Сырые IP (вроде 1.0.0.1) часть прокси/туннелей не маршрутизирует, поэтому используем доменное имя.
export const PROBE_TRACE_HOST = 'cp.cloudflare.com';
export const PROBE_TRACE_URL = `https://${PROBE_TRACE_HOST}/cdn-cgi/trace`;

export function defaultEnabledServices() {
  const map = {};
  for (const s of SERVICES) {
    map[s.id] = s.defaultEnabled;
  }
  return map;
}

export function collectActiveDomains(enabledServices, extraDomains = []) {
  const set = new Set();
  for (const service of SERVICES) {
    if (enabledServices?.[service.id]) {
      for (const d of service.domains) {
        set.add(d.toLowerCase());
      }
    }
  }
  for (const raw of extraDomains || []) {
    const clean = normalizeDomain(raw);
    if (clean) set.add(clean);
  }
  return Array.from(set).sort();
}

export function normalizeDomain(raw) {
  if (typeof raw !== 'string') return null;
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '').replace(/^\.+|\.+$/g, '');
  if (!d || d.length > 253 || !d.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(d)) return null;
  return d;
}

export function isBlockedCountry(code) {
  if (!code || typeof code !== 'string') return false;
  return BLOCKED_COUNTRIES.has(code.trim().toUpperCase());
}
