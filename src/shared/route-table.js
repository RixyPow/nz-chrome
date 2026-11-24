// Таблица маршрутов по мотивам routes.rs из confeden/Antigravity:
// 1. «Доказательство важнее скорости»: маршрут, на котором Gemini реально открылся
//    без регионального отказа, стоит выше просто быстрого маршрута.
// 2. Защита свежего доказательства (90 сек): случайная ошибка сразу после успешного
//    открытия не отправляет живой маршрут на скамейку запасных.
// 3. Нарастающий штраф (bench): 2 мин -> 10 мин -> 1 час -> 6 часов.
// 4. Заблокированный регион выхода (RU/BY/CN/...) отключает маршрут до смены выхода.

import { isBlockedCountry } from './domains.js';

export const PENALTY_STEPS_MS = [
  2 * 60 * 1000,
  10 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000
];

export const DEAD_PENALTY_MS = 2 * 60 * 1000;
export const PROOF_TTL_MS = 12 * 60 * 60 * 1000;
export const PROOF_PROTECTS_MS = 90 * 1000;
export const SAMPLE_TTL_MS = 15 * 60 * 1000;
export const SWITCH_MARGIN_PCT = 20;

export function createRoute({ id, name, proxy, pinned = false }) {
  return {
    id: id || `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: name || (proxy.isLocal ? 'Локальный прокси' : 'Свой прокси'),
    proxy,
    pinned,
    enabled: true,
    status: 'unknown', // unknown | checking | ok | blocked_region | refused | dead
    exitCountry: null,
    latencyMs: null,
    measuredAt: 0,
    provenAt: 0,
    benchedUntil: 0,
    penaltyStep: 0,
    lastError: null,
    addedAt: Date.now()
  };
}

export function isRouteBenched(route, now = Date.now()) {
  return (route.benchedUntil || 0) > now;
}

export function isRouteProven(route, now = Date.now()) {
  return (route.provenAt || 0) > 0 && now - route.provenAt < PROOF_TTL_MS;
}

export function isRouteUsable(route, now = Date.now()) {
  if (!route.enabled) return false;
  if (route.status === 'blocked_region') return false;
  if (isRouteBenched(route, now)) return false;
  return true;
}

/**
 * Записывает результат проверки выхода (страна + задержка).
 */
export function recordProbeResult(route, result, now = Date.now()) {
  if (!result.ok) {
    return {
      ...route,
      status: 'dead',
      lastError: result.error || 'Прокси не ответил',
      benchedUntil: now + DEAD_PENALTY_MS,
      measuredAt: now
    };
  }

  const country = result.country ? result.country.toUpperCase() : null;
  if (country && isBlockedCountry(country)) {
    return {
      ...route,
      status: 'blocked_region',
      exitCountry: country,
      latencyMs: result.latencyMs ?? null,
      measuredAt: now,
      provenAt: 0,
      lastError: `Выход в заблокированном регионе (${country})`
    };
  }

  return {
    ...route,
    status: 'ok',
    exitCountry: country,
    latencyMs: result.latencyMs ?? null,
    measuredAt: now,
    benchedUntil: 0,
    lastError: null
  };
}

/**
 * Фиксирует реальное успешное открытие Gemini через этот маршрут.
 */
export function recordProofOk(route, now = Date.now()) {
  return {
    ...route,
    status: 'ok',
    provenAt: now,
    benchedUntil: 0,
    penaltyStep: 0,
    lastError: null
  };
}

/**
 * Фиксирует региональный отказ Gemini/Claude/ChatGPT на маршруте.
 * Если маршрут только что подтвердился (< 90 с назад), штраф не накладывается.
 * Если запасного маршрута нет (hasFallback = false), пауза не ставится,
 * чтобы PAC не сбрасывался на прямой российский IP.
 */
export function recordGeoRefusal(route, now = Date.now(), { hasFallback = true } = {}) {
  if (route.provenAt && now - route.provenAt < PROOF_PROTECTS_MS) {
    return {
      ...route,
      lastError: 'Разовый отказ проигнорирован (маршрут только что работал)'
    };
  }
  if (!hasFallback) {
    return {
      ...route,
      status: 'refused',
      provenAt: 0,
      benchedUntil: 0,
      lastError: 'Отказ по региону — смените сервер VPN или добавьте другой прокси'
    };
  }
  const step = Math.min(route.penaltyStep || 0, PENALTY_STEPS_MS.length - 1);
  const penalty = PENALTY_STEPS_MS[step];
  return {
    ...route,
    status: 'refused',
    provenAt: 0,
    benchedUntil: now + penalty,
    penaltyStep: Math.min(step + 1, PENALTY_STEPS_MS.length - 1),
    lastError: `Региональный отказ (пауза ${Math.round(penalty / 60000)} мин)`
  };
}

/**
 * Ранжирует маршруты: лучшие сверху.
 * Порядок:
 * 0. Закреплённый вручную и годный маршрут (pinned)
 * 1. Подтверждённые живым открытием Gemini (быстрейшие выше)
 * 2. Проверенные ok (быстрейшие выше)
 * 3. Непроверенные (unknown / checking) по порядку добавления
 * 4. На скамейке запасных (refused / dead)
 * 5. Заблокированный регион / выключенные
 */
export function rankRoutes(routes, now = Date.now(), currentLeaderId = null) {
  function tier(r) {
    if (!r.enabled) return 6;
    if (r.status === 'blocked_region') return 5;
    if (isRouteBenched(r, now)) return 4;
    if (r.pinned) return 0;
    if (isRouteProven(r, now)) return 1;
    if (r.status === 'ok') return 2;
    return 3;
  }

  function effectiveLatency(r) {
    if (r.latencyMs == null) return Number.MAX_SAFE_INTEGER;
    if (r.measuredAt && now - r.measuredAt > SAMPLE_TTL_MS) return Number.MAX_SAFE_INTEGER - 1;
    return r.latencyMs;
  }

  const sorted = [...routes].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;

    const la = effectiveLatency(a);
    const lb = effectiveLatency(b);

    // Порог смены лидера 20%: не дёргаем текущий рабочий маршрут ради разницы в 15 мс
    if (currentLeaderId && (a.id === currentLeaderId || b.id === currentLeaderId)) {
      if (a.id === currentLeaderId && lb < la && (la - lb) * 100 < la * SWITCH_MARGIN_PCT) {
        return -1;
      }
      if (b.id === currentLeaderId && la < lb && (lb - la) * 100 < lb * SWITCH_MARGIN_PCT) {
        return 1;
      }
    }

    if (la !== lb) return la - lb;
    return (a.addedAt || 0) - (b.addedAt || 0);
  });

  return sorted;
}

/**
 * Возвращает упорядоченный список прокси для PAC-скрипта (только годные маршруты).
 */
export function selectActiveRoutes(routes, now = Date.now(), currentLeaderId = null) {
  const ranked = rankRoutes(routes, now, currentLeaderId);
  return ranked.filter((r) => isRouteUsable(r, now));
}
