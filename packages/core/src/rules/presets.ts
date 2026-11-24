import type { BlacklistEntry } from '../types';
import { normalizeDomain } from '../psl';

export type PresetBlacklistCategory =
  | 'banking'
  | 'password_manager'
  | 'webdav_self'
  | 'localhost';

interface PresetRuleDef {
  pattern: string;
  matchType: BlacklistEntry['matchType'];
  reason: string;
}

const BANKING_PRESETS: readonly PresetRuleDef[] = [
  // Global payment & banking
  { pattern: '*.paypal.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.alipay.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.stripe.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.unionpay.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.95516.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.chase.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.bankofamerica.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.wellsfargo.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.citi.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.hsbc.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.barclays.co.uk', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.capitalone.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.americanexpress.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.wise.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  // Major Chinese banks
  { pattern: '*.icbc.com.cn', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.ccb.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.abchina.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.boc.cn', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.cmbchina.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.bankcomm.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.psbc.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.spdb.com.cn', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.citicbank.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.pingan.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.cmbc.com.cn', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.cib.com.cn', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
  { pattern: '*.cebbank.com', matchType: 'subdomain', reason: 'Sensitive preset: payment & banking' },
];

const PASSWORD_MANAGER_PRESETS: readonly PresetRuleDef[] = [
  { pattern: '*.1password.com', matchType: 'subdomain', reason: 'Sensitive preset: password manager' },
  { pattern: '*.1password.eu', matchType: 'subdomain', reason: 'Sensitive preset: password manager' },
  { pattern: '*.1password.ca', matchType: 'subdomain', reason: 'Sensitive preset: password manager' },
  { pattern: '*.bitwarden.com', matchType: 'subdomain', reason: 'Sensitive preset: password manager' },
  { pattern: '*.bitwarden.eu', matchType: 'subdomain', reason: 'Sensitive preset: password manager' },
  { pattern: '*.lastpass.com', matchType: 'subdomain', reason: 'Sensitive preset: password manager' },
  { pattern: '*.dashlane.com', matchType: 'subdomain', reason: 'Sensitive preset: password manager' },
  { pattern: '*.keepersecurity.com', matchType: 'subdomain', reason: 'Sensitive preset: password manager' },
  { pattern: '*.nordpass.com', matchType: 'subdomain', reason: 'Sensitive preset: password manager' },
  { pattern: '*.roboform.com', matchType: 'subdomain', reason: 'Sensitive preset: password manager' },
  { pattern: '*.enpass.io', matchType: 'subdomain', reason: 'Sensitive preset: password manager' },
];

const LOCALHOST_PRESETS: readonly PresetRuleDef[] = [
  { pattern: 'localhost', matchType: 'subdomain', reason: 'Sensitive preset: local development host' },
  { pattern: '127.0.0.1', matchType: 'exact_domain', reason: 'Sensitive preset: local loopback IPv4' },
  { pattern: '[::1]', matchType: 'exact_domain', reason: 'Sensitive preset: local loopback IPv6' },
  { pattern: '*.local', matchType: 'subdomain', reason: 'Sensitive preset: local network mDNS domain' },
];

function slugifyPattern(pattern: string): string {
  return pattern
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'entry';
}

/**
 * Generates built-in sensitive preset blacklist entries for the chosen categories.
 */
export function buildPresetBlacklistEntries(
  categories: Array<'banking' | 'password_manager' | 'webdav_self' | 'localhost'>,
  webdavUrl?: string,
  scope: 'space' | 'device' = 'space',
): BlacklistEntry[] {
  const now = Date.now();
  const entries: BlacklistEntry[] = [];
  const seenKeys = new Set<string>();
  const uniqueCategories = Array.from(new Set(categories));

  const pushEntry = (
    category: PresetBlacklistCategory,
    pattern: string,
    matchType: BlacklistEntry['matchType'],
    reason: string,
  ) => {
    const dedupKey = `${matchType}::${pattern.toLowerCase()}`;
    if (seenKeys.has(dedupKey)) return;
    seenKeys.add(dedupKey);
    entries.push({
      id: `preset_${category}_${scope}_${slugifyPattern(pattern)}`,
      pattern,
      matchType,
      scope,
      reason,
      presetCategory: category,
      createdAt: now,
    });
  };

  for (const category of uniqueCategories) {
    if (category === 'banking') {
      for (const def of BANKING_PRESETS) {
        pushEntry('banking', def.pattern, def.matchType, def.reason);
      }
    } else if (category === 'password_manager') {
      for (const def of PASSWORD_MANAGER_PRESETS) {
        pushEntry('password_manager', def.pattern, def.matchType, def.reason);
      }
    } else if (category === 'localhost') {
      for (const def of LOCALHOST_PRESETS) {
        pushEntry('localhost', def.pattern, def.matchType, def.reason);
      }
    } else if (category === 'webdav_self' && webdavUrl) {
      const trimmed = webdavUrl.trim();
      if (!trimmed) continue;

      let host = '';
      let origin = '';
      if (trimmed.includes('://')) {
        try {
          const parsed = new URL(trimmed);
          host = normalizeDomain(parsed.hostname);
          origin = parsed.origin.toLowerCase();
        } catch {
          host = normalizeDomain(trimmed);
        }
      } else {
        host = normalizeDomain(trimmed);
      }

      if (host) {
        pushEntry(
          'webdav_self',
          host,
          'exact_domain',
          'Prevent sync loop with the WebDAV server host itself',
        );
      }
      if (origin && origin.includes('://')) {
        // If WebDAV uses a custom port or explicit origin, also preserve origin rule for strict origin queries
        const parsedOriginPort = (() => {
          try {
            return new URL(origin).port;
          } catch {
            return '';
          }
        })();
        if (parsedOriginPort) {
          pushEntry(
            'webdav_self',
            origin,
            'origin',
            'Prevent sync loop with the WebDAV server origin itself',
          );
        }
      }
    }
  }

  return entries;
}
