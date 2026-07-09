/**
 * Returns true only for absolute http(s) URLs. Used to bound what the
 * extension's /open-external route is willing to hand to the OS, so a
 * caller cannot smuggle file:, command:, vscode:, or javascript: URIs.
 */
export function isAllowedExternalUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}
