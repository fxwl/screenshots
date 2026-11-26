import type {
  SiteExpiryHealth,
  SiteSummaryView,
  SiteTrack,
  SyncStatusSummary,
  ToolbarBadgeDisplayMode,
} from '@sessionmesh/core';
import { localeStorage } from '@sessionmesh/storage';

export interface AccountColorPreset {
  id: string;
  label: string;
  color: string;
}

export const ACCOUNT_COLOR_PALETTE: readonly AccountColorPreset[] = [
  { id: 'red', label: '生产 / 高危红', color: '#dc2626' },
  { id: 'amber', label: '预发 / 警告橙', color: '#d97706' },
  { id: 'blue', label: '开发 / 主力蓝', color: '#2563eb' },
  { id: 'green', label: '个人 / 安全绿', color: '#16a34a' },
  { id: 'purple', label: '临时 / 分享紫', color: '#7c3aed' },
  { id: 'cyan', label: '测试 / 青灰', color: '#0891b2' },
  { id: 'slate', label: '备用 / 石板灰', color: '#475569' },
] as const;

function parseHexRgb(hex: string): [number, number, number] | null {
  const cleaned = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    const r = parseInt(cleaned[0] + cleaned[0], 16);
    const g = parseInt(cleaned[1] + cleaned[1], 16);
    const b = parseInt(cleaned[2] + cleaned[2], 16);
    return [r, g, b];
  }
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    return [r, g, b];
  }
  return null;
}

function srgbRelativeLuminance(rgb: [number, number, number]): number {
  const lin = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

const DARK_TEXT_LUMINANCE = srgbRelativeLuminance([0x11, 0x18, 0x27]);

/**
 * Picks `#ffffff` or `#111827` for highest WCAG contrast against `hexBg`.
 */
export function pickTextContrastColor(hexBg: string): '#ffffff' | '#111827' {
  const rgb = parseHexRgb(hexBg);
  if (!rgb) return '#ffffff';
  const lum = srgbRelativeLuminance(rgb);
  const contrastWhite = 1.05 / (lum + 0.05);
  const contrastDark = (lum + 0.05) / (DARK_TEXT_LUMINANCE + 0.05);
  return contrastWhite >= contrastDark ? '#ffffff' : '#111827';
}

/**
 * Derives a compact <=4 char badge label for an account track.
 */
export function deriveTrackBadgeText(track: SiteTrack, indexOneBased: number, totalTracks: number): string {
  const custom = track.badgeText?.trim();
  if (custom) {
    return Array.from(custom)
      .filter(ch => {
        const cp = ch.codePointAt(0);
        return cp !== undefined && (cp < 0xd800 || cp > 0xdfff);
      })
      .slice(0, 4)
      .join('');
  }
  if (track.ephemeral) {
    return 'TEMP';
  }
  if (totalTracks >= 2) {
    return `#${Math.max(1, indexOneBased)}`.slice(0, 4);
  }

  const rawLabel = (track.label ?? '').trim();
  if (rawLabel) {
    const localPart = rawLabel.includes('@') ? rawLabel.split('@')[0] : rawLabel;
    const words = localPart
      .replace(/[._/\\-]+/g, ' ')
      .trim()
      .split(/\s+/)
      .map(w => w.replace(/[^a-zA-Z0-9]/g, ''))
      .filter(Boolean);
    const hasLetter = /[a-zA-Z]/.test(words.join(''));
    if (hasLetter) {
      if (words.length >= 2) {
        return words
          .slice(0, 3)
          .map(w => w[0])
          .join('')
          .toUpperCase();
      }
      if (words.length === 1) {
        return words[0].slice(0, 3).toUpperCase();
      }
    }
  }

  return '#1';
}

function setBadgeInternal(text: string, color: string, tabId?: number): void {
  if (typeof chrome === 'undefined' || !chrome.action) return;
  try {
    const textDetails = tabId !== undefined ? { tabId, text } : { text };
    void Promise.resolve(chrome.action.setBadgeText(textDetails)).catch(() => undefined);
    if (text) {
      const bgDetails = tabId !== undefined ? { tabId, color } : { color };
      const textColor = pickTextContrastColor(color);
      const fgDetails = tabId !== undefined ? { tabId, color: textColor } : { color: textColor };
      void Promise.resolve(chrome.action.setBadgeBackgroundColor(bgDetails)).catch(() => undefined);
      if (chrome.action.setBadgeTextColor) {
        void Promise.resolve(chrome.action.setBadgeTextColor(fgDetails)).catch(() => undefined);
      }
    }
  } catch {
    // ignore action API errors
  }
}

function clearBadgeInternal(tabId?: number): void {
  if (typeof chrome === 'undefined' || !chrome.action) return;
  try {
    const details = tabId !== undefined ? { tabId, text: '' } : { text: '' };
    void Promise.resolve(chrome.action.setBadgeText(details)).catch(() => undefined);
  } catch {
    // ignore action API errors
  }
}

function setActionTitleInternal(title: string, tabId?: number): void {
  if (typeof chrome === 'undefined' || !chrome.action?.setTitle) return;
  try {
    const details = tabId !== undefined ? { tabId, title } : { title };
    void Promise.resolve(chrome.action.setTitle(details)).catch(() => undefined);
  } catch {
    // ignore action API errors
  }
}

export function setBadge(text: string, color = '#2563eb'): void {
  setBadgeInternal(text, color);
}

export function clearBadge(): void {
  clearBadgeInternal();
}

function formatRemainingDuration(remainingMs?: number, isEn = false): string {
  if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs) || remainingMs <= 0) {
    return isEn ? 'soon' : '即将';
  }
  const totalMinutes = Math.max(1, Math.round(remainingMs / 60_000));
  if (totalMinutes < 60) {
    return isEn ? `${totalMinutes}m` : `${totalMinutes} 分钟`;
  }
  const hours = Math.round(totalMinutes / 60);
  if (hours < 48) {
    return isEn ? `${hours}h` : `${hours} 小时`;
  }
  return isEn ? `${Math.round(hours / 24)}d` : `${Math.round(hours / 24)} 天`;
}

