export interface BrowserBrandEntry {
  brand: string;
  version: string;
}

export interface BrowserDetectInput {
  userAgent?: string;
  brands?: readonly BrowserBrandEntry[];
  fullVersionList?: readonly BrowserBrandEntry[];
  isBrave?: boolean;
}

export interface DetectedBrowserInfo {
  browser: string;
  browserVersion: string;
}

interface NavigatorUserAgentDataLike {
  brands?: readonly BrowserBrandEntry[];
  getHighEntropyValues?: (hints: string[]) => Promise<{ fullVersionList?: readonly BrowserBrandEntry[] }>;
}

interface NavigatorWithBrowserHints {
  userAgent?: string;
  userAgentData?: NavigatorUserAgentDataLike;
  brave?: {
    isBrave?: () => Promise<boolean>;
  };
}

interface UaRule {
  browser: string;
  pattern: RegExp;
}

const SPECIFIC_UA_RULES: readonly UaRule[] = [
  // Chromium-based desktop & regional forks (must run BEFORE generic Chrome/)
  { browser: 'Edge', pattern: /\bEdg(?:A|iOS)?\/([\d.]+)/ },
  { browser: 'Opera', pattern: /\b(?:OPR|Opera)\/([\d.]+)/ },
  { browser: 'Vivaldi', pattern: /\bVivaldi\/([\d.]+)/ },
  { browser: 'Yandex', pattern: /\bYaBrowser\/([\d.]+)/ },
  { browser: 'Whale', pattern: /\bWhale\/([\d.]+)/ },
  { browser: 'Samsung Internet', pattern: /\bSamsungBrowser\/([\d.]+)/ },
  { browser: 'QQ Browser', pattern: /\bQQBrowser\/([\d.]+)/ },
  { browser: '360 Extreme', pattern: /\b360EE(?:X)?(?:\/([\d.]+))?|\bQIHU 360EE\b/ },
  { browser: '360 Safe', pattern: /\b360SE(?:\/([\d.]+))?|\bQIHU 360SE\b/ },
  { browser: 'Sogou', pattern: /\bMetaSr\s*([\d.]+)?|\bSE\s+2\.X\b/ },
  { browser: 'Quark', pattern: /\bQuark(?:PC)?\/([\d.]+)/ },
  { browser: 'UC Browser', pattern: /\b(?:UBrowser|UCBrowser)\/([\d.]+)/ },
  { browser: '2345 Explorer', pattern: /\b2345Explorer\/([\d.]+)/ },
  { browser: 'Maxthon', pattern: /\b(?:Maxthon|MXBrowser)\/([\d.]+)/ },
  { browser: 'Brave', pattern: /\bBrave\/([\d.]+)/ },
  { browser: 'Arc', pattern: /\bArc\/([\d.]+)/ },
  // Firefox-based forks (must run BEFORE generic Firefox/)
  { browser: 'Zen', pattern: /\bZen\/([\d.]+)/ },
  { browser: 'Floorp', pattern: /\bFloorp\/([\d.]+)/ },
  { browser: 'Waterfox', pattern: /\bWaterfox\/([\d.]+)/ },
  { browser: 'LibreWolf', pattern: /\bLibreWolf\/([\d.]+)/ },
];

interface BrandRule {
  browser: string;
  match: RegExp;
}

const SPECIFIC_BRAND_RULES: readonly BrandRule[] = [
  { browser: 'Opera GX', match: /^opera\s+gx$/i },
  { browser: 'Edge', match: /^microsoft\s+edge$/i },
  { browser: 'Brave', match: /^brave$/i },
  { browser: 'Opera', match: /^opera$/i },
  { browser: 'Vivaldi', match: /^vivaldi$/i },
  { browser: 'Arc', match: /^arc$/i },
  { browser: 'Yandex', match: /^(?:yandex|yabrowser)$/i },
  { browser: 'Whale', match: /^(?:whale|naver\s+whale)$/i },
  { browser: 'Samsung Internet', match: /^samsung\s+internet$/i },
  { browser: 'DuckDuckGo', match: /^duckduckgo$/i },
  { browser: 'Dia', match: /^dia$/i },
  { browser: 'Comet', match: /^comet$/i },
];

function extractChromeUaVersion(ua: string): string | undefined {
  return ua.match(/\bChrome\/([\d.]+)/)?.[1];
}

function findBrandVersion(list: readonly BrowserBrandEntry[] | undefined, match: RegExp): string | undefined {
  if (!list || list.length === 0) return undefined;
  for (const entry of list) {
    if (entry && typeof entry.brand === 'string' && match.test(entry.brand.trim())) {
      const ver = typeof entry.version === 'string' ? entry.version.trim() : '';
      return ver || undefined;
    }
  }
  return undefined;
}

function pickBestVersion(fullVersion?: string, uaVersion?: string, brandVersion?: string): string {
  if (fullVersion && fullVersion.includes('.')) return fullVersion;
  if (uaVersion && uaVersion.includes('.')) return uaVersion;
  return fullVersion || uaVersion || brandVersion || 'unknown';
}

/**
 * Pure, deterministic browser brand & version detector combining:
 * 1. Specific fork UA tokens (Edge, Opera, Vivaldi, Yandex, Whale, QQ, 360, Quark, Zen, Floorp, etc.)
 * 2. Brave runtime flag (`navigator.brave.isBrave()`)
 * 3. Chromium User-Agent Client Hints (`navigator.userAgentData.brands` / `fullVersionList`)
 * 4. Standard Firefox / Google Chrome / Chromium / Safari fallbacks
 */
