import { AccountsManagerTab } from '@console/components/AccountsManagerTab';
import { ConflictsTab } from '@console/components/ConflictsTab';
import { DevicesTab } from '@console/components/DevicesTab';
import { HistoryAndUndoTab } from '@console/components/HistoryAndUndoTab';
import { LocalStorageTab } from '@console/components/LocalStorageTab';
import { RulesTab } from '@console/components/RulesTab';
import { SitesAndCookiesTab } from '@console/components/SitesAndCookiesTab';
import {
  unwrapCommand,
  useLocale,
  useSessionMeshStatus,
  useTheme,
  withErrorBoundary,
  withSuspense,
} from '@sessionmesh/shared';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  LanguageDropdown,
  ThemeDropdown,
  Toaster,
} from '@sessionmesh/ui';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  ChevronDown,
  Cookie,
  Database,
  GitMerge,
  History,
  Laptop,
  Layers,
  Loader2,
  Lock,
  Monitor,
  PanelRightOpen,
  RefreshCw,
  Search,
  Server,
  Settings2,
  Shield,
  Sparkles,
  Unlock,
  Users,
  X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { OnboardingWizard } from './components/OnboardingWizard';
import { PolicyAdvancedTab } from './components/PolicyAdvancedTab';
import { QuickStartChecklistCard } from './components/QuickStartChecklistCard';
import { SpacesPairingTab } from './components/SpacesPairingTab';
import { TutorialsTab } from './components/TutorialsTab';
import { WebDAVTab } from './components/WebDAVTab';
import { extractErrorMessage, getDeviceStatusMeta, openSidePanelFromWindow } from './utils/helpers';

type ConsoleSectionId =
  | 'sites'
  | 'accounts'
  | 'rules'
  | 'devices_spaces'
  | 'history_conflicts'
  | 'storage_settings'
  | 'tutorials';

const VALID_SECTIONS: ReadonlySet<string> = new Set<ConsoleSectionId>([
  'sites',
  'accounts',
  'rules',
  'devices_spaces',
  'history_conflicts',
  'storage_settings',
  'tutorials',
]);

function readInitialConsoleQuery(): {
  section: ConsoleSectionId;
  sub: string | null;
  site: string | null;
  onboarding: boolean;
} {
  try {
    const params = new URLSearchParams(window.location.search);
    const rawTab = params.get('tab') || '';
    const mappedTab: ConsoleSectionId = VALID_SECTIONS.has(rawTab)
      ? (rawTab as ConsoleSectionId)
      : rawTab === 'webdav' || rawTab === 'policy'
        ? 'storage_settings'
        : rawTab === 'spaces' || rawTab === 'devices'
          ? 'devices_spaces'
          : rawTab === 'conflicts' || rawTab === 'history'
            ? 'history_conflicts'
            : rawTab === 'localstorage'
              ? 'sites'
              : 'sites';
    const rawSub =
      params.get('sub') ||
      (rawTab === 'localstorage'
        ? 'localstorage'
        : rawTab === 'spaces'
          ? 'spaces'
          : rawTab === 'history'
            ? 'history'
            : rawTab === 'policy'
              ? 'policy'
              : null);
    return {
      section: mappedTab,
      sub: rawSub,
      site: params.get('site'),
      onboarding: params.get('onboarding') === '1',
    };
  } catch {
    return { section: 'sites', sub: null, site: null, onboarding: false };
  }
}