function formatExpiryWarningSuffix(expiryHealth?: SiteExpiryHealth, isEn = false): string {
  if (!expiryHealth || expiryHealth.status === 'healthy') return '';
  if (expiryHealth.status === 'expired') {
    return isEn ? ' ⚠️ Auth cookie expired' : ' ⚠️ 登录 Cookie 已过期';
  }
  if (expiryHealth.status === 'critical') {
    return isEn
      ? ` ⚠️ Cookie expires within ${formatRemainingDuration(expiryHealth.remainingMs, true)}`
      : ` ⚠️ Cookie 将在 ${formatRemainingDuration(expiryHealth.remainingMs)}内过期`;
  }
  return isEn
    ? ` ⏳ Cookie expires in ${formatRemainingDuration(expiryHealth.remainingMs, true)}`
    : ` ⏳ Cookie 将在 ${formatRemainingDuration(expiryHealth.remainingMs)}后过期`;
}

/**
 * Updates the global MV3 extension toolbar badge and tooltip from SyncStatusSummary:
 * - `⇅` (blue): syncing / initializing / joining
 * - `×` (red): auth error or decrypt error
 * - `‖` (slate): paused or locked
 * - `N` / `9+` (amber): pending multi-track site decisions
 * - `!` (orange/yellow): unresolved conflicts, offline, or partial error
 * - clear: synced or idle
 */
