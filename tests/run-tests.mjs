import assert from 'node:assert/strict';
import vm from 'node:vm';

import { collectActiveDomains, defaultEnabledServices, isBlockedCountry } from '../src/shared/domains.js';
import { maskProxy, parseProxyInput, toPacDirective } from '../src/shared/proxy-parser.js';
import { buildPacScript } from '../src/shared/pac-builder.js';
import {
  createRoute,
  rankRoutes,
  recordGeoRefusal,
  recordProbeResult,
  recordProofOk,
  selectActiveRoutes
} from '../src/shared/route-table.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('parseProxyInput: базовый host:port, авторизация, схемы и маскировка', () => {
  const r1 = parseProxyInput('1.2.3.4:8080');
  assert.equal(r1.ok, true);
  assert.equal(r1.proxy.scheme, 'http');
  assert.equal(r1.proxy.host, '1.2.3.4');
  assert.equal(r1.proxy.port, 8080);
  assert.equal(toPacDirective(r1.proxy), 'PROXY 1.2.3.4:8080');

  const r2 = parseProxyInput('https://alice:s3cr@t@proxy.example.com:443');
  assert.equal(r2.ok, true);
  assert.equal(r2.proxy.scheme, 'https');
  assert.equal(r2.proxy.username, 'alice');
  assert.equal(r2.proxy.password, 's3cr@t');
  assert.equal(maskProxy(r2.proxy), 'https://alice:***@proxy.example.com:443');
  assert.equal(toPacDirective(r2.proxy), 'HTTPS proxy.example.com:443');

  const r3 = parseProxyInput('socks5://127.0.0.1:2080');
  assert.equal(r3.ok, true);
  assert.equal(r3.proxy.isLocal, true);
  assert.equal(r3.warning, null);
  assert.equal(toPacDirective(r3.proxy), 'SOCKS5 127.0.0.1:2080');

  const r4 = parseProxyInput('socks5://user:pass@1.2.3.4:1080');
  assert.equal(r4.ok, true);
  assert.ok(r4.warning && r4.warning.includes('Chromium'));

  const bad = parseProxyInput('proxy.example.com');
  assert.equal(bad.ok, false);
});

test('buildPacScript: точечная маршрутизация только доменов AI + probeOverride', () => {
  const domains = collectActiveDomains({ gemini: true, aistudio: false, notebooklm: false, labs: false });
  const p1 = parseProxyInput('http://10.0.0.1:3128').proxy;
  const pProbe = parseProxyInput('socks5://127.0.0.1:2080').proxy;

  const pac = buildPacScript({
    domains,
    proxies: [p1],
    probeOverride: { host: 'cp.cloudflare.com', proxy: pProbe }
  });

  // Chromium отклоняет pacScript.data с не-ASCII символами
  assert.equal(/^[\x00-\x7F]*$/.test(pac), true);

  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(pac, ctx);

  assert.equal(ctx.FindProxyForURL('https://gemini.google.com/app', 'gemini.google.com'), 'PROXY 10.0.0.1:3128');
  assert.equal(ctx.FindProxyForURL('https://sub.gemini.google.com/', 'sub.gemini.google.com'), 'PROXY 10.0.0.1:3128');
  assert.equal(ctx.FindProxyForURL('https://accounts.google.com/', 'accounts.google.com'), 'DIRECT');
  assert.equal(ctx.FindProxyForURL('https://youtube.com/', 'youtube.com'), 'DIRECT');
  assert.equal(ctx.FindProxyForURL('https://cp.cloudflare.com/cdn-cgi/trace', 'cp.cloudflare.com'), 'SOCKS5 127.0.0.1:2080');

  // Префикс "=" для google_sorry: проксирует www.google.com и google.com, но НЕ accounts.google.com
  const withSorry = collectActiveDomains({ gemini: true, google_sorry: true });
  const pacSorry = buildPacScript({ domains: withSorry, proxies: [p1] });
  const ctx2 = {};
  vm.createContext(ctx2);
  vm.runInContext(pacSorry, ctx2);
  assert.equal(ctx2.FindProxyForURL('https://www.google.com/sorry/index', 'www.google.com'), 'PROXY 10.0.0.1:3128');
  assert.equal(ctx2.FindProxyForURL('https://google.com/sorry/index', 'google.com'), 'PROXY 10.0.0.1:3128');
  assert.equal(ctx2.FindProxyForURL('https://accounts.google.com/', 'accounts.google.com'), 'DIRECT');
  assert.equal(ctx2.FindProxyForURL('https://mail.google.com/', 'mail.google.com'), 'DIRECT');
});