const Options = () => {
  const initial = readInitialConsoleQuery();
  const { theme, setTheme } = useTheme();
  const { localePreference, locale, setLocalePreference } = useLocale();
  const { status, settings, refresh, loading, revision } = useSessionMeshStatus();

  const [forceWizard, setForceWizard] = useState<boolean>(initial.onboarding);
  const [activeSection, setActiveSection] = useState<ConsoleSectionId>(initial.section);
  const [globalSearch, setGlobalSearch] = useState('');
  const [refreshSignal, setRefreshSignal] = useState(0);

  // Per-section clean sub-tabs
  const [sitesSubTab, setSitesSubTab] = useState<'cookies' | 'localstorage'>(
    initial.sub === 'localstorage' ? 'localstorage' : 'cookies',
  );
  const [devicesSubTab, setDevicesSubTab] = useState<'devices' | 'spaces'>(
    initial.sub === 'spaces' ? 'spaces' : 'devices',
  );
  const [auditSubTab, setAuditSubTab] = useState<'conflicts' | 'history'>(
    initial.sub === 'history' ? 'history' : 'conflicts',
  );
  const [storageSubTab, setStorageSubTab] = useState<'webdav' | 'policy'>(
    initial.sub === 'policy' ? 'policy' : 'webdav',
  );

  // Cross-tab drill-down state
  const [initialSiteKey, setInitialSiteKey] = useState<string | null>(initial.site);
  const [initialTrackId, setInitialTrackId] = useState<string | null>(null);
  const [accountSiteFilter, setAccountSiteFilter] = useState<string | null>(null);
  const [lsFilter, setLsFilter] = useState<{ siteKey?: string; trackId?: string; trackLabel?: string } | null>(null);

  // Unlock form when locked
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  // Space switch password modal
  const [switchPassSpace, setSwitchPassSpace] = useState<{ spaceId: string; name: string } | null>(null);
  const [switchPassInput, setSwitchPassInput] = useState('');
  const [switchingSpace, setSwitchingSpace] = useState(false);

  // Sync now & dismiss error
  const [syncingNow, setSyncingNow] = useState(false);
  const [dismissingError, setDismissingError] = useState(false);
  const [dismissedErrorTs, setDismissedErrorTs] = useState<number | null>(null);

  const combinedRefreshSignal = refreshSignal + revision;

  const handleRefreshAll = useCallback(async () => {
    await refresh();
    setRefreshSignal(v => v + 1);
  }, [refresh]);

  // Latch wizard mode once entered on an unconfigured install so completing Step 3 does not
  // unmount OnboardingWizard mid-flow before Step 4 (site selection / pending decisions) renders.
  useEffect(() => {
    if (!loading && !status.configured) {
      setForceWizard(true);
    }
  }, [loading, status.configured]);

  useEffect(() => {
    const onHashOrPop = () => {
      const q = readInitialConsoleQuery();
      setActiveSection(q.section);
      if (q.site) setInitialSiteKey(q.site);
    };
    window.addEventListener('popstate', onHashOrPop);
    return () => window.removeEventListener('popstate', onHashOrPop);
  }, []);

  const handleUnlock = async () => {
    if (!unlockPassword) {
      toast.warning('请输入端到端加密主密码');
      return;
    }
    setUnlocking(true);
    try {
      await unwrapCommand({
        type: 'UNLOCK_SESSION',
        encryptionPassword: unlockPassword,
        spaceId: status?.activeSpaceId,
      });
      setUnlockPassword('');
      toast.success('会话已解锁，同步引擎已恢复运行');
      await handleRefreshAll();
    } catch (err) {
      toast.error(`解锁失败：${extractErrorMessage(err)}`);
    } finally {
      setUnlocking(false);
    }
  };

  const handleSwitchSpace = async (spaceId: string, name: string, password?: string) => {
    setSwitchingSpace(true);
    try {
      await unwrapCommand({
        type: 'SWITCH_SPACE',
        spaceId,
        encryptionPassword: password,
      });
      setSwitchPassSpace(null);
      setSwitchPassInput('');
      toast.success(`已切换至同步空间「${name}」`);
      await handleRefreshAll();
    } catch (err) {
      const msg = extractErrorMessage(err);
      if (!password && /password|lock|decrypt|密码|解锁/i.test(msg)) {
        setSwitchPassSpace({ spaceId, name });
        setSwitchPassInput('');
      } else {
        toast.error(`切换空间失败：${msg}`);
      }
    } finally {
      setSwitchingSpace(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncingNow(true);
    try {
      const res = await unwrapCommand<{
        pushedEvents: number;
        pulledEvents: number;
        appliedCookies: number;
        failedCookies: number;
        errorMessage?: string;
        errorCode?: string;
      }>({ type: 'SYNC_NOW' });
      if (res?.errorMessage) {
        toast.warning(`远端存储暂时繁忙，系统将继续后台自动退避重试：${res.errorMessage}`);
      } else {
        const applied = res?.appliedCookies ?? 0;
        const refreshHint = applied > 0 && !settings?.autoRefresh ? '，刷新对应网页即可生效' : '';
        toast.success(
          `同步完成：上传 ${res?.pushedEvents ?? 0} 条，拉取 ${res?.pulledEvents ?? 0} 条，应用 ${applied} 条 Cookie${refreshHint}`,
        );
      }
      await handleRefreshAll();
    } catch (err) {
      toast.error(`同步失败：${extractErrorMessage(err)}`);
    } finally {
      setSyncingNow(false);
    }
  };

  const handleDismissLatestError = async () => {
    if (status?.latestError?.timestamp) {
      setDismissedErrorTs(status.latestError.timestamp);
    }
    setDismissingError(true);
    try {
      await unwrapCommand({ type: 'DISMISS_LATEST_ERROR' });
      await handleRefreshAll();
    } catch (err) {
      setDismissedErrorTs(null);
      toast.error(`关闭错误提示失败：${extractErrorMessage(err)}`);
    } finally {
      setDismissingError(false);
    }
  };

  const handleJumpToLocalStorage = (siteKey: string, trackId?: string, trackLabel?: string) => {
    setLsFilter({ siteKey, trackId, trackLabel });
    setSitesSubTab('localstorage');
    setActiveSection('sites');
  };

  const handleJumpToAccounts = (siteKey?: string) => {
    if (siteKey) {
      setAccountSiteFilter(siteKey);
    }
    setActiveSection('accounts');
  };

  const showInitialLoading = loading && !status.configured && !forceWizard;
  const inWizardMode = forceWizard || (!loading && !status.configured);

  const pendingDecisionsCount = status?.pendingDecisionsCount ?? 0;
  const unresolvedConflictsCount = status?.unresolvedConflictsCount ?? 0;
  const undoPointsCount = status?.undoPointsCount ?? 0;

  const navItems: Array<{
    id: ConsoleSectionId;
    label: string;
    desc: string;
    icon: React.ReactNode;
    badge?: number;
    badgeVariant?: 'warning' | 'destructive' | 'secondary';
  }> = [
    {
      id: 'sites',
      label: '网站与 Cookies',
      desc: '开启网站同步、Cookie 明细与 LS',
      icon: <Cookie className="h-4 w-4" />,
      badge: pendingDecisionsCount > 0 ? pendingDecisionsCount : undefined,
      badgeVariant: 'warning',
    },
    {
      id: 'accounts',
      label: '多账号管理',
      desc: '大小号秒切、色标备注与分享',
      icon: <Users className="h-4 w-4" />,
    },
    {
      id: 'devices_spaces',
      label: '设备与跨端配对',
      desc: '配对码连新电脑、设备策略与多空间',
      icon: <Laptop className="h-4 w-4" />,
    },
    {
      id: 'rules',
      label: '排除规则与开发联调',
      desc: '敏感黑名单、localhost 注入、SSO',
      icon: <Shield className="h-4 w-4" />,
    },
    {
      id: 'history_conflicts',
      label: '冲突与历史撤回',
      desc: '冲突处理、后悔药恢复、操作记录',
      icon: <GitMerge className="h-4 w-4" />,
      badge:
        unresolvedConflictsCount > 0 ? unresolvedConflictsCount : undoPointsCount > 0 ? undoPointsCount : undefined,
      badgeVariant: unresolvedConflictsCount > 0 ? 'destructive' : 'secondary',
    },
    {
      id: 'storage_settings',
      label: '存储与系统设置',
      desc: '存储位置、加密备份、快捷键与锁',
      icon: <Settings2 className="h-4 w-4" />,
    },
    {
      id: 'tutorials',
      label: '新手教程与指南',
      desc: '3 分钟图解、配对与多号实战、FAQ',
      icon: <BookOpen className="h-4 w-4" />,
    },
  ];

  const activeNavMeta = navItems.find(item => item.id === activeSection) ?? navItems[0];

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          {/* Brand + Space Switcher */}
          <div className="flex items-center gap-3 min-w-0">
            <img src={chrome.runtime.getURL('options/logo.png')} alt="SessionMesh" className="h-8 w-8 object-contain" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-base font-bold tracking-tight">SessionMesh</span>
                <Badge variant="outline" className="hidden sm:inline-flex text-[10px]">
                  综合管理控制台
                </Badge>
              </div>
              {status?.configured ? (
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  {status.spaces.length > 1 ? (
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex max-w-[160px] items-center gap-1 rounded-full border border-border bg-secondary/70 px-2 py-0.2 text-[11px] font-medium text-foreground hover:bg-secondary">
                          <Layers className="h-3 w-3 shrink-0 text-primary" />
                          <span className="truncate">{status.activeSpaceName || status.activeSpaceId}</span>
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        {status.spaces.map(sp => (
                          <DropdownMenuItem
                            key={sp.spaceId}
                            disabled={sp.spaceId === status.activeSpaceId || switchingSpace}
                            onClick={() => void handleSwitchSpace(sp.spaceId, sp.name)}>
                            <span className="truncate">{sp.name}</span>
                            {sp.spaceId === status.activeSpaceId ? (
                              <Badge variant="default" className="ml-2 px-1 py-0 text-[9px]">
                                当前
                              </Badge>
                            ) : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <Layers className="h-3 w-3" />
                      {status.activeSpaceName || status.activeSpaceId || '默认空间'}
                    </span>
                  )}
                  {status.device?.name ? (
                    <span className="inline-flex items-center gap-1">
                      <Monitor className="h-3 w-3" />
                      {status.device.name}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {/* Global Search (visible when unlocked & in console mode) */}
          {status?.configured && !status.locked && !inWizardMode ? (
            <div className="relative order-3 w-full md:order-2 md:w-72 lg:w-80">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={globalSearch}
                onChange={e => setGlobalSearch(e.target.value)}
                placeholder="全局搜索站点、账号、Cookie、规则、设备..."
                className="h-8 pl-8 pr-7 text-xs bg-background"
              />
              {globalSearch ? (
                <button
                  type="button"
                  onClick={() => setGlobalSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="清除全局搜索">
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Right Quick Actions */}
          <div className="order-2 flex flex-wrap items-center gap-2 md:order-3">
            {status?.configured ? (
              <>
                <Badge variant={getDeviceStatusMeta(status.status, settings?.syncTimingMode).variant}>
                  {getDeviceStatusMeta(status.status, settings?.syncTimingMode).label}
                </Badge>
                {!inWizardMode ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={syncingNow || status.locked}
                      onClick={handleSyncNow}>
                      {syncingNow ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      立即同步
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={openSidePanelFromWindow}>
                      <PanelRightOpen className="mr-1.5 h-3.5 w-3.5" />
                      侧边栏
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={activeSection === 'tutorials' ? 'secondary' : 'ghost'}
                      onClick={() => setActiveSection('tutorials')}>
                      <BookOpen className="mr-1.5 h-3.5 w-3.5" />
                      新手教程
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setForceWizard(true)}>
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      配置向导
                    </Button>
                  </>
                ) : null}
              </>
            ) : null}
            <LanguageDropdown
              localePreference={localePreference}
              resolvedLocale={locale}
              setLocalePreference={setLocalePreference}
            />
            <ThemeDropdown setTheme={setTheme} />
          </div>
        </div>
      </header>

      {/* Main Content */}
      {showInitialLoading ? (
        <div className="flex min-h-[60vh] items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          正在加载 SessionMesh 状态...
        </div>
      ) : inWizardMode ? (
        <OnboardingWizard
          alreadyConfigured={!!status?.configured}
          onOpenTutorials={() => {
            setForceWizard(false);
            setActiveSection('tutorials');
          }}
          onComplete={async () => {
            setForceWizard(false);
            try {
              window.scrollTo({ top: 0, behavior: 'instant' });
            } catch {
              window.scrollTo(0, 0);
            }
            await handleRefreshAll();
          }}
          onCancel={
            status?.configured
              ? () => {
                  if (window.location.search.includes('onboarding=1')) {
                    window.history.replaceState({}, '', window.location.pathname);
                  }
                  setForceWizard(false);
                  try {
                    window.scrollTo({ top: 0, behavior: 'instant' });
                  } catch {
                    window.scrollTo(0, 0);
                  }
                }
              : undefined
          }
        />
      ) : status ? (
        <div className="mx-auto max-w-7xl px-4 py-5">
          {/* Session Lock / Key-Rotation Decrypt Error Card */}
          {status.locked || status.status === 'DECRYPT_ERROR' ? (
            <Card
              className={`mb-5 ${
                status.status === 'DECRYPT_ERROR'
                  ? 'border-destructive/50 bg-destructive/5'
                  : 'border-amber-500/45 bg-amber-500/5'
              }`}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Lock
                    className={`h-5 w-5 ${
                      status.status === 'DECRYPT_ERROR' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'
                    }`}
                  />
                  {status.status === 'DECRYPT_ERROR'
                    ? '需要输入最新端到端主密码以重新解锁'
                    : '同步会话已锁定，请输入端到端主密码解锁'}
                </CardTitle>
                <CardDescription>
                  {status.status === 'DECRYPT_ERROR'
                    ? '检测到空间端到端主密码已变更或校验未通过，请输入最新主密码验证后即可自动恢复同步（本地与云端数据均完好保留）。'
                    : '本地与云端数据均安全保留。验证主密码后将立即恢复自动同步与控制中心全部操作。'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="password"
                    value={unlockPassword}
                    onChange={e => setUnlockPassword(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void handleUnlock();
                    }}
                    placeholder="输入空间端到端加密主密码"
                    className="max-w-md"
                  />
                  <Button type="button" disabled={unlocking} onClick={handleUnlock}>
                    {unlocking ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Unlock className="mr-2 h-4 w-4" />
                    )}
                    {status.status === 'DECRYPT_ERROR' ? '验证并恢复同步' : '解锁会话'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* Latest Error Alert */}
          {status.latestError &&
          status.status !== 'DECRYPT_ERROR' &&
          dismissedErrorTs !== status.latestError.timestamp &&
          (status.attentionItems ?? []).some(
            item =>
              item.kind === 'latest_error' ||
              item.kind === 'auth_error' ||
              item.kind === 'decrypt_error' ||
              item.kind === 'storage_full',
          ) ? (
            <Alert
              variant={
                (status.attentionItems ?? []).some(item => item.severity === 'error') ? 'destructive' : 'default'
              }
              className={`mb-5 ${
                (status.attentionItems ?? []).some(item => item.severity === 'error')
                  ? 'pr-24'
                  : 'border-amber-500/45 bg-amber-500/5 pr-24'
              }`}>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle className="text-sm font-semibold">
                {status.latestError.retryable
                  ? `存储服务暂时繁忙 [${status.latestError.code}] — 后台自动退避重试中`
                  : `同步异常 [${status.latestError.code}] — 本地与云端数据均安全保留`}
              </AlertTitle>
              <AlertDescription className="mt-1 space-y-1 text-xs">
                <p>{status.latestError.message}</p>
                {status.latestError.suggestion ? (
                  <p className="font-medium">处理建议：{status.latestError.suggestion}</p>
                ) : null}
              </AlertDescription>
              <button
                type="button"
                disabled={dismissingError}
                onClick={() => void handleDismissLatestError()}
                className="absolute right-3 top-3 inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="h-3.5 w-3.5" />
                关闭提示
              </button>
            </Alert>
          ) : null}

          {/* Compact Redirect Banner when Pending Site Decisions exist on another tab */}
          {pendingDecisionsCount > 0 && !status.locked && activeSection !== 'sites' ? (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/[0.08] px-4 py-2.5 text-xs text-amber-900 dark:text-amber-200">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>有 {pendingDecisionsCount} 个站点等待确认同步决策（确认前绝不静默覆盖）。</span>
              </div>
              <Button
                type="button"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => {
                  setSitesSubTab('cookies');
                  setActiveSection('sites');
                }}>
                前往网站与 Cookies 处理
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null}

          {/* Local Directory Permission Recovery Redirect Banner */}
          {(status.attentionItems ?? []).some(item => item.kind === 'local_dir_permission_needed') &&
          !(activeSection === 'storage_settings' && storageSubTab === 'webdav') ? (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/45 bg-amber-500/[0.08] px-4 py-2.5 text-xs text-amber-900 dark:text-amber-200">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>本地同步文件夹需要重新授予读写授权后才能继续同步。</span>
              </div>
              <Button
                type="button"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => {
                  setStorageSubTab('webdav');
                  setActiveSection('storage_settings');
                }}>
                前往存储后端恢复授权
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null}

          {/* Interactive 3-Minute Quick Start Checklist (auto-tracks progress & dismissible) */}
          {!status.locked && status.status !== 'DECRYPT_ERROR' && activeSection !== 'tutorials' ? (
            <QuickStartChecklistCard
              refreshSignal={combinedRefreshSignal}
              onJumpToSites={() => {
                setSitesSubTab('cookies');
                setActiveSection('sites');
              }}
              onJumpToPairing={() => {
                setDevicesSubTab('spaces');
                setActiveSection('devices_spaces');
              }}
              onJumpToTutorials={() => {
                setActiveSection('tutorials');
              }}
            />
          ) : null}

          {/* Two-Column Console Shell: Left Sidebar Nav + Wide Workspace */}
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
            {/* Sidebar Navigation */}
            <aside className="w-full shrink-0 lg:sticky lg:top-20 lg:w-60">
              <nav
                aria-label="SessionMesh 综合管理导航"
                className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:flex lg:flex-col lg:gap-1">
                {navItems.map(item => {
                  const active = activeSection === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActiveSection(item.id)}
                      className={`group flex items-start justify-between gap-2 rounded-xl border px-3 py-2.5 text-left transition-all ${
                        active
                          ? 'border-primary/45 bg-primary/[0.08] text-foreground shadow-2xs'
                          : 'border-transparent bg-muted/40 text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground lg:bg-transparent'
                      }`}>
                      <div className="flex items-start gap-2.5 min-w-0">
                        <span
                          className={`mt-0.5 shrink-0 ${
                            active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
                          }`}>
                          {item.icon}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold sm:text-sm">{item.label}</div>
                          <div className="hidden truncate text-[11px] text-muted-foreground lg:block">{item.desc}</div>
                        </div>
                      </div>
                      {item.badge !== undefined ? (
                        <Badge variant={item.badgeVariant || 'secondary'} className="shrink-0 px-1.5 py-0 text-[10px]">
                          {item.badge > 99 ? '99+' : item.badge}
                        </Badge>
                      ) : null}
                    </button>
                  );
                })}
              </nav>
            </aside>

            {/* Right Main Workspace */}
            <main className="min-w-0 flex-1 space-y-4">
              {/* Section Header + Sub-tabs */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
                <div>
                  <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight text-foreground">
                    <span className="text-primary">{activeNavMeta.icon}</span>
                    {activeNavMeta.label}
                  </h1>
                  <p className="mt-0.5 text-xs text-muted-foreground">{activeNavMeta.desc}</p>
                </div>

                {activeSection === 'sites' ? (
                  <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1">
                    <button
                      type="button"
                      onClick={() => setSitesSubTab('cookies')}
                      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        sitesSubTab === 'cookies'
                          ? 'bg-background text-foreground shadow-2xs'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}>
                      <Cookie className="h-3.5 w-3.5" />
                      网站与 Cookies
                    </button>
                    <button
                      type="button"
                      onClick={() => setSitesSubTab('localstorage')}
                      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        sitesSubTab === 'localstorage'
                          ? 'bg-background text-foreground shadow-2xs'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}>
                      <Database className="h-3.5 w-3.5" />
                      LocalStorage
                    </button>
                  </div>
                ) : null}

                {activeSection === 'devices_spaces' ? (
                  <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1">
                    <button
                      type="button"
                      onClick={() => setDevicesSubTab('devices')}
                      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        devicesSubTab === 'devices'
                          ? 'bg-background text-foreground shadow-2xs'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}>
                      <Laptop className="h-3.5 w-3.5" />
                      设备管理与同步策略
                    </button>
                    <button
                      type="button"
                      onClick={() => setDevicesSubTab('spaces')}
                      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        devicesSubTab === 'spaces'
                          ? 'bg-background text-foreground shadow-2xs'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}>
                      <Layers className="h-3.5 w-3.5" />
                      同步空间与跨设备配对
                    </button>
                  </div>
                ) : null}

                {activeSection === 'history_conflicts' ? (
                  <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1">
                    <button
                      type="button"
                      onClick={() => setAuditSubTab('conflicts')}
                      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        auditSubTab === 'conflicts'
                          ? 'bg-background text-foreground shadow-2xs'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}>
                      <GitMerge className="h-3.5 w-3.5" />
                      冲突中心
                      {unresolvedConflictsCount > 0 ? (
                        <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                          {unresolvedConflictsCount}
                        </Badge>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => setAuditSubTab('history')}
                      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        auditSubTab === 'history'
                          ? 'bg-background text-foreground shadow-2xs'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}>
                      <History className="h-3.5 w-3.5" />
                      后悔药与版本日志
                      {undoPointsCount > 0 ? (
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                          {undoPointsCount}
                        </Badge>
                      ) : null}
                    </button>
                  </div>
                ) : null}

                {activeSection === 'storage_settings' ? (
                  <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1">
                    <button
                      type="button"
                      onClick={() => setStorageSubTab('webdav')}
                      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        storageSubTab === 'webdav'
                          ? 'bg-background text-foreground shadow-2xs'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}>
                      <Server className="h-3.5 w-3.5" />
                      存储后端与备份
                    </button>
                    <button
                      type="button"
                      onClick={() => setStorageSubTab('policy')}
                      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        storageSubTab === 'policy'
                          ? 'bg-background text-foreground shadow-2xs'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}>
                      <Settings2 className="h-3.5 w-3.5" />
                      同步策略与安全偏好
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Active Section Body */}
              {status.locked && activeSection !== 'storage_settings' && activeSection !== 'devices_spaces' ? (
                <Card className="border-dashed">
                  <CardContent className="py-10 text-center text-xs text-muted-foreground">
                    当前同步会话已锁定，请先在上方输入端到端加密主密码解锁后再查看与管理数据。
                  </CardContent>
                </Card>
              ) : activeSection === 'sites' ? (
                sitesSubTab === 'cookies' ? (
                  <SitesAndCookiesTab
                    globalSearch={globalSearch}
                    initialSiteKey={initialSiteKey}
                    initialTrackId={initialTrackId}
                    onConsumeInitialSite={() => {
                      setInitialSiteKey(null);
                      setInitialTrackId(null);
                    }}
                    onStatusChanged={handleRefreshAll}
                    refreshSignal={combinedRefreshSignal}
                    layout="wide"
                    onOpenAccounts={handleJumpToAccounts}
                    onOpenLocalStorage={handleJumpToLocalStorage}
                  />
                ) : (
                  <LocalStorageTab
                    globalSearch={globalSearch}
                    filterSiteKey={lsFilter?.siteKey}
                    filterTrackId={lsFilter?.trackId}
                    filterTrackLabel={lsFilter?.trackLabel}
                    onClearFilter={() => setLsFilter(null)}
                    onStatusChanged={handleRefreshAll}
                    refreshSignal={combinedRefreshSignal}
                    layout="wide"
                  />
                )
              ) : activeSection === 'accounts' ? (
                <AccountsManagerTab
                  globalSearch={globalSearch}
                  initialSiteFilter={accountSiteFilter}
                  onConsumeInitialSiteFilter={() => setAccountSiteFilter(null)}
                  onStatusChanged={handleRefreshAll}
                  refreshSignal={combinedRefreshSignal}
                  layout="wide"
                  onOpenLocalStorage={handleJumpToLocalStorage}
                />
              ) : activeSection === 'rules' ? (
                <RulesTab
                  globalSearch={globalSearch}
                  onStatusChanged={handleRefreshAll}
                  refreshSignal={combinedRefreshSignal}
                  layout="wide"
                />
              ) : activeSection === 'devices_spaces' ? (
                devicesSubTab === 'devices' ? (
                  <DevicesTab
                    currentDeviceId={status.device?.deviceId}
                    globalSearch={globalSearch}
                    onStatusChanged={handleRefreshAll}
                    refreshSignal={combinedRefreshSignal}
                    layout="wide"
                  />
                ) : (
                  <SpacesPairingTab status={status} onRefreshStatus={handleRefreshAll} />
                )
              ) : activeSection === 'history_conflicts' ? (
                auditSubTab === 'conflicts' ? (
                  <ConflictsTab
                    globalSearch={globalSearch}
                    onStatusChanged={handleRefreshAll}
                    refreshSignal={combinedRefreshSignal}
                    layout="wide"
                  />
                ) : (
                  <HistoryAndUndoTab
                    globalSearch={globalSearch}
                    onStatusChanged={handleRefreshAll}
                    refreshSignal={combinedRefreshSignal}
                    layout="wide"
                  />
                )
              ) : activeSection === 'tutorials' ? (
                <TutorialsTab
                  onStartWizard={() => setForceWizard(true)}
                  onNavigate={(sec, sub) => {
                    if (sec === 'sites' && sub === 'localstorage') setSitesSubTab('localstorage');
                    else if (sec === 'sites') setSitesSubTab('cookies');
                    if (sec === 'devices_spaces' && sub === 'spaces') setDevicesSubTab('spaces');
                    else if (sec === 'devices_spaces') setDevicesSubTab('devices');
                    if (sec === 'storage_settings' && sub === 'policy') setStorageSubTab('policy');
                    else if (sec === 'storage_settings') setStorageSubTab('webdav');
                    setActiveSection(sec);
                  }}
                />
              ) : storageSubTab === 'webdav' ? (
                <WebDAVTab status={status} onRefreshStatus={handleRefreshAll} />
              ) : (
                <PolicyAdvancedTab status={status} onRefreshStatus={handleRefreshAll} />
              )}
            </main>
          </div>
        </div>
      ) : null}

      {/* Switch Space Password Modal */}
      <Dialog open={!!switchPassSpace} onOpenChange={open => !open && setSwitchPassSpace(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>解锁并切换空间「{switchPassSpace?.name}」</DialogTitle>
            <DialogDescription>目标同步空间尚未在本机解锁，请输入其端到端加密主密码。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="options-switch-space-pass">端到端加密主密码</Label>
            <Input
              id="options-switch-space-pass"
              type="password"
              value={switchPassInput}
              onChange={e => setSwitchPassInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && switchPassSpace) {
                  void handleSwitchSpace(switchPassSpace.spaceId, switchPassSpace.name, switchPassInput);
                }
              }}
              placeholder="输入空间主密码"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={switchingSpace} onClick={() => setSwitchPassSpace(null)}>
              取消
            </Button>
            <Button
              type="button"
              disabled={switchingSpace || !switchPassInput}
              onClick={() =>
                switchPassSpace &&
                void handleSwitchSpace(switchPassSpace.spaceId, switchPassSpace.name, switchPassInput)
              }>
              {switchingSpace ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              确认切换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Toaster theme={theme} position="top-center" richColors visibleToasts={2} toastOptions={{ duration: 2800 }} />
    </div>
  );
};

export default withErrorBoundary(
  withSuspense(
    Options,
    <div className="flex h-screen w-screen items-center justify-center text-sm text-muted-foreground">
      正在加载 SessionMesh 控制中心...
    </div>,
  ),
  <div className="flex h-screen w-screen items-center justify-center p-6 text-sm text-destructive">
    SessionMesh 控制中心渲染异常，请刷新页面重试。
  </div>,
);