export function updateBadgeFromStatus(summary: SyncStatusSummary): void {
  const isEn = localeStorage.resolve() === 'en';
  const spaceLabel = summary.activeSpaceName ? ` [${summary.activeSpaceName}]` : '';

  if (summary.status === 'SYNCING' || summary.status === 'INITIALIZING' || summary.status === 'JOINING') {
    setBadge('⇅', '#2563eb');
    setActionTitleInternal(isEn ? `SessionMesh${spaceLabel} — Syncing...` : `SessionMesh${spaceLabel} — 同步中...`);
    return;
  }

  if (summary.status === 'AUTH_ERROR' || summary.status === 'DECRYPT_ERROR') {
    setBadge('×', '#dc2626');
    setActionTitleInternal(
      isEn
        ? `SessionMesh${spaceLabel} — ${summary.status === 'DECRYPT_ERROR' ? 'Master password check failed' : 'Storage auth failed'}`
        : `SessionMesh${spaceLabel} — ${summary.status === 'DECRYPT_ERROR' ? '加密密码校验失败' : 'WebDAV 认证失败'}`,
    );
    return;
  }

  if (summary.status === 'LOCKED' || summary.locked) {
    setBadge('‖', '#64748b');
    setActionTitleInternal(
      isEn
        ? `SessionMesh${spaceLabel} — Locked (Enter master password to unlock)`
        : `SessionMesh${spaceLabel} — 已锁定（需输入主密码解锁）`,
    );
    return;
  }

  if (summary.status === 'PAUSED') {
    setBadge('‖', '#64748b');
    setActionTitleInternal(
      isEn ? `SessionMesh${spaceLabel} — Global sync paused` : `SessionMesh${spaceLabel} — 全局同步已暂停`,
    );
    return;
  }

  const items = summary.attentionItems ?? [];
  const badgeItems = items.filter(
    item =>
      item.severity === 'error' ||
      item.severity === 'warning' ||
      item.kind === 'deferred_reload' ||
      item.kind === 'cookie_expiring',
  );

  if (summary.pendingDecisionsCount > 0) {
    const countLabel = summary.pendingDecisionsCount > 9 ? '9+' : String(summary.pendingDecisionsCount);
    setBadge(countLabel, '#d97706');
    setActionTitleInternal(
      isEn
        ? `SessionMesh${spaceLabel} — ${summary.pendingDecisionsCount} site(s) awaiting version choice (Click to review)`
        : `SessionMesh${spaceLabel} — ${summary.pendingDecisionsCount} 个网站待确认同步版本（点击处理）`,
    );
    return;
  }

  if (badgeItems.length > 0) {
    const first = badgeItems[0];
    setBadge('!', '#ca8a04');
    setActionTitleInternal(
      isEn
        ? badgeItems.length > 1
          ? `SessionMesh${spaceLabel} — ${badgeItems.length} items need attention (Click to view)`
          : `SessionMesh${spaceLabel} — Attention needed (Click to view)`
        : badgeItems.length > 1
          ? `SessionMesh${spaceLabel} — ${badgeItems.length} 项待处理：${first.title}（点击处理）`
          : `SessionMesh${spaceLabel} — ${first.title}（点击处理）`,
    );
    return;
  }

  clearBadge();
  if (!summary.configured || summary.status === 'UNCONFIGURED') {
    setActionTitleInternal(
      isEn
        ? 'SessionMesh — Click to set up encrypted multi-device sync'
        : 'SessionMesh — 点击开始配置 WebDAV 多设备同步',
    );
  } else if (summary.status === 'PENDING') {
    setActionTitleInternal(
      isEn
        ? `SessionMesh${spaceLabel} — Queued for upload (${summary.pendingUploads} pending)`
        : `SessionMesh${spaceLabel} — 后台自动上传中（待上传 ${summary.pendingUploads} 条变更）`,
    );
  } else {
    setActionTitleInternal(isEn ? `SessionMesh${spaceLabel} — Synced` : `SessionMesh${spaceLabel} — 已同步`);
  }
}

