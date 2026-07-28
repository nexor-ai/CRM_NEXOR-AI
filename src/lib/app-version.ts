const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '');
}

/** Retorna 1 se a > b, -1 se a < b, 0 se equivalentes. NaN se alguma for inválida. */
export function compareSemver(a: string, b: string): number {
  const left = SEMVER_RE.exec(normalizeVersion(a));
  const right = SEMVER_RE.exec(normalizeVersion(b));
  if (!left || !right) return Number.NaN;

  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  const leftPre = left[4];
  const rightPre = right[4];
  if (leftPre === rightPre) return 0;
  // Ausência de pre-release é sempre maior: 0.9.0 > 0.9.0-beta
  if (!leftPre) return 1;
  if (!rightPre) return -1;
  return leftPre > rightPre ? 1 : -1;
}

export function shouldPromptForRelease(
  current: string,
  available: string,
  dismissed: string | null
): boolean {
  if (!current || !available) return false;
  if (current === 'development' || available === 'development') return false;
  if (dismissed && normalizeVersion(dismissed) === normalizeVersion(available)) {
    return false;
  }
  const result = compareSemver(available, current);
  return Number.isNaN(result) ? false : result > 0;
}

export function shouldPromptForUpdate(
  currentVersion: string,
  availableVersion: string,
  dismissedVersion: string | null
) {
  if (!currentVersion || !availableVersion) return false;
  if (currentVersion === 'development' || availableVersion === 'development')
    return false;
  return (
    currentVersion !== availableVersion && dismissedVersion !== availableVersion
  );
}
