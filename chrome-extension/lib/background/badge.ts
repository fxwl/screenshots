import type { SyncStatusSummary } from '@sessionmesh/core';

export function setBadge(text: string, color = '#2563eb'): void {
  if (typeof chrome === 'undefined' || !chrome.action) return;
  try {
    void chrome.action.setBadgeText({ text });
    if (text) {
      void chrome.action.setBadgeBackgroundColor({ color });
      void chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
    }
  } catch {
    // ignore action API errors
  }
}

export function clearBadge(): void {
  if (typeof chrome === 'undefined' || !chrome.action) return;
  try {
    void chrome.action.setBadgeText({ text: '' });
  } catch {
    // ignore action API errors
  }
}

function setActionTitle(title: string): void {
  if (typeof chrome === 'undefined' || !chrome.action?.setTitle) return;
  try {
    void chrome.action.setTitle({ title });
  } catch {
    // ignore action API errors
  }
}

/**
 * Updates the MV3 extension toolbar badge and tooltip from SyncStatusSummary:
 * - `⇅` (blue): syncing / initializing / joining
 * - `×` (red): auth error or decrypt error
 * - `‖` (slate): paused or locked
 * - `N` / `9+` (amber): pending multi-track site decisions
 * - `!` (orange/yellow): unresolved conflicts, offline, or partial error
 * - clear: synced or idle
 */
export function updateBadgeFromStatus(summary: SyncStatusSummary): void {
  const spaceLabel = summary.activeSpaceName ? ` [${summary.activeSpaceName}]` : '';

  if (summary.status === 'SYNCING' || summary.status === 'INITIALIZING' || summary.status === 'JOINING') {
    setBadge('⇅', '#2563eb');
    setActionTitle(`SessionMesh${spaceLabel} — 同步中...`);
    return;
  }

  if (summary.status === 'AUTH_ERROR' || summary.status === 'DECRYPT_ERROR') {
    setBadge('×', '#dc2626');
    setActionTitle(
      `SessionMesh${spaceLabel} — ${summary.status === 'DECRYPT_ERROR' ? '加密密码校验失败' : 'WebDAV 认证失败'}`,
    );
    return;
  }

  if (summary.status === 'LOCKED' || summary.locked) {
    setBadge('‖', '#64748b');
    setActionTitle(`SessionMesh${spaceLabel} — 已锁定（需输入主密码解锁）`);
    return;
  }

  if (summary.status === 'PAUSED') {
    setBadge('‖', '#64748b');
    setActionTitle(`SessionMesh${spaceLabel} — 全局同步已暂停`);
    return;
  }

  const items = summary.attentionItems ?? [];
  const badgeItems = items.filter(
    item => item.severity === 'error' || item.severity === 'warning' || item.kind === 'deferred_reload',
  );

  if (summary.pendingDecisionsCount > 0) {
    const countLabel = summary.pendingDecisionsCount > 9 ? '9+' : String(summary.pendingDecisionsCount);
    setBadge(countLabel, '#d97706');
    setActionTitle(`SessionMesh${spaceLabel} — ${summary.pendingDecisionsCount} 个网站待确认同步版本（点击处理）`);
    return;
  }

  if (badgeItems.length > 0) {
    const first = badgeItems[0];
    setBadge('!', '#ca8a04');
    setActionTitle(
      badgeItems.length > 1
        ? `SessionMesh${spaceLabel} — ${badgeItems.length} 项待处理：${first.title}（点击处理）`
        : `SessionMesh${spaceLabel} — ${first.title}（点击处理）`,
    );
    return;
  }

  clearBadge();
  if (!summary.configured || summary.status === 'UNCONFIGURED') {
    setActionTitle('SessionMesh — 点击开始配置 WebDAV 多设备同步');
  } else if (summary.status === 'PENDING') {
    setActionTitle(`SessionMesh${spaceLabel} — 后台自动上传中（待上传 ${summary.pendingUploads} 条变更）`);
  } else {
    setActionTitle(`SessionMesh${spaceLabel} — 已同步`);
  }
}