/**
 * Updates a specific tab's MV3 toolbar badge & tooltip with priority ordering:
 * 1. Fatal Global (`AUTH_ERROR` / `DECRYPT_ERROR`)
 * 2. Locked / Paused
 * 3. Syncing / Initializing / Joining
 * 4. Active Site Account Badge (per-tab color & short label when enabled)
 * 5. Pending Decisions / Expiry / Attention Warnings
 * 6. Clear
 */
export function updateBadgeForTab(params: {
  tabId: number;
  summary: SyncStatusSummary;
  siteSummary?: SiteSummaryView | null;
  badgeDisplayMode?: ToolbarBadgeDisplayMode;
}): void {
  const { tabId, summary, siteSummary, badgeDisplayMode = 'multi_or_tagged' } = params;
  const isEn = localeStorage.resolve() === 'en';
  const spaceLabel = summary.activeSpaceName ? ` [${summary.activeSpaceName}]` : '';

  // Priority 1: Fatal Global
  if (summary.status === 'AUTH_ERROR' || summary.status === 'DECRYPT_ERROR') {
    setBadgeInternal('×', '#dc2626', tabId);
    setActionTitleInternal(
      isEn
        ? `SessionMesh${spaceLabel} — ${summary.status === 'DECRYPT_ERROR' ? 'Master password check failed' : 'Storage auth failed'}`
        : `SessionMesh${spaceLabel} — ${summary.status === 'DECRYPT_ERROR' ? '加密密码校验失败' : 'WebDAV 认证失败'}`,
      tabId,
    );
    return;
  }

  // Priority 2: Locked / Paused
  if (summary.status === 'LOCKED' || summary.locked) {
    setBadgeInternal('‖', '#64748b', tabId);
    setActionTitleInternal(
      isEn
        ? `SessionMesh${spaceLabel} — Locked (Enter master password to unlock)`
        : `SessionMesh${spaceLabel} — 已锁定（需输入主密码解锁）`,
      tabId,
    );
    return;
  }

  if (summary.status === 'PAUSED') {
    setBadgeInternal('‖', '#64748b', tabId);
    setActionTitleInternal(
      isEn ? `SessionMesh${spaceLabel} — Global sync paused` : `SessionMesh${spaceLabel} — 全局同步已暂停`,
      tabId,
    );
    return;
  }

  // Priority 3: Syncing
  if (summary.status === 'SYNCING' || summary.status === 'INITIALIZING' || summary.status === 'JOINING') {
    setBadgeInternal('⇅', '#2563eb', tabId);
    setActionTitleInternal(
      isEn ? `SessionMesh${spaceLabel} — Syncing...` : `SessionMesh${spaceLabel} — 同步中...`,
      tabId,
    );
    return;
  }

  // Priority 4: Active Site Account Badge
  const activeTrack = siteSummary?.activeTrack;
  const bindingState = siteSummary?.binding.state;
  const isManagedBinding =
    Boolean(activeTrack) &&
    bindingState !== 'UNMANAGED' &&
    bindingState !== 'BLACKLISTED' &&
    bindingState !== 'PENDING_CHOICE';

  if (siteSummary && activeTrack && isManagedBinding && badgeDisplayMode !== 'status_only') {
    const total = Math.max(1, siteSummary.allTracks.length);
    const shouldShowAccountBadge =
      badgeDisplayMode === 'always' ||
      total >= 2 ||
      Boolean(activeTrack.color || activeTrack.badgeText || activeTrack.ephemeral);

    if (shouldShowAccountBadge) {
      const idx = siteSummary.allTracks.findIndex(t => t.trackId === activeTrack.trackId);
      const indexOneBased = idx >= 0 ? idx + 1 : 1;
      const color = activeTrack.color || (activeTrack.ephemeral ? '#7c3aed' : '#2563eb');
      const text = deriveTrackBadgeText(activeTrack, indexOneBased, total);
      const expirySuffix = formatExpiryWarningSuffix(siteSummary.expiryHealth, isEn);
      const ephemeralTag = activeTrack.ephemeral ? (isEn ? ' [Temp Share]' : ' [临时分享]') : '';

      setBadgeInternal(text, color, tabId);
      setActionTitleInternal(
        `SessionMesh${spaceLabel} — ${siteSummary.siteKey} · ${activeTrack.label} (${indexOneBased}/${total})${ephemeralTag}${expirySuffix}`,
        tabId,
      );
      return;
    }
  }

  // Priority 5: Pending Decisions / Expiry / Attention Warnings
  if (summary.pendingDecisionsCount > 0) {
    const countLabel = summary.pendingDecisionsCount > 9 ? '9+' : String(summary.pendingDecisionsCount);
    setBadgeInternal(countLabel, '#d97706', tabId);
    setActionTitleInternal(
      isEn
        ? `SessionMesh${spaceLabel} — ${summary.pendingDecisionsCount} site(s) awaiting version choice (Click to review)`
        : `SessionMesh${spaceLabel} — ${summary.pendingDecisionsCount} 个网站待确认同步版本（点击处理）`,
      tabId,
    );
    return;
  }

  const items = summary.attentionItems ?? [];
  const badgeItems = items.filter(
    item =>
      item.severity === 'error' ||
      item.severity === 'warning' ||
      item.kind === 'deferred_reload' ||
      item.kind === 'cookie_expiring',
  );

  if (badgeItems.length > 0) {
    const first = badgeItems[0];
    setBadgeInternal('!', '#ca8a04', tabId);
    setActionTitleInternal(
      isEn
        ? badgeItems.length > 1
          ? `SessionMesh${spaceLabel} — ${badgeItems.length} items need attention (Click to view)`
          : `SessionMesh${spaceLabel} — Attention needed (Click to view)`
        : badgeItems.length > 1
          ? `SessionMesh${spaceLabel} — ${badgeItems.length} 项待处理：${first.title}（点击处理）`
          : `SessionMesh${spaceLabel} — ${first.title}（点击处理）`,
      tabId,
    );
    return;
  }

  if (siteSummary?.expiryHealth && siteSummary.expiryHealth.status !== 'healthy') {
    setBadgeInternal('!', '#ca8a04', tabId);
    setActionTitleInternal(
      `SessionMesh${spaceLabel} — ${siteSummary.siteKey}${formatExpiryWarningSuffix(siteSummary.expiryHealth, isEn)}`,
      tabId,
    );
    return;
  }

  // Priority 6: Clear
  clearBadgeInternal(tabId);
  if (!summary.configured || summary.status === 'UNCONFIGURED') {
    setActionTitleInternal(
      isEn
        ? 'SessionMesh — Click to set up encrypted multi-device sync'
        : 'SessionMesh — 点击开始配置 WebDAV 多设备同步',
      tabId,
    );
  } else if (siteSummary && activeTrack && isManagedBinding) {
    const total = Math.max(1, siteSummary.allTracks.length);
    const idx = siteSummary.allTracks.findIndex(t => t.trackId === activeTrack.trackId);
    const indexOneBased = idx >= 0 ? idx + 1 : 1;
    setActionTitleInternal(
      isEn
        ? `SessionMesh${spaceLabel} — ${siteSummary.siteKey} · ${activeTrack.label} (${indexOneBased}/${total}) · Synced`
        : `SessionMesh${spaceLabel} — ${siteSummary.siteKey} · ${activeTrack.label} (${indexOneBased}/${total}) · 已同步`,
      tabId,
    );
  } else if (summary.status === 'PENDING') {
    setActionTitleInternal(
      isEn
        ? `SessionMesh${spaceLabel} — Queued for upload (${summary.pendingUploads} pending)`
        : `SessionMesh${spaceLabel} — 后台自动上传中（待上传 ${summary.pendingUploads} 条变更）`,
      tabId,
    );
  } else {
    setActionTitleInternal(isEn ? `SessionMesh${spaceLabel} — Synced` : `SessionMesh${spaceLabel} — 已同步`, tabId);
  }
}