export function detectBrowserFromHints(input: BrowserDetectInput): DetectedBrowserInfo {
  const ua = input.userAgent ?? '';
  const brands = input.brands;
  const fullVersionList = input.fullVersionList;
  const chromeUaVersion = extractChromeUaVersion(ua);

  // 1. Specific UA tokens (reliable for Edge, Vivaldi, Opera, Chinese Chromium forks, Firefox forks)
  for (const rule of SPECIFIC_UA_RULES) {
    const m = ua.match(rule.pattern);
    if (m) {
      // Distinguish Opera GX via Client Hints when UA only says OPR/
      if (rule.browser === 'Opera') {
        const gxFull = findBrandVersion(fullVersionList, /^opera\s+gx$/i);
        const gxBrand = findBrandVersion(brands, /^opera\s+gx$/i);
        if (gxFull !== undefined || gxBrand !== undefined) {
          return {
            browser: 'Opera GX',
            browserVersion: pickBestVersion(gxFull, m[1], gxBrand),
          };
        }
      }
      const uaVersion = m[1] || chromeUaVersion;
      return {
        browser: rule.browser,
        browserVersion: uaVersion || 'unknown',
      };
    }
  }

  // 2. Brave runtime detection (Brave masks its UA to look identical to Chrome)
  if (input.isBrave) {
    const braveFull = findBrandVersion(fullVersionList, /^brave$/i);
    const braveBrand = findBrandVersion(brands, /^brave$/i);
    return {
      browser: 'Brave',
      browserVersion: pickBestVersion(braveFull, chromeUaVersion, braveBrand),
    };
  }

  // 3. Specific Chromium fork brands via Client Hints (catches Brave/Arc/Opera GX/Dia/Comet with masked UA)
  for (const rule of SPECIFIC_BRAND_RULES) {
    const fullVer = findBrandVersion(fullVersionList, rule.match);
    const brandVer = findBrandVersion(brands, rule.match);
    if (fullVer !== undefined || brandVer !== undefined) {
      return {
        browser: rule.browser,
        browserVersion: pickBestVersion(fullVer, chromeUaVersion, brandVer),
      };
    }
  }

  // 4. Standard Firefox
  const firefoxMatch = ua.match(/\bFirefox\/([\d.]+)/);
  if (firefoxMatch) {
    return { browser: 'Firefox', browserVersion: firefoxMatch[1] };
  }

  // 5. Distinguish Google Chrome vs open-source Chromium via Client Hints when available
  const hasBrandHints = (fullVersionList && fullVersionList.length > 0) || (brands && brands.length > 0);
  if (hasBrandHints) {
    const chromeFull = findBrandVersion(fullVersionList, /^google\s+chrome$/i);
    const chromeBrand = findBrandVersion(brands, /^google\s+chrome$/i);
    if (chromeFull !== undefined || chromeBrand !== undefined) {
      return {
        browser: 'Chrome',
        browserVersion: pickBestVersion(chromeFull, chromeUaVersion, chromeBrand),
      };
    }

    const chromiumFull = findBrandVersion(fullVersionList, /^chromium$/i);
    const chromiumBrand = findBrandVersion(brands, /^chromium$/i);
    if (chromiumFull !== undefined || chromiumBrand !== undefined) {
      return {
        browser: 'Chromium',
        browserVersion: pickBestVersion(chromiumFull, chromeUaVersion, chromiumBrand),
      };
    }
  }

  // 6. Standard Chrome / Chromium / Safari UA fallbacks
  if (chromeUaVersion) {
    return { browser: 'Chrome', browserVersion: chromeUaVersion };
  }

  const chromiumMatch = ua.match(/\bChromium\/([\d.]+)/);
  if (chromiumMatch) {
    return { browser: 'Chromium', browserVersion: chromiumMatch[1] };
  }

  const safariMatch = ua.match(/\bVersion\/([\d.]+).*\bSafari\//);
  if (safariMatch) {
    return { browser: 'Safari', browserVersion: safariMatch[1] };
  }

  return { browser: 'Chromium', browserVersion: 'unknown' };
}

/**
 * Runtime browser detector for MV3 Service Workers / Extension pages.
 * Safely queries `navigator.userAgent`, `navigator.userAgentData` (including high-entropy
 * `fullVersionList` when available), and `navigator.brave.isBrave()`.
 */
export async function detectBrowserRuntime(
  nav: NavigatorWithBrowserHints | undefined = typeof navigator !== 'undefined'
    ? (navigator as unknown as NavigatorWithBrowserHints)
    : undefined,
): Promise<DetectedBrowserInfo> {
  const userAgent = typeof nav?.userAgent === 'string' ? nav.userAgent : '';
  const brands = Array.isArray(nav?.userAgentData?.brands) ? nav?.userAgentData?.brands : undefined;

  let fullVersionList: readonly BrowserBrandEntry[] | undefined;
  if (typeof nav?.userAgentData?.getHighEntropyValues === 'function') {
    try {
      const highEntropy = await nav.userAgentData.getHighEntropyValues(['fullVersionList']);
      if (Array.isArray(highEntropy?.fullVersionList)) {
        fullVersionList = highEntropy.fullVersionList;
      }
    } catch {
      // Ignore Client Hints rejection in restricted contexts
    }
  }

  let isBrave = false;
  if (typeof nav?.brave?.isBrave === 'function') {
    try {
      isBrave = Boolean(await nav.brave.isBrave());
    } catch {
      isBrave = false;
    }
  }

  return detectBrowserFromHints({
    userAgent,
    brands,
    fullVersionList,
    isBrave,
  });
}
