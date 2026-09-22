const RESERVED_PROFILE_PATHS = new Set([
  'home', 'explore', 'search', 'i', 'intent', 'settings', 'login', 'logout', 'signup',
  'messages', 'notifications', 'compose', 'share', 'hashtag', 'account', 'accounts',
  'about', 'privacy', 'tos', 'help', 'download', 'jobs', 'status', 'statuses',
]);

/** Extract explicit account identifiers without treating links or emails as mentions. */
export function extractExplicitXHandles(text: string): string[] {
  const found: { handle: string; index: number }[] = [];
  // Mask every scheme URL, including invalid/non-X URLs, before looking for @mentions.
  // Japanese sentence punctuation delimits a URL; ASCII query/fragment syntax does not.
  const withoutUrls = text.replace(/(?:\b[a-z][a-z0-9+.-]*:\/\/|\/\/)[^\s<>"'`「」『』（）()、。！？]+/gi, (token: string, index: number) => {
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(token)?.[1]?.toLowerCase();
    if (/^https:\/\//i.test(token) && (authority === 'x.com' || authority === 'twitter.com') && !token.includes('\\')) {
      try {
        const url = new URL(token);
        // Inspect the original path too: URL() would normalize /other/../handle.
        const match = /^https:\/\/(?:x\.com|twitter\.com)\/([a-z0-9_]{1,15})\/?(?:[?#].*)?$/i.exec(token);
        const handle = match?.[1]?.toLowerCase();
        if (url.protocol === 'https:' && !url.username && !url.password && !url.port && handle && !RESERVED_PROFILE_PATHS.has(handle)) {
          found.push({ handle, index });
        }
      } catch { /* Invalid URL tokens remain masked and cannot turn into mentions. */ }
    }
    return ' '.repeat(token.length);
  });
  // Include legal punctuation in an email local part (e.g. team+@example.com).
  const withoutEmails = withoutUrls.replace(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, match => ' '.repeat(match.length));
  for (const match of withoutEmails.matchAll(/(?<![a-z0-9_@])@([a-z0-9_]{1,15})(?![a-z0-9_@])/gi)) {
    found.push({ handle: match[1]!.toLowerCase(), index: match.index });
  }
  return [...new Set(found.sort((left, right) => left.index - right.index).map(item => item.handle))];
}
