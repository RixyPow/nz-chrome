// Проверка обновлений NZ Chrome через GitHub Releases API.
// Без сторонних зависимостей, с поддержкой semver (X.Y.Z) и фильтрацией черновиков/pre-release.

export const REPO_SLUG = 'RixyPow/nz-chrome';
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
export const RELEASES_PAGE_URL = `https://github.com/${REPO_SLUG}/releases`;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function parseSemver(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^v/i, '');
  const m = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Возвращает true, если remote строго новее current.
 */
export function isNewerVersion(remote, current) {
  const r = parseSemver(remote);
  const c = parseSemver(current);
  if (!r || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] !== c[i]) return r[i] > c[i];
  }
  return false;
}

/**
 * Разбирает JSON-ответ GitHub /releases/latest.
 */
export function parseReleaseResponse(json, currentVersion) {
  if (!json || typeof json !== 'object') {
    return { ok: false, error: 'Пустой ответ GitHub' };
  }
  if (json.draft || json.prerelease) {
    return {
      ok: true,
      available: false,
      currentVersion,
      latestVersion: currentVersion,
      releaseUrl: RELEASES_PAGE_URL,
      downloadUrl: null
    };
  }

  const tag = String(json.tag_name || '').trim();
  const latestVersion = tag.replace(/^v/i, '');
  if (!parseSemver(latestVersion)) {
    return { ok: false, error: `Некорректная версия тега: ${tag}` };
  }

  const zipAsset = Array.isArray(json.assets)
    ? json.assets.find((a) => typeof a?.name === 'string' && a.name.toLowerCase().endsWith('.zip'))
    : null;

  return {
    ok: true,
    available: isNewerVersion(latestVersion, currentVersion),
    currentVersion,
    latestVersion,
    releaseUrl: json.html_url || `${RELEASES_PAGE_URL}/tag/${tag}`,
    downloadUrl: zipAsset?.browser_download_url || null
  };
}