test('route-table: доказательство важнее скорости, заблокированный регион и нарастающий штраф', () => {
  const now = 1_700_000_000_000;
  let fast = createRoute({ id: 'fast', name: 'Быстрый', proxy: parseProxyInput('1.1.1.2:8080').proxy });
  let proven = createRoute({ id: 'proven', name: 'Проверенный', proxy: parseProxyInput('1.1.1.3:8080').proxy });
  let ru = createRoute({ id: 'ru', name: 'РФ', proxy: parseProxyInput('1.1.1.4:8080').proxy });

  fast = recordProbeResult(fast, { ok: true, country: 'DE', latencyMs: 60 }, now);
  proven = recordProbeResult(proven, { ok: true, country: 'NL', latencyMs: 220 }, now);
  proven = recordProofOk(proven, now);
  ru = recordProbeResult(ru, { ok: true, country: 'RU', latencyMs: 20 }, now);

  assert.equal(isBlockedCountry('RU'), true);
  assert.equal(ru.status, 'blocked_region');

  const active = selectActiveRoutes([fast, proven, ru], now);
  assert.deepEqual(
    active.map((r) => r.id),
    ['proven', 'fast']
  );

  // Защита свежего доказательства (в пределах 90 с отказ не отправляет в штраф)
  const protectedRoute = recordGeoRefusal(proven, now + 30_000);
  assert.equal(protectedRoute.benchedUntil, 0);

  // После 90 с — отправляется в штраф (2 мин, затем 10 мин)
  const refused1 = recordGeoRefusal(proven, now + 120_000);
  assert.equal(refused1.benchedUntil, now + 120_000 + 2 * 60 * 1000);

  const refused2 = recordGeoRefusal(refused1, now + 400_000);
  assert.equal(refused2.benchedUntil, now + 400_000 + 10 * 60 * 1000);

  const afterRefusal = selectActiveRoutes([fast, refused1, ru], now + 125_000);
  assert.deepEqual(
    afterRefusal.map((r) => r.id),
    ['fast']
  );
});

test('route-table: порог смены лидера 20%', () => {
  const now = 1_700_000_000_000;
  let a = createRoute({ id: 'a', name: 'A', proxy: parseProxyInput('1.1.1.2:8080').proxy });
  let b = createRoute({ id: 'b', name: 'B', proxy: parseProxyInput('1.1.1.3:8080').proxy });
  a = recordProbeResult(a, { ok: true, country: 'NL', latencyMs: 100 }, now);
  b = recordProbeResult(b, { ok: true, country: 'DE', latencyMs: 90 }, now);

  // Разница 10% < 20% — текущий лидер 'a' остаётся первым
  const ranked1 = rankRoutes([a, b], now, 'a');
  assert.equal(ranked1[0].id, 'a');

  // Разница 30% >= 20% — 'b' обгоняет
  b = recordProbeResult(b, { ok: true, country: 'DE', latencyMs: 70 }, now);
  const ranked2 = rankRoutes([a, b], now, 'a');
  assert.equal(ranked2[0].id, 'b');
});

test('domains: включение и выключение сервисов', () => {
  const defaults = defaultEnabledServices();
  assert.equal(defaults.gemini, true);
  assert.equal(defaults.labs, false);

  const withLabs = collectActiveDomains({ ...defaults, labs: true });
  assert.ok(withLabs.includes('labs.google'));
  assert.ok(withLabs.includes('gemini.google.com'));
});

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`PASS  ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${t.name}`);
    console.error(err);
  }
}

if (failed > 0) {
  process.exit(1);
}
console.log(`\nВсе тесты пройдены (${tests.length}/${tests.length}).`);
