const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'ac.cn',
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'com.au',
  'net.au',
  'org.au',
  'com.hk',
  'com.tw',
  'org.tw',
  'edu.tw',
  'com.sg',
  'co.kr',
  'or.kr',
  'co.nz',
  'com.br',
  'com.mx',
  'co.in',
  'github.io',
  'gitlab.io',
  'vercel.app',
  'pages.dev',
  'netlify.app',
  'appspot.com',
  'cloudfront.net',
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debounce<T extends (...args: any[]) => void>(func: T, timeout = 300) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      func(...args);
    }, timeout);
  };
}

export function isSyncableHttpUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true;
  if (hostname.includes(':')) return true;
  return false;
}

/**
 * Lightweight registrable domain / siteKey extractor for UI helpers.
 */
export function extractSiteKeyFromUrl(urlOrDomain: string): string {
  const trimmed = (urlOrDomain || '').trim();
  if (!trimmed) return '';

  let hostname = trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return '';
      }
      hostname = parsed.hostname;
    } catch {
      return '';
    }
  } else {
    // Strip path/query/port if present
    hostname = trimmed.split('/')[0].split('?')[0].split('#')[0];
    if (!hostname.startsWith('[')) {
      hostname = hostname.split(':')[0];
    }
  }

  hostname = hostname.replace(/^\.+/, '').replace(/\.+$/, '').toLowerCase();
  if (!hostname) return '';
  if (hostname === 'localhost' || isIpLiteral(hostname)) {
    return hostname;
  }

  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;

  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return `${parts[parts.length - 3]}.${lastTwo}`;
  }
  return lastTwo;
}

function addProtocol(uri: string): string {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(uri) ? uri : `https://${uri}`;
}

/**
 * Extracts [siteKeyOrDomain, port, hostname] from a URL.
 */
export async function extractDomainAndPort(url: string, isRemoveWWW = true): Promise<[string, string, string]> {
  let urlObj: URL;
  try {
    urlObj = new URL(addProtocol(url));
  } catch {
    return [url, '', url];
  }

  let hostname = urlObj.hostname.toLowerCase();
  const port = urlObj.port;
  if (isRemoveWWW && hostname.startsWith('www.')) {
    hostname = hostname.slice(4);
  }
  const siteKey = extractSiteKeyFromUrl(urlObj.href) || hostname;
  return [siteKey, port, hostname];
}
