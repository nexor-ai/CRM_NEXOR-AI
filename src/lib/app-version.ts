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
