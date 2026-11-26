import {
  envRuleMatchesUrl,
  isDevLikeUrlOrHost,
  type AccountCreateMode,
  type AccountRotationResult,
  type BrowserCandidateSite,
  type EnvCookieSyncResult,
  type EnvCookieSyncRule,
  type SafetyUndoPoint,
  type SiteSummaryView,
  type SiteTrack,
} from '@sessionmesh/core';
import { unwrapCommand, useSessionMeshStatus, useTheme, withErrorBoundary, withSuspense } from '@sessionmesh/shared';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Switch,
  ThemeDropdown,
  Toaster,
} from '@sessionmesh/ui';
import {
  ArrowLeftRight,
  ArrowRight,
  Ban,
  ChevronDown,
  CloudDownload,
  CloudUpload,
  Cookie,
  Database,
  GitBranch,
  Globe,
  Layers,
  Loader2,
  Lock,
  Monitor,
  MoreHorizontal,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Repeat,
  RotateCcw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Unlock,
  UserPlus,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AttentionCenter } from './components/AttentionCenter';
import {
  extractErrorMessage,
  extractFallbackHost,
  formatRelativeTime,
  getBindingBadge,
  getPopupStatusBadge,
  useUiBannerPrefs,
} from './utils/helpers';

const Popup = () => {
  const { theme, setTheme } = useTheme();
  const { isBannerVisible, dismissBanner } = useUiBannerPrefs();
  const [activeTabUrl, setActiveTabUrl] = useState<string | undefined>(undefined);
  const [activeFavIcon, setActiveFavIcon] = useState<string | undefined>(undefined);

  useEffect(() => {
    try {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
        const tab = tabs?.[0];
        if (tab?.url) {
          setActiveTabUrl(tab.url);
        }
        if (tab?.favIconUrl) {
          setActiveFavIcon(tab.favIconUrl);
        }
      });
    } catch {
      // ignore outside extension runtime
    }
  }, []);

  const { status, currentSite, settings, refresh, loading } = useSessionMeshStatus(activeTabUrl);

  // Unlock state
  const [unlockPass, setUnlockPass] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  // Latest undo point
  const [latestUndo, setLatestUndo] = useState<SafetyUndoPoint | null>(null);
  const [applyingUndo, setApplyingUndo] = useState(false);

  // Action busy flags
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncingSiteDir, setSyncingSiteDir] = useState<'push' | 'pull' | null>(null);
  const [togglingPause, setTogglingPause] = useState(false);
  const [trackBusy, setTrackBusy] = useState(false);
  const [managingSite, setManagingSite] = useState(false);

  // Space switch password prompt fallback
  const [switchPassSpace, setSwitchPassSpace] = useState<{ spaceId: string; name: string } | null>(null);
  const [switchPassInput, setSwitchPassInput] = useState('');

  // Multi-account inline creator state
  const [newAcctMode, setNewAcctMode] = useState<AccountCreateMode | null>(null);
  const [newAcctLabel, setNewAcctLabel] = useState('');

  // Dev/Prod Env Sync quick panel state
  const [showEnvQuickPanel, setShowEnvQuickPanel] = useState(false);
  const [managedSitesList, setManagedSitesList] = useState<SiteSummaryView[]>([]);
  const [candidateSitesList, setCandidateSitesList] = useState<BrowserCandidateSite[]>([]);
  const [envSourceSiteKey, setEnvSourceSiteKey] = useState('');
  const [envSourceTrackId, setEnvSourceTrackId] = useState('');
  const [envSyncLs, setEnvSyncLs] = useState(true);
  const [envBusy, setEnvBusy] = useState(false);

  const isDevTab = isDevLikeUrlOrHost(activeTabUrl);

  useEffect(() => {
    if (!status?.configured || status.locked || (!isDevTab && !showEnvQuickPanel)) {
      return;
    }
    void Promise.all([
      unwrapCommand<SiteSummaryView[]>({ type: 'GET_SITES_OVERVIEW' }).catch(() => [] as SiteSummaryView[]),
      unwrapCommand<BrowserCandidateSite[]>({ type: 'SCAN_BROWSER_CANDIDATE_SITES' }).catch(
        () => [] as BrowserCandidateSite[],
      ),
    ]).then(([overview, candidates]) => {
      const validManaged = (overview || []).filter(
        s => s.binding.state !== 'BLACKLISTED' && s.binding.state !== 'UNMANAGED',
      );
      const validCandidates = (candidates || []).filter(c => !c.blacklisted && c.cookieCount > 0);
      setManagedSitesList(validManaged);
      setCandidateSitesList(validCandidates);
      setEnvSourceSiteKey(prev => prev || validManaged[0]?.siteKey || validCandidates[0]?.siteKey || '');
    });
  }, [status?.configured, status?.locked, isDevTab, showEnvQuickPanel]);

  useEffect(() => {
    if (!status?.configured || status.locked || (status.undoPointsCount ?? 0) === 0) {
      setLatestUndo(null);
      return;
    }
    void unwrapCommand<SafetyUndoPoint[]>({ type: 'GET_UNDO_POINTS' })
      .then(list => {
        if (Array.isArray(list) && list.length > 0) {
          setLatestUndo(list[0]);
        } else {
          setLatestUndo(null);
        }
      })
      .catch(() => setLatestUndo(null));
  }, [status?.configured, status?.locked, status?.undoPointsCount]);

  const openOnboarding = () => {
    const onboardingUrl = chrome.runtime.getURL('options/index.html?onboarding=1');
    chrome.tabs.create({ url: onboardingUrl });
  };

  const openOptions = (tab?: string) => {
    if (tab && typeof chrome !== 'undefined' && chrome.runtime?.getURL && chrome.tabs?.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL(`options/index.html?tab=${encodeURIComponent(tab)}`) });
      return;
    }
    chrome.runtime.openOptionsPage();
  };

  const openSidePanel = () => {
    chrome.windows.getCurrent(currentWindow => {
      if (currentWindow?.id !== undefined && chrome.sidePanel) {
        chrome.sidePanel
          .open({ windowId: currentWindow.id })
          .catch(err => toast.error(`无法打开侧边栏：${extractErrorMessage(err)}`));
      }
    });
  };

  const openSidePanelTab = (tab: 'sites' | 'conflicts' | 'history' | 'rules') => {
    chrome.windows.getCurrent(currentWindow => {
      if (currentWindow?.id !== undefined && chrome.sidePanel) {
        chrome.sidePanel
          .open({ windowId: currentWindow.id })
          .then(() => {
            setTimeout(() => {
              chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL_TAB', tab }).catch(() => undefined);
            }, 180);
          })
          .catch(err => toast.error(`无法打开侧边栏：${extractErrorMessage(err)}`));
      }
    });
  };

  const handleUnlock = async () => {
    if (!unlockPass) {
      toast.warning('请输入端到端加密主密码');
      return;
    }
    setUnlocking(true);
    try {
      await unwrapCommand({
        type: 'UNLOCK_SESSION',
        encryptionPassword: unlockPass,
        spaceId: status?.activeSpaceId,
      });
      setUnlockPass('');
      toast.success('已解锁同步会话');
      await refresh();
    } catch (err) {
      toast.error(`解锁失败：${extractErrorMessage(err)}`);
    } finally {
      setUnlocking(false);
    }
  };

  const handleSwitchSpace = async (spaceId: string, name: string, password?: string) => {
    try {
      await unwrapCommand({
        type: 'SWITCH_SPACE',
        spaceId,
        encryptionPassword: password,
      });
      setSwitchPassSpace(null);
      setSwitchPassInput('');
      toast.success(`已切换至空间「${name}」`);
      await refresh();
    } catch (err) {
      const msg = extractErrorMessage(err);
      if (!password && /password|lock|decrypt|密码|解锁/i.test(msg)) {
        setSwitchPassSpace({ spaceId, name });
        setSwitchPassInput('');
      } else {
        toast.error(`切换空间失败：${msg}`);
      }
    }
  };

  const handleSyncNow = async () => {
    setSyncingAll(true);
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
        toast.warning(`WebDAV 云端暂时繁忙，已加入后台自动退避重试：${res.errorMessage}`);
      } else {
        const applied = res?.appliedCookies ?? 0;
        const refreshHint = applied > 0 && !settings?.autoRefresh ? '，刷新对应网页即可生效' : '';
        toast.success(
          `全量同步完成：上传 ${res?.pushedEvents ?? 0}，拉取 ${res?.pulledEvents ?? 0}，应用 ${applied}${refreshHint}`,
        );
      }
      await refresh();
    } catch (err) {
      toast.error(`同步失败：${extractErrorMessage(err)}`);
    } finally {
      setSyncingAll(false);
    }
  };

  const handleSiteSync = async (siteKey: string, direction: 'push' | 'pull') => {
    setSyncingSiteDir(direction);
    try {
      const res = await unwrapCommand<{
        pushedEvents: number;
        pulledEvents: number;
        appliedCookies: number;
        failedCookies: number;
        errorMessage?: string;
        errorCode?: string;
      }>({ type: 'SYNC_NOW', siteKey, direction });
      if (res?.errorMessage) {
        toast.warning(`${siteKey} 暂时无法连接云端，将在后台自动重试：${res.errorMessage}`);
      } else {
        const applied = res?.appliedCookies ?? 0;
        const refreshHint = applied > 0 && !settings?.autoRefresh ? '，刷新页面即可生效' : '';
        toast.success(
          direction === 'push'
            ? `${siteKey} 上传完成（${res?.pushedEvents ?? 0} 条变更）`
            : `${siteKey} 拉取完成（应用 ${applied} 条 Cookie${refreshHint}）`,
        );
      }
      await refresh();
    } catch (err) {
      toast.error(`${direction === 'push' ? '上传' : '拉取'}失败：${extractErrorMessage(err)}`);
    } finally {
      setSyncingSiteDir(null);
    }
  };

  const handleToggleGlobalPause = async (enabled: boolean) => {
    setTogglingPause(true);
    try {
      await unwrapCommand({ type: 'SET_GLOBAL_PAUSED', paused: !enabled });
      // Keep Popup toggle consistent with Options space-level autoSync setting
      if (enabled && settings?.autoSync === false) {
        await unwrapCommand({ type: 'UPDATE_SPACE_SETTINGS', settings: { autoSync: true } });
      }
      toast.success(enabled ? '已恢复全局自动同步' : '已暂停全局自动同步');
      await refresh();
    } catch (err) {
      toast.error(`切换同步状态失败：${extractErrorMessage(err)}`);
    } finally {
      setTogglingPause(false);
    }
  };

  const handleSwitchTrack = async (siteKey: string, trackId: string, label: string) => {
    setTrackBusy(true);
    try {
      await unwrapCommand({ type: 'SWITCH_SITE_TRACK', siteKey, targetTrackId: trackId });
      toast.success(`已切换 ${siteKey} 跟随轨道「${label}」（已保存本地后悔药）`);
      await refresh();
    } catch (err) {
      toast.error(`切换轨道失败：${extractErrorMessage(err)}`);
    } finally {
      setTrackBusy(false);
    }
  };

  const handleSplitIndependent = async (siteKey: string) => {
    setTrackBusy(true);
    try {
      await unwrapCommand({ type: 'SPLIT_SITE_INDEPENDENT', siteKey });
      toast.success(`已将 ${siteKey} 拆分为本机独立轨道`);
      await refresh();
    } catch (err) {
      toast.error(`拆分独立轨道失败：${extractErrorMessage(err)}`);
    } finally {
      setTrackBusy(false);
    }
  };

  const handleRotateAccount = async (siteKey: string) => {
    setTrackBusy(true);
    try {
      const res = await unwrapCommand<AccountRotationResult>({
        type: 'ROTATE_SITE_TRACK',
        siteKey,
        direction: 'next',
      });
      toast.success(`已轮换至账号「${res.track.label}」(${res.index}/${res.total})`);
      await refresh();
    } catch (err) {
      toast.error(`轮换账号失败：${extractErrorMessage(err)}`);
    } finally {
      setTrackBusy(false);
    }
  };

  const handleCreateAccount = async (siteKey: string, mode: AccountCreateMode) => {
    setTrackBusy(true);
    try {
      const created = await unwrapCommand<SiteTrack>({
        type: 'CREATE_SITE_ACCOUNT_TRACK',
        siteKey,
        options: {
          mode,
          label: newAcctLabel.trim() || undefined,
          triggerRefresh: mode === 'clean_new',
        },
      });
      setNewAcctMode(null);
      setNewAcctLabel('');
      toast.success(
        mode === 'clean_new'
          ? `已保存原账号并切换至空白账号「${created.label}」，请在网页直接登录新账号`
          : `已将当前登录态保存为账号「${created.label}」`,
      );
      await refresh();
    } catch (err) {
      toast.error(`创建账号失败：${extractErrorMessage(err)}`);
    } finally {
      setTrackBusy(false);
    }
  };

  const handleDeleteAccountTrack = async (siteKey: string, trackId: string, label: string) => {
    setTrackBusy(true);
    try {
      await unwrapCommand({ type: 'DELETE_SITE_TRACK', siteKey, trackId });
      toast.success(`已移除账号「${label}」`);
      await refresh();
    } catch (err) {
      toast.error(`删除账号失败：${extractErrorMessage(err)}`);
    } finally {
      setTrackBusy(false);
    }
  };

  const handleExecuteEnvRule = async (rule: EnvCookieSyncRule, reverse = false) => {
    setEnvBusy(true);
    try {
      const res = await unwrapCommand<EnvCookieSyncResult>({
        type: 'EXECUTE_ENV_SYNC',
        input: { ruleId: rule.id, reverse },
      });
      const lsHint = res.appliedLocalStorage > 0 ? `、${res.appliedLocalStorage} 项 LS` : '';
      toast.success(
        `环境同步完成：写入 ${res.appliedCookies} 条 Cookie${lsHint}${res.reloadedTabs > 0 ? '，已刷新目标页' : ''}`,
      );
      await refresh();
    } catch (err) {
      toast.error(`环境同步失败：${extractErrorMessage(err)}`);
    } finally {
      setEnvBusy(false);
    }
  };

  const handleQuickPullToDevTab = async (saveAsAutoRule: boolean) => {
    const trimmedSource = envSourceSiteKey.trim();
    if (!trimmedSource || !activeTabUrl) {
      toast.warning('请先选择或输入源环境站点');
      return;
    }
    let targetOrigin = activeTabUrl;
    try {
      targetOrigin = new URL(activeTabUrl).origin;
    } catch {
      // keep raw
    }
    setEnvBusy(true);
    try {
      if (saveAsAutoRule) {
        const saved = await unwrapCommand<EnvCookieSyncRule>({
          type: 'UPSERT_ENV_SYNC_RULE',
          rule: {
            name: `${trimmedSource} → ${targetOrigin}`,
            scope: 'device',
            enabled: true,
            sourceSiteKey: trimmedSource,
            sourceTrackId: envSourceTrackId || undefined,
            targetUrl: targetOrigin,
            syncCookies: true,
            syncLocalStorage: envSyncLs,
            adaptForHttp: true,
            cleanTargetBeforeSync: true,
            autoSync: true,
            autoReloadTarget: true,
          },
        });
        const res = await unwrapCommand<EnvCookieSyncResult>({
          type: 'EXECUTE_ENV_SYNC',
          input: { ruleId: saved.id },
        });
        setShowEnvQuickPanel(false);
        toast.success(`已注入 ${res.appliedCookies} 条 Cookie 到 ${res.targetHost} 并开启自动跟随同步`);
      } else {
        const res = await unwrapCommand<EnvCookieSyncResult>({
          type: 'EXECUTE_ENV_SYNC',
          input: {
            adHoc: {
              sourceSiteKey: trimmedSource,
              sourceTrackId: envSourceTrackId || undefined,
              targetUrl: targetOrigin,
              syncCookies: true,
              syncLocalStorage: envSyncLs,
              adaptForHttp: true,
              cleanTargetBeforeSync: false,
              autoReloadTarget: true,
            },
          },
        });
        toast.success(`单次注入完成：写入 ${res.appliedCookies} 条 Cookie 到 ${res.targetHost}`);
      }
      await refresh();
    } catch (err) {
      toast.error(`跨环境注入失败：${extractErrorMessage(err)}`);
    } finally {
      setEnvBusy(false);
    }
  };

  const handleQuickBlacklist = async (siteKey: string, scope: 'device' | 'space') => {
    setTrackBusy(true);
    try {
      await unwrapCommand({
        type: 'ADD_BLACKLIST_ENTRY',
        entry: {
          pattern: siteKey,
          matchType: 'subdomain',
          scope,
          reason: 'Popup 快捷拉黑',
          presetCategory: 'custom',
        },
      });
      toast.success(`已将 ${siteKey} 加入${scope === 'space' ? '空间级' : '本机级'}黑名单`);
      await refresh();
    } catch (err) {
      toast.error(`拉黑失败：${extractErrorMessage(err)}`);
    } finally {
      setTrackBusy(false);
    }
  };

  const handleAddManagedSite = async (siteKey: string) => {
    setManagingSite(true);
    try {
      await unwrapCommand({
        type: 'ADD_MANAGED_SITES',
        siteKeys: [siteKey],
      });
      toast.success(`已将 ${siteKey} 纳入同步管理并开始同步`);
      await refresh();
    } catch (err) {
      toast.error(`纳入同步管理失败：${extractErrorMessage(err)}`);
    } finally {
      setManagingSite(false);
    }
  };

  const handleRemoveManagedSite = async (siteKey: string, scope: 'device_unmanage' | 'space_remove') => {
    setTrackBusy(true);
    try {
      await unwrapCommand({
        type: 'REMOVE_MANAGED_SITE',
        siteKey,
        scope,
      });
      toast.success(scope === 'space_remove' ? `已从整个同步空间移除 ${siteKey}` : `已将 ${siteKey} 移出本机同步管理`);
      await refresh();
    } catch (err) {
      toast.error(`移出同步管理失败：${extractErrorMessage(err)}`);
    } finally {
      setTrackBusy(false);
    }
  };

  const handleApplyLatestUndo = async () => {
    if (!latestUndo) return;
    setApplyingUndo(true);
    try {
      await unwrapCommand({ type: 'APPLY_UNDO_POINT', undoId: latestUndo.undoId });
      toast.success(`已撤销 ${latestUndo.siteKey} 的上次覆盖并恢复原登录态`);
      await refresh();
    } catch (err) {
      toast.error(`撤销失败：${extractErrorMessage(err)}`);
    } finally {
      setApplyingUndo(false);
    }
  };

  // Loading initial skeleton (prevents flashing onboarding welcome on configured profiles)
  if (loading && !status.configured) {
    return (
      <div className="flex h-[280px] w-[420px] items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        正在连接 SessionMesh...
      </div>
    );
  }

  // Unconfigured Onboarding Welcome Card
  if (!status || !status.configured) {
    return (
      <div className="w-[420px] bg-background text-foreground">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <img src={chrome.runtime.getURL('options/logo.png')} alt="SessionMesh" className="h-7 w-7 object-contain" />
            <span className="text-sm font-bold tracking-tight">SessionMesh</span>
          </div>
          <ThemeDropdown setTheme={setTheme} />
        </header>

        <main className="p-5 text-center space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <ShieldCheck className="h-8 w-8" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-base font-bold">欢迎使用 SessionMesh</h1>
            <p className="text-xs leading-relaxed text-muted-foreground">
              通过你的私有 WebDAV 实现多设备 Cookie 与 LocalStorage
              端到端加密同步，支持多账号独立轨道隔离与自动识别决策。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
            <div className="rounded-lg border border-border bg-muted/30 p-2">AES-256-GCM 强制加密</div>
            <div className="rounded-lg border border-border bg-muted/30 p-2">10 秒配对码接入</div>
            <div className="rounded-lg border border-border bg-muted/30 p-2">多账号独立轨道</div>
          </div>
          <Button type="button" className="w-full" onClick={openOnboarding}>
            开始 4 步快速配置
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </main>
        <Toaster theme={theme} position="top-center" richColors visibleToasts={1} />
      </div>
    );
  }

  const attentionItems = status.attentionItems ?? [];
  const actionableBadgeCount = attentionItems.filter(
    item => item.severity === 'error' || item.severity === 'warning' || item.kind === 'deferred_reload',
  ).length;
  const statusBadge = getPopupStatusBadge(
    status.status,
    status.pendingDecisionsCount,
    actionableBadgeCount,
    settings?.syncTimingMode,
  );
  const isPaused = status.status === 'PAUSED';
  const isGlobalAutoDisabled = isPaused || settings?.autoSync === false;
  const effectiveSiteKey = currentSite?.siteKey || extractFallbackHost(activeTabUrl);
  const summary = currentSite?.summary;
  const isBlacklisted = summary?.binding?.state === 'BLACKLISTED';
  const isUnmanaged = !isBlacklisted && (!summary || summary.binding.state === 'UNMANAGED');
  const bindingBadge = getBindingBadge(summary?.binding?.state);
  const isHttpTab = Boolean(activeTabUrl && /^https?:\/\//i.test(activeTabUrl));
  const allTracks = summary?.allTracks ?? [];
  const activeTrack = summary?.activeTrack;
  const activeTrackIdx = activeTrack ? allTracks.findIndex(t => t.trackId === activeTrack.trackId) : -1;
  const matchingEnvRules = currentSite?.matchingEnvRules ?? [];
  const normalizedEnvSource = envSourceSiteKey
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')
    .replace(/^\.+/, '');
  const selectedEnvSite =
    managedSitesList.find(s => s.siteKey === normalizedEnvSource) ??
    managedSitesList
      .filter(s => normalizedEnvSource.endsWith(`.${s.siteKey}`))
      .sort((a, b) => b.siteKey.length - a.siteKey.length)[0];
  const envSourceSuggestions = (() => {
    const seen = new Set<string>();
    const items: Array<{ siteKey: string; label: string }> = [];
    for (const s of managedSitesList) {
      if (s.siteKey === effectiveSiteKey || seen.has(s.siteKey)) continue;
      seen.add(s.siteKey);
      items.push({ siteKey: s.siteKey, label: `${s.siteKey} (${s.cookieCount}条·已托管)` });
    }
    for (const c of candidateSitesList) {
      if (c.siteKey === effectiveSiteKey || seen.has(c.siteKey)) continue;
      seen.add(c.siteKey);
      items.push({ siteKey: c.siteKey, label: `${c.siteKey} (${c.cookieCount}条·本机已登录)` });
    }
    return items;
  })();
  const favIcon = currentSite?.favIconUrl || summary?.favIconUrl || activeFavIcon;

  return (
    <div className="w-[420px] bg-background text-foreground">
      {/* Top Bar */}
      <header className="flex items-center justify-between gap-2 border-b border-border bg-card/60 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <img
            src={chrome.runtime.getURL('options/logo.png')}
            alt="SessionMesh"
            className="h-7 w-7 shrink-0 object-contain"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold leading-none">SessionMesh</span>
              {status.spaces.length > 1 ? (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex max-w-[120px] items-center gap-0.5 rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground hover:bg-secondary/80">
                      <Layers className="h-2.5 w-2.5 shrink-0" />
                      <span className="truncate">{status.activeSpaceName || status.activeSpaceId}</span>
                      <ChevronDown className="h-2.5 w-2.5 shrink-0" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {status.spaces.map(sp => (
                      <DropdownMenuItem
                        key={sp.spaceId}
                        disabled={sp.spaceId === status.activeSpaceId}
                        onClick={() => handleSwitchSpace(sp.spaceId, sp.name)}>
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
                <Badge variant="secondary" className="max-w-[120px] truncate px-1.5 py-0 text-[10px]">
                  {status.activeSpaceName || status.activeSpaceId || '默认空间'}
                </Badge>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <Monitor className="h-2.5 w-2.5" />
              <span className="truncate max-w-[160px]">{status.device?.name || '本机设备'}</span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Badge variant={statusBadge.variant} className="px-2 py-0.5 text-[11px]">
            {statusBadge.label}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="打开综合管理后台"
            onClick={() => openOptions('sites')}>
            <Settings className="h-4 w-4" />
          </Button>
          <ThemeDropdown setTheme={setTheme} />
        </div>
      </header>

      {/* Locked / Key-Rotation Decrypt Error View */}
      {status.locked || status.status === 'DECRYPT_ERROR' ? (
        <main className="p-4 space-y-3">
          {status.status === 'DECRYPT_ERROR' ? (
            <div className="rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              主密码已变更或校验未通过，请输入最新端到端主密码重新验证（本地与云端加密数据均完好保留）。
            </div>
          ) : null}
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
            <div className="flex items-start gap-2.5">
              <Lock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <div className="text-sm font-semibold">
                  {status.status === 'DECRYPT_ERROR' ? '需要输入最新端到端主密码' : '同步会话已锁定'}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  请输入空间「{status.activeSpaceName || status.activeSpaceId}
                  」的端到端加密主密码以解锁。本地与云端数据均安全保留。
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Input
                type="password"
                value={unlockPass}
                onChange={e => setUnlockPass(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void handleUnlock();
                }}
                placeholder="输入端到端主密码"
                className="h-9 text-xs"
              />
              <Button type="button" size="sm" disabled={unlocking} onClick={handleUnlock} className="h-9 shrink-0">
                {unlocking ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Unlock className="mr-1 h-3.5 w-3.5" />
                )}
                解锁
              </Button>
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => openOptions('storage_settings')}
              className="text-xs">
              前往综合管理后台
            </Button>
          </div>
        </main>
      ) : (
        <main className="space-y-3 p-3.5">
          {/* Switch Space Password Inline Prompt (if switching to locked space) */}
          {switchPassSpace ? (
            <div className="rounded-lg border border-primary/40 bg-primary/5 p-2.5 space-y-2 text-xs">
              <div className="font-medium">输入空间「{switchPassSpace.name}」的端到端主密码：</div>
              <div className="flex gap-1.5">
                <Input
                  type="password"
                  value={switchPassInput}
                  onChange={e => setSwitchPassInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      void handleSwitchSpace(switchPassSpace.spaceId, switchPassSpace.name, switchPassInput);
                    }
                  }}
                  className="h-8 text-xs"
                  placeholder="主密码"
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => handleSwitchSpace(switchPassSpace.spaceId, switchPassSpace.name, switchPassInput)}>
                  确认
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={() => setSwitchPassSpace(null)}>
                  取消
                </Button>
              </div>
            </div>
          ) : null}

          {/* Direct Actionable Attention Center (Auto-Expanded whenever `!` / `?` / pending items exist) */}
          <AttentionCenter
            items={attentionItems}
            pendingDecisionsCount={status.pendingDecisionsCount}
            activeSpaceId={status.activeSpaceId}
            currentSiteKey={effectiveSiteKey}
            onRefresh={refresh}
            onOpenOptions={() => openOptions('storage_settings')}
            onOpenSidePanelTab={openSidePanelTab}
          />

          {/* Current Site Card */}
          <section className="rounded-xl border border-border bg-card p-3.5 space-y-3 shadow-sm">
            {isHttpTab && effectiveSiteKey ? (
              isUnmanaged ? (
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      {favIcon ? (
                        <img
                          src={favIcon}
                          alt=""
                          className="h-7 w-7 shrink-0 rounded-md border border-border object-contain p-0.5"
                        />
                      ) : (
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                          <Globe className="h-4 w-4" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h3 className="truncate text-sm font-bold text-foreground">{effectiveSiteKey}</h3>
                          <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                            未纳管
                          </Badge>
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">仅本地浏览 · 未开启云端同步</div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                    当前网站 <strong className="text-foreground">{effectiveSiteKey}</strong>{' '}
                    未纳入同步管理（仅本地浏览，不上传同步）
                  </div>

                  <div className="flex flex-col gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={managingSite || trackBusy}
                      onClick={() => void handleAddManagedSite(effectiveSiteKey)}
                      className="h-9 w-full text-xs font-semibold">
                      {managingSite ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      将 {effectiveSiteKey} 纳入同步管理
                    </Button>

                    <div className="flex items-center justify-end">
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={trackBusy || managingSite}
                            className="h-7 px-2.5 text-[11px] text-muted-foreground hover:text-destructive">
                            <Ban className="mr-1 h-3.5 w-3.5" />
                            加入黑名单
                            <ChevronDown className="ml-1 h-3 w-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleQuickBlacklist(effectiveSiteKey, 'device')}>
                            加入本机黑名单（仅本电脑不同步）
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleQuickBlacklist(effectiveSiteKey, 'space')}>
                            加入空间黑名单（全设备不同步）
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      {favIcon ? (
                        <img
                          src={favIcon}
                          alt=""
                          className="h-7 w-7 shrink-0 rounded-md border border-border object-contain p-0.5"
                        />
                      ) : (
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                          <Globe className="h-4 w-4" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h3 className="truncate text-sm font-bold text-foreground">{effectiveSiteKey}</h3>
                          <Badge variant={bindingBadge.variant} className="shrink-0 px-1.5 py-0 text-[10px]">
                            {bindingBadge.label}
                          </Badge>
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          最近同步：{formatRelativeTime(summary?.updatedAt || status.lastSyncAt)}
                        </div>
                      </div>
                    </div>

                    {/* Site Management & Blacklist Dropdown */}
                    {!isBlacklisted ? (
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={trackBusy}
                            className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground">
                            <MoreHorizontal className="mr-1 h-3.5 w-3.5" />
                            管理
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => void handleRemoveManagedSite(effectiveSiteKey, 'device_unmanage')}>
                            移出同步管理（仅本机停止）
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => void handleRemoveManagedSite(effectiveSiteKey, 'space_remove')}>
                            从全空间移除该网站
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => handleQuickBlacklist(effectiveSiteKey, 'device')}>
                            加入本机黑名单（仅本电脑不同步）
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleQuickBlacklist(effectiveSiteKey, 'space')}>
                            加入空间黑名单（全设备不同步）
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>

                  {/* Rolling-token damper notice (closable & persistent) */}
                  {summary?.rollingTokenDamped && isBannerVisible('popup_rolling_token_warn', 'degraded') ? (
                    <div className="relative flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-2.5 py-2 pr-14 text-[11px] text-amber-900 dark:text-amber-200">
                      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                      <span>
                        检测到该站点高频滚动令牌交替抢写，已自动开启防互踢阻尼保护（优先保留当前前台设备提交）。
                      </span>
                      <button
                        type="button"
                        onClick={() => void dismissBanner('popup_rolling_token_warn')}
                        className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] hover:bg-amber-500/20">
                        不再提示
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ) : null}

                  {/* Multi-Account Switcher, One-Click Rotation & New Account Controls */}
                  {!isBlacklisted ? (
                    <div className="rounded-lg bg-muted/40 px-2.5 py-2 text-xs space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <div className="min-w-0 flex-1">
                          <span className="text-[11px] text-muted-foreground">当前账号：</span>
                          <span className="font-medium text-foreground break-words">
                            {activeTrack?.label ||
                              (summary?.binding?.state === 'PENDING_CHOICE' ? '待选择账号轨道' : '默认主账号')}
                          </span>
                          {allTracks.length > 1 && activeTrackIdx >= 0 ? (
                            <span className="ml-1 rounded bg-primary/15 px-1 py-0.5 text-[10px] font-semibold text-primary">
                              {activeTrackIdx + 1}/{allTracks.length}
                            </span>
                          ) : activeTrack ? (
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              ({activeTrack.memberDeviceIds.length} 设备)
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {allTracks.length > 1 ? (
                            <>
                              <Button
                                type="button"
                                variant="default"
                                size="sm"
                                disabled={trackBusy}
                                onClick={() => void handleRotateAccount(effectiveSiteKey)}
                                className="h-6 px-2 text-[11px]"
                                title="按顺序一键轮换到下一个账号并刷新页面">
                                <Repeat className="mr-1 h-3 w-3" />
                                轮换
                              </Button>
                              <DropdownMenu modal={false}>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={trackBusy}
                                    className="h-6 px-2 text-[11px]">
                                    账号列表
                                    <ChevronDown className="ml-1 h-3 w-3" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-56">
                                  {allTracks.map((track, idx) => (
                                    <DropdownMenuItem
                                      key={track.trackId}
                                      className="flex items-center justify-between gap-2"
                                      onClick={() => {
                                        if (track.trackId !== activeTrack?.trackId) {
                                          void handleSwitchTrack(effectiveSiteKey, track.trackId, track.label);
                                        }
                                      }}>
                                      <div className="min-w-0 flex-1 flex flex-col">
                                        <span className="truncate text-xs font-medium">
                                          #{idx + 1} {track.label}{' '}
                                          {track.trackId === activeTrack?.trackId ? '(当前)' : ''}
                                        </span>
                                        <span className="text-[10px] text-muted-foreground">
                                          {track.cookieCount} Cookie · {track.originDeviceName}
                                        </span>
                                      </div>
                                      {allTracks.length > 1 ? (
                                        <button
                                          type="button"
                                          title={`删除账号「${track.label}」`}
                                          onClick={e => {
                                            e.stopPropagation();
                                            void handleDeleteAccountTrack(effectiveSiteKey, track.trackId, track.label);
                                          }}
                                          className="rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive">
                                          <Trash2 className="h-3 w-3" />
                                        </button>
                                      ) : null}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </>
                          ) : null}

                          <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={trackBusy}
                                className="h-6 px-2 text-[11px]">
                                <UserPlus className="mr-1 h-3 w-3" />
                                新账号
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => {
                                  setNewAcctMode('clean_new');
                                  setNewAcctLabel('');
                                }}>
                                <div className="flex flex-col">
                                  <span className="text-xs font-medium">新建空白账号（清空页面登录新号）</span>
                                  <span className="text-[10px] text-muted-foreground">
                                    自动保留当前账号会话，不触发服务端注销
                                  </span>
                                </div>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  setNewAcctMode('save_current');
                                  setNewAcctLabel('');
                                }}>
                                <div className="flex flex-col">
                                  <span className="text-xs font-medium">将当前登录态另存为新账号</span>
                                  <span className="text-[10px] text-muted-foreground">
                                    复制当前浏览器 Cookie 创建新账号轨道
                                  </span>
                                </div>
                              </DropdownMenuItem>
                              {summary?.binding?.state !== 'INDEPENDENT' ? (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => void handleSplitIndependent(effectiveSiteKey)}>
                                    <GitBranch className="mr-1.5 h-3.5 w-3.5" />
                                    <span className="text-xs">拆分为本机独立轨道</span>
                                  </DropdownMenuItem>
                                </>
                              ) : null}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => openOptions('accounts')}>
                                <Layers className="mr-1.5 h-3.5 w-3.5" />
                                <span className="text-xs">打开多账号管理中心...</span>
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>

                      {newAcctMode ? (
                        <div className="flex items-center gap-1.5 pt-1 border-t border-border/60">
                          <Input
                            value={newAcctLabel}
                            onChange={e => setNewAcctLabel(e.target.value)}
                            placeholder={
                              newAcctMode === 'clean_new'
                                ? '新空白账号名称（如 测试小号B，回车创建）'
                                : '保存账号名称（如 管理员主号）'
                            }
                            onKeyDown={e => {
                              if (e.key === 'Enter') void handleCreateAccount(effectiveSiteKey, newAcctMode);
                              if (e.key === 'Escape') setNewAcctMode(null);
                            }}
                            className="h-7 text-xs bg-background"
                          />
                          <Button
                            type="button"
                            size="sm"
                            disabled={trackBusy}
                            onClick={() => void handleCreateAccount(effectiveSiteKey, newAcctMode)}
                            className="h-7 px-2.5 text-[11px] shrink-0">
                            {newAcctMode === 'clean_new' ? '清空并切换' : '保存'}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setNewAcctMode(null)}
                            className="h-7 px-1.5 text-[11px] shrink-0">
                            取消
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Metrics Grid */}
                  <div className="grid grid-cols-4 gap-1.5 text-center">
                    <div className="rounded-lg border border-border/70 bg-background px-1.5 py-1.5">
                      <div className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground">
                        <Cookie className="h-3 w-3" />
                        Cookie
                      </div>
                      <div className="mt-0.5 text-sm font-bold">{summary?.cookieCount ?? 0}</div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background px-1.5 py-1.5">
                      <div className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground">
                        <Database className="h-3 w-3" />
                        LS
                      </div>
                      <div className="mt-0.5 text-sm font-bold">{summary?.localStorageCount ?? 0}</div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background px-1.5 py-1.5">
                      <div className="text-[10px] text-muted-foreground">待上传</div>
                      <div className="mt-0.5 text-sm font-bold text-primary">{status.pendingUploads}</div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background px-1.5 py-1.5">
                      <div className="text-[10px] text-muted-foreground">待应用</div>
                      <div className="mt-0.5 text-sm font-bold text-sky-600 dark:text-sky-400">
                        {status.pendingApplies}
                      </div>
                    </div>
                  </div>

                  {/* Current Site Push / Pull */}
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!!syncingSiteDir || syncingAll || isBlacklisted}
                      onClick={() => handleSiteSync(effectiveSiteKey, 'push')}
                      className="h-8 text-xs">
                      {syncingSiteDir === 'push' ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CloudUpload className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      当前网站上传
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!!syncingSiteDir || syncingAll || isBlacklisted}
                      onClick={() => handleSiteSync(effectiveSiteKey, 'pull')}
                      className="h-8 text-xs">
                      {syncingSiteDir === 'pull' ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CloudDownload className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      当前网站拉取
                    </Button>
                  </div>
                </>
              )
            ) : (
              <div className="flex items-center justify-between py-1 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4" />
                  <span>当前标签页非网页站点（无法执行单站操作）</span>
                </div>
                <span className="shrink-0 text-[11px]">
                  待上传 {status.pendingUploads} · 待应用 {status.pendingApplies}
                </span>
              </div>
            )}

            {/* Dev <-> Prod Environment Cookie Sync Quick Bar (works on localhost/dev & matched prod sites!) */}
            {isHttpTab && (matchingEnvRules.length > 0 || isDevTab || showEnvQuickPanel) ? (
              <div className="rounded-lg border border-primary/25 bg-primary/[0.04] p-2.5 text-xs space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 font-semibold text-foreground">
                    <ArrowLeftRight className="h-3.5 w-3.5 text-primary" />
                    开发 / 生产环境 Cookie 同步
                  </span>
                  <div className="flex items-center gap-1">
                    {!isDevTab && matchingEnvRules.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setShowEnvQuickPanel(prev => !prev)}
                        className="text-[11px] text-primary hover:underline">
                        {showEnvQuickPanel ? '收起' : '向当前页注入'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => openSidePanelTab('rules')}
                      className="text-[11px] text-muted-foreground hover:text-foreground">
                      管理规则
                    </button>
                  </div>
                </div>

                {matchingEnvRules.length > 0 ? (
                  <div className="space-y-1.5">
                    {matchingEnvRules.map(rule => {
                      const role = activeTabUrl ? envRuleMatchesUrl(rule, activeTabUrl) : null;
                      return (
                        <div
                          key={rule.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-background px-2 py-1.5">
                          <div className="min-w-0">
                            <div className="truncate font-medium text-[11px]">
                              {rule.sourceHostFilter || rule.sourceSiteKey} → {rule.targetUrl}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {role === 'target' ? '当前为目标环境' : '当前为源环境'} ·{' '}
                              {!rule.enabled ? '规则已禁用' : rule.autoSync ? '自动跟随开启' : '手动同步'}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              type="button"
                              size="sm"
                              variant="default"
                              disabled={envBusy}
                              onClick={() => void handleExecuteEnvRule(rule, false)}
                              className="h-6 px-2 text-[11px]">
                              同步
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={envBusy}
                              onClick={() => void handleExecuteEnvRule(rule, true)}
                              title="反向同步一次（从目标环境写回源环境）"
                              className="h-6 px-1.5 text-[10px]">
                              反向
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {(isDevTab || showEnvQuickPanel) && (
                  <div className="space-y-1.5 pt-1 border-t border-border/50">
                    <div className="text-[11px] text-muted-foreground">
                      将线上/测试环境登录态一键重写注入当前页（自动适配 HTTP / localhost 属性）：
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <div>
                        <Input
                          list="popup-env-source-sites"
                          aria-label="选择或输入源环境站点"
                          value={envSourceSiteKey}
                          onChange={e => {
                            setEnvSourceSiteKey(e.target.value);
                            setEnvSourceTrackId('');
                          }}
                          placeholder="选择或输入源域名..."
                          className="h-7 px-2 text-[11px] font-mono"
                        />
                        <datalist id="popup-env-source-sites">
                          {envSourceSuggestions.map(item => (
                            <option key={item.siteKey} value={item.siteKey}>
                              {item.label}
                            </option>
                          ))}
                        </datalist>
                      </div>
                      <select
                        aria-label="选择源站点账号轨道"
                        value={envSourceTrackId}
                        onChange={e => setEnvSourceTrackId(e.target.value)}
                        className="h-7 rounded border border-input bg-background px-1.5 text-[11px] text-foreground">
                        <option value="">跟随当前激活账号</option>
                        {(selectedEnvSite?.allTracks ?? []).map(tr => (
                          <option key={tr.trackId} value={tr.trackId}>
                            账号：{tr.label} ({tr.cookieCount}条)
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <input
                          id="popup-env-sync-ls"
                          type="checkbox"
                          checked={envSyncLs}
                          onChange={e => setEnvSyncLs(e.target.checked)}
                          className="h-3.5 w-3.5 rounded accent-primary"
                        />
                        <label htmlFor="popup-env-sync-ls" className="cursor-pointer">
                          含 LocalStorage
                        </label>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={envBusy || !envSourceSiteKey.trim()}
                          onClick={() => void handleQuickPullToDevTab(false)}
                          className="h-6 px-2 text-[11px]">
                          单次注入
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="default"
                          disabled={envBusy || !envSourceSiteKey.trim()}
                          onClick={() => void handleQuickPullToDevTab(true)}
                          className="h-6 px-2 text-[11px]">
                          注入并自动同步
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : isHttpTab && effectiveSiteKey ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowEnvQuickPanel(true)}
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary">
                  <ArrowLeftRight className="h-3 w-3" />
                  跨环境同步 Cookie 到当前页...
                </button>
              </div>
            ) : null}
          </section>

          {/* Quick Undo Bar */}
          {status.undoPointsCount > 0 && latestUndo ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-sky-500/35 bg-sky-500/10 px-3 py-2 text-xs">
              <div className="min-w-0">
                <span className="font-medium text-foreground">本地后悔药可用：</span>
                <span className="truncate text-muted-foreground">{latestUndo.siteKey}</span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={applyingUndo}
                onClick={handleApplyLatestUndo}
                className="h-7 shrink-0 bg-background px-2 text-[11px]">
                {applyingUndo ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="mr-1 h-3 w-3" />
                )}
                撤销上次覆盖
              </Button>
            </div>
          ) : null}

          {/* Global Controls */}
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2">
              <div>
                <div className="text-xs font-semibold">全局自动同步</div>
                <div className="text-[10px] text-muted-foreground">
                  {isPaused
                    ? '当前已暂停自动上传与拉取'
                    : settings?.autoSync === false
                      ? '空间自动同步已关闭（仅手动同步）'
                      : status.pendingUploads > 0
                        ? settings?.syncTimingMode === 'on_page_leave'
                          ? `离开/关闭页面时自动上传（已暂存 ${status.pendingUploads} 条）`
                          : `自动运行中 · ${status.pendingUploads} 条变更正在后台自动上传`
                        : `${settings?.syncTimingMode === 'on_page_leave' ? '离开页面时上传' : '实时自动同步'} · 上次同步 ${formatRelativeTime(status.lastSyncAt)}`}
                </div>
              </div>
              <Switch
                checked={!isGlobalAutoDisabled}
                disabled={togglingPause}
                onCheckedChange={handleToggleGlobalPause}
              />
            </div>

            <Button type="button" className="w-full h-9 text-xs" disabled={syncingAll} onClick={handleSyncNow}>
              {syncingAll ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-4 w-4" />
              )}
              立即全量同步
            </Button>

            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={openSidePanel} className="h-8 text-xs">
                <PanelRightOpen className="mr-1.5 h-3.5 w-3.5" />
                打开侧边栏
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openOptions('sites')}
                className="h-8 text-xs">
                <Settings className="mr-1.5 h-3.5 w-3.5" />
                综合管理后台
              </Button>
            </div>
          </div>
        </main>
      )}

      <Toaster
        theme={theme}
        closeButton
        toastOptions={{ duration: 2200 }}
        visibleToasts={1}
        richColors
        position="top-center"
      />
    </div>
  );
};

export default withErrorBoundary(
  withSuspense(
    Popup,
    <div className="flex h-[240px] w-[420px] items-center justify-center text-xs text-muted-foreground">
      正在加载 SessionMesh...
    </div>,
  ),
  <div className="flex h-[240px] w-[420px] items-center justify-center p-4 text-xs text-destructive">
    Popup 加载异常，请重新打开。
  </div>,
);
