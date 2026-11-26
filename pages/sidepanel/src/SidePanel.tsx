import { AccountsManagerTab } from '@src/components/AccountsManagerTab';
import { AttentionBanner } from '@src/components/AttentionBanner';
import { ConflictsTab } from '@src/components/ConflictsTab';
import { DevicesTab } from '@src/components/DevicesTab';
import { HeaderBar } from '@src/components/HeaderBar';
import { HistoryAndUndoTab } from '@src/components/HistoryAndUndoTab';
import { LocalStorageTab } from '@src/components/LocalStorageTab';
import { RulesTab } from '@src/components/RulesTab';
import { SitesAndCookiesTab } from '@src/components/SitesAndCookiesTab';
import { extractErrorMessage, sidePanelApi } from '@src/lib/api';
import { useBannerPrefs } from '@src/lib/bannerPrefs';
import { useSessionMeshStatus, useTheme, withErrorBoundary, withSuspense } from '@sessionmesh/shared';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Toaster } from '@sessionmesh/ui';
import {
  AlertTriangle,
  Cookie,
  Database,
  ExternalLink,
  GitMerge,
  History,
  Laptop,
  Loader2,
  Lock,
  Settings,
  Shield,
  Users,
  X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type SidePanelTabId = 'sites' | 'localstorage' | 'rules' | 'devices' | 'history' | 'conflicts';

const VALID_TABS: ReadonlySet<string> = new Set<SidePanelTabId>([
  'sites',
  'localstorage',
  'rules',
  'devices',
  'history',
  'conflicts',
]);

function readInitialQuery(): { tab: SidePanelTabId; siteKey: string | null } {
  try {
    const params = new URLSearchParams(window.location.search);
    const rawTab = params.get('tab') || '';
    const tab: SidePanelTabId = VALID_TABS.has(rawTab) ? (rawTab as SidePanelTabId) : 'sites';
    const siteKey = params.get('site');
    return { tab, siteKey };
  } catch {
    return { tab: 'sites', siteKey: null };
  }
}

const SidePanel: React.FC = () => {
  const initial = readInitialQuery();
  const [activeTab, setActiveTab] = useState<SidePanelTabId>(initial.tab);
  const [sitesSubView, setSitesSubView] = useState<'sites' | 'accounts'>('sites');
  const [initialSiteKey, setInitialSiteKey] = useState<string | null>(initial.siteKey);
  const [accountSiteFilter, setAccountSiteFilter] = useState<string | null>(null);
  const [lsFilter, setLsFilter] = useState<{ siteKey?: string; trackId?: string; trackLabel?: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  const { theme } = useTheme();
  const { status, settings, refresh, loading, revision } = useSessionMeshStatus();
  const { isBannerVisible, dismissBanner } = useBannerPrefs();
  const combinedRefreshSignal = refreshSignal + revision;

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
    const listener = (message: unknown) => {
      if (message === 'closeSidePanel') {
        window.close();
        return;
      }
      if (message && typeof message === 'object') {
        const msg = message as { type?: string; tab?: string; siteKey?: string };
        if (msg.type === 'OPEN_SIDEPANEL_TAB') {
          if (msg.tab === 'accounts') {
            setActiveTab('sites');
            setSitesSubView('accounts');
            if (msg.siteKey) setAccountSiteFilter(msg.siteKey);
          } else if (msg.tab && VALID_TABS.has(msg.tab)) {
            setActiveTab(msg.tab as SidePanelTabId);
            if (msg.tab === 'sites') setSitesSubView('sites');
          }
          if (msg.siteKey && msg.tab !== 'accounts') {
            setInitialSiteKey(msg.siteKey);
          }
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  const handleRefreshAll = useCallback(async () => {
    await refresh();
    setRefreshSignal(v => v + 1);
  }, [refresh]);

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const res = await sidePanelApi.syncNow();
      if (res.errorMessage) {
        toast.warning(`WebDAV 云端暂时繁忙，系统将继续后台自动退避重试：${res.errorMessage}`);
      } else {
        const refreshHint = res.appliedCookies > 0 && !settings?.autoRefresh ? '，刷新对应网页即可生效' : '';
        toast.success(
          `同步完成：推送 ${res.pushedEvents}，拉取 ${res.pulledEvents}，写入 ${res.appliedCookies} 条${
            res.failedCookies > 0 ? `，失败 ${res.failedCookies} 条` : ''
          }${refreshHint}`,
        );
      }
      await handleRefreshAll();
    } catch (err) {
      toast.error(`同步失败：${extractErrorMessage(err)}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unlockPassword) return;
    setUnlocking(true);
    try {
      await sidePanelApi.unlockSession(unlockPassword, status?.activeSpaceId);
      setUnlockPassword('');
      toast.success('加密会话已解锁');
      await handleRefreshAll();
    } catch (err) {
      toast.error(`解锁失败：${extractErrorMessage(err)}`);
    } finally {
      setUnlocking(false);
    }
  };

  const handleOpenOptions = (targetTab?: string, subTab?: string) => {
    const params = new URLSearchParams();
    if (targetTab) params.set('tab', targetTab);
    if (subTab) params.set('sub', subTab);
    const qs = params.toString() ? `?${params.toString()}` : '';
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL && chrome.tabs?.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL(`options/index.html${qs}`) });
    } else if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(`/options/index.html${qs}`, '_blank');
    }
  };

  const handleOpenLocalStorageForAccount = (siteKey: string, trackId?: string, trackLabel?: string) => {
    setLsFilter({ siteKey, trackId, trackLabel });
    setActiveTab('localstorage');
  };

  const pendingDecisionsCount = status?.pendingDecisionsCount ?? 0;
  const unresolvedConflictsCount = status?.unresolvedConflictsCount ?? 0;
  const undoPointsCount = status?.undoPointsCount ?? 0;
  const attentionItems = status?.attentionItems ?? [];

  const tabs: Array<{
    id: SidePanelTabId;
    label: string;
    shortLabel: string;
    icon: React.ReactNode;
    badge?: number;
    badgeClass?: string;
  }> = [
    {
      id: 'sites',
      label: '网站与 Cookies',
      shortLabel: '网站',
      icon: <Cookie className="h-3.5 w-3.5" />,
      badge: pendingDecisionsCount > 0 ? pendingDecisionsCount : undefined,
      badgeClass: 'bg-amber-500 text-white',
    },
    {
      id: 'localstorage',
      label: 'LocalStorage',
      shortLabel: 'LS',
      icon: <Database className="h-3.5 w-3.5" />,
    },
    {
      id: 'rules',
      label: '黑名单与规则',
      shortLabel: '规则',
      icon: <Shield className="h-3.5 w-3.5" />,
    },
    {
      id: 'devices',
      label: '设备管理',
      shortLabel: '设备',
      icon: <Laptop className="h-3.5 w-3.5" />,
    },
    {
      id: 'history',
      label: '历史与后悔药',
      shortLabel: '历史',
      icon: <History className="h-3.5 w-3.5" />,
      badge: undoPointsCount > 0 ? undoPointsCount : undefined,
      badgeClass: 'bg-sky-500 text-white',
    },
    {
      id: 'conflicts',
      label: '冲突中心',
      shortLabel: '冲突',
      icon: <GitMerge className="h-3.5 w-3.5" />,
      badge: unresolvedConflictsCount > 0 ? unresolvedConflictsCount : undefined,
      badgeClass: 'bg-rose-500 text-white',
    },
  ];

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background text-foreground">
      {/* Top Header */}
      <HeaderBar
        status={status ?? null}
        syncTimingMode={settings?.syncTimingMode}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onRefreshAll={handleRefreshAll}
        syncing={syncing}
        onSyncNow={handleSyncNow}
        onOpenOptions={() =>
          handleOpenOptions(
            activeTab === 'sites'
              ? sitesSubView === 'accounts'
                ? 'accounts'
                : 'sites'
              : activeTab === 'localstorage'
                ? 'sites'
                : activeTab === 'rules'
                  ? 'rules'
                  : activeTab === 'devices'
                    ? 'devices_spaces'
                    : 'history_conflicts',
            activeTab === 'localstorage' ? 'localstorage' : activeTab === 'history' ? 'history' : undefined,
          )
        }
      />

      {/* Unified Actionable Attention Center */}
      {status?.configured && !status.locked && status.status !== 'DECRYPT_ERROR' ? (
        <AttentionBanner
          items={attentionItems}
          onRefreshAll={handleRefreshAll}
          onNavigateTab={(tab, siteKey) => {
            setActiveTab(tab);
            if (tab === 'sites') setSitesSubView('sites');
            if (siteKey) setInitialSiteKey(siteKey);
          }}
          onOpenOptions={() => handleOpenOptions('storage_settings')}
        />
      ) : null}

      {/* Dismissible WebDAV Degraded Consistency Notice */}
      {status?.configured &&
      !status.locked &&
      (status.consistencyLevel === 'append_only_degraded' || status.consistencyLevel === 'incompatible') &&
      isBannerVisible('sidepanel_degraded_consistency', 'degraded') ? (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">
                  {status.consistencyLevel === 'append_only_degraded'
                    ? '当前 WebDAV 处于「追加降级一致模式」'
                    : 'WebDAV 服务端兼容性存在风险'}
                </p>
                <p className="text-[11px] opacity-90 leading-snug">
                  {status.consistencyLevel === 'append_only_degraded'
                    ? '服务端未完整支持 If-Match 条件更新，增量事件同步仍可安全工作，建议定期在设置页创建快照。'
                    : '部分必需 WebDAV 操作未通过能力检测，建议打开设置页重新运行连接诊断。'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => void dismissBanner('sidepanel_degraded_consistency')}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-amber-500/20">
                不再提示
              </button>
              <button
                type="button"
                onClick={() => void dismissBanner('sidepanel_degraded_consistency')}
                className="rounded p-0.5 hover:bg-amber-500/20"
                aria-label="关闭降级提示">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Loading / Unconfigured / Locked / Normal 6-Tab Console */}
      {loading && !status.configured ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span>正在连接 SessionMesh 后台服务...</span>
        </div>
      ) : !loading && status && !status.configured ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <Card className="w-full max-w-sm">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base">尚未配置 SessionMesh</CardTitle>
              <CardDescription className="text-xs">
                请先在设置向导中连接您的 WebDAV
                服务器并设置端到端加密密码，完成后即可在侧边栏全量管理站点轨道、Cookies、LocalStorage、规则与冲突。
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <Button className="w-full" size="sm" onClick={() => handleOpenOptions()}>
                <Settings className="mr-1.5 h-4 w-4" />
                打开首次配置向导
              </Button>
            </CardContent>
          </Card>
        </div>
      ) : !loading && (status?.locked || status?.status === 'DECRYPT_ERROR') ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <Card className="w-full max-w-sm">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-1.5 text-base">
                <Lock className="h-4 w-4 text-primary" />
                {status?.status === 'DECRYPT_ERROR' ? '需要输入最新端到端主密码' : '端到端加密会话已锁定'}
              </CardTitle>
              <CardDescription className="text-xs">
                {status?.status === 'DECRYPT_ERROR'
                  ? `检测到空间「${status.activeSpaceName || status.activeSpaceId}」端到端主密码已变更或校验未通过，请输入最新密码验证后即可自动恢复同步。`
                  : `请输入空间「${status.activeSpaceName || status.activeSpaceId}」的加密密码以解锁数据与后台同步。`}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <form onSubmit={handleUnlock} className="space-y-2.5">
                <Input
                  type="password"
                  value={unlockPassword}
                  onChange={e => setUnlockPassword(e.target.value)}
                  placeholder="输入空间端到端加密密码"
                />
                <Button type="submit" size="sm" className="w-full" disabled={unlocking || !unlockPassword}>
                  {unlocking ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                  {status?.status === 'DECRYPT_ERROR' ? '验证并恢复同步' : '解锁会话'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      ) : (
        <>
          {/* 6-Tab Navigation Bar */}
          <nav
            aria-label="SessionMesh 管理导航"
            className="shrink-0 grid grid-cols-6 border-b border-border bg-muted/30 px-1 pt-1">
            {tabs.map(tab => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  title={tab.label}
                  className={`relative flex flex-col items-center justify-center gap-0.5 rounded-t-lg px-1 py-1.5 text-[11px] font-medium transition-colors ${
                    active
                      ? 'bg-background text-primary shadow-sm border border-b-0 border-border'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  }`}>
                  <div className="relative flex items-center justify-center">
                    {tab.icon}
                    {tab.badge !== undefined ? (
                      <span
                        className={`absolute -right-3 -top-1.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none ${
                          tab.badgeClass || 'bg-primary text-primary-foreground'
                        }`}>
                        {tab.badge > 99 ? '99+' : tab.badge}
                      </span>
                    ) : null}
                  </div>
                  <span className="truncate max-w-full leading-tight">{tab.shortLabel}</span>
                </button>
              );
            })}
          </nav>

          {/* Active Tab Content */}
          <main className="min-h-0 flex-1 overflow-hidden">
            {activeTab === 'sites' ? (
              <div className="flex h-full flex-col">
                <div className="shrink-0 flex items-center justify-between gap-2 border-b border-border bg-card/50 px-3 py-1.5">
                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setSitesSubView('sites')}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                        sitesSubView === 'sites'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:text-foreground'
                      }`}>
                      <Cookie className="h-3 w-3" />
                      网站与 Cookies
                    </button>
                    <button
                      type="button"
                      onClick={() => setSitesSubView('accounts')}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                        sitesSubView === 'accounts'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:text-foreground'
                      }`}>
                      <Users className="h-3 w-3" />
                      多账号管理
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleOpenOptions(sitesSubView === 'accounts' ? 'accounts' : 'sites')}
                    className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-primary"
                    title="在宽屏综合管理后台中打开">
                    宽屏打开
                    <ExternalLink className="h-2.5 w-2.5" />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  {sitesSubView === 'sites' ? (
                    <SitesAndCookiesTab
                      globalSearch={searchQuery}
                      initialSiteKey={initialSiteKey}
                      onConsumeInitialSite={() => setInitialSiteKey(null)}
                      onStatusChanged={handleRefreshAll}
                      refreshSignal={combinedRefreshSignal}
                      onOpenAccounts={siteKey => {
                        if (siteKey) setAccountSiteFilter(siteKey);
                        setSitesSubView('accounts');
                      }}
                      onOpenLocalStorage={handleOpenLocalStorageForAccount}
                    />
                  ) : (
                    <AccountsManagerTab
                      globalSearch={searchQuery}
                      initialSiteFilter={accountSiteFilter}
                      onConsumeInitialSiteFilter={() => setAccountSiteFilter(null)}
                      onStatusChanged={handleRefreshAll}
                      refreshSignal={combinedRefreshSignal}
                      onOpenLocalStorage={handleOpenLocalStorageForAccount}
                    />
                  )}
                </div>
              </div>
            ) : null}

            {activeTab === 'localstorage' ? (
              <LocalStorageTab
                globalSearch={searchQuery}
                filterSiteKey={lsFilter?.siteKey}
                filterTrackId={lsFilter?.trackId}
                filterTrackLabel={lsFilter?.trackLabel}
                onClearFilter={() => setLsFilter(null)}
                onStatusChanged={handleRefreshAll}
                refreshSignal={combinedRefreshSignal}
              />
            ) : null}

            {activeTab === 'rules' ? (
              <RulesTab
                globalSearch={searchQuery}
                onStatusChanged={handleRefreshAll}
                refreshSignal={combinedRefreshSignal}
              />
            ) : null}

            {activeTab === 'devices' ? (
              <DevicesTab
                currentDeviceId={status?.device?.deviceId}
                globalSearch={searchQuery}
                onStatusChanged={handleRefreshAll}
                refreshSignal={combinedRefreshSignal}
              />
            ) : null}

            {activeTab === 'history' ? (
              <HistoryAndUndoTab
                globalSearch={searchQuery}
                onStatusChanged={handleRefreshAll}
                refreshSignal={combinedRefreshSignal}
              />
            ) : null}

            {activeTab === 'conflicts' ? (
              <ConflictsTab
                globalSearch={searchQuery}
                onStatusChanged={handleRefreshAll}
                refreshSignal={combinedRefreshSignal}
              />
            ) : null}
          </main>
        </>
      )}

      <Toaster
        theme={theme}
        closeButton
        toastOptions={{
          duration: 2800,
        }}
        visibleToasts={2}
        richColors
        position="top-center"
      />
    </div>
  );
};

export default withErrorBoundary(
  withSuspense(
    SidePanel,
    <div className="flex h-screen items-center justify-center text-xs text-muted-foreground">
      正在加载 SessionMesh 管理控制台...
    </div>,
  ),
  <div className="flex h-screen flex-col items-center justify-center gap-2 p-4 text-center text-xs">
    <p className="font-semibold text-rose-600">SessionMesh 侧边栏渲染发生异常</p>
    <p className="text-muted-foreground">请尝试重新打开侧边栏或刷新扩展。</p>
  </div>,
);
