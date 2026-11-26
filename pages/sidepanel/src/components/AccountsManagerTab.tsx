import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import {
  downloadJsonFile,
  formatRelativeTime,
  getBindingMeta,
  normalizeManualSiteKey,
  parseImportedCookiesJson,
  shortId,
} from '@console/lib/format';
import type {
  AccountCreateMode,
  BrowserCandidateSite,
  EnvCookieSyncRule,
  SiteSummaryView,
  SiteTrack,
} from '@sessionmesh/shared';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Switch,
} from '@sessionmesh/ui';
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  CheckCircle2,
  ChevronLeft,
  Cookie,
  Database,
  Download,
  Edit3,
  Globe,
  Laptop,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  StickyNote,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from './common/Badge';
import { EmptyState } from './common/EmptyState';
import { JsonImportModal } from './common/JsonImportModal';
import { Modal } from './common/Modal';
import { CookieDetailView } from './CookieDetailView';
import { LocalStorageTab } from './LocalStorageTab';

export interface AccountsManagerTabProps {
  globalSearch: string;
  initialSiteFilter?: string | null;
  onConsumeInitialSiteFilter?: () => void;
  onStatusChanged: () => Promise<void> | void;
  refreshSignal: number;
  layout?: 'compact' | 'wide';
  onOpenLocalStorage?: (siteKey: string, trackId?: string, trackLabel?: string) => void;
}

type AccountFilterMode = 'all' | 'multi' | 'single';

const SiteFaviconSmall: React.FC<{ url?: string; siteKey: string }> = ({ url, siteKey }) => {
  const [failed, setFailed] = useState(false);
  const src = url || `https://${siteKey}/favicon.ico`;
  if (failed) {
    return (
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Globe className="h-3.5 w-3.5" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className="h-6 w-6 shrink-0 rounded-md border border-border/60 bg-background object-contain p-0.5"
      onError={() => setFailed(true)}
    />
  );
};

export const AccountsManagerTab: React.FC<AccountsManagerTabProps> = ({
  globalSearch,
  initialSiteFilter,
  onConsumeInitialSiteFilter,
  onStatusChanged,
  refreshSignal,
  layout = 'compact',
  onOpenLocalStorage,
}) => {
  const [sites, setSites] = useState<SiteSummaryView[]>([]);
  const [candidates, setCandidates] = useState<BrowserCandidateSite[]>([]);
  const [envRules, setEnvRules] = useState<EnvCookieSyncRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [localSearch, setLocalSearch] = useState('');
  const [filterMode, setFilterMode] = useState<AccountFilterMode>('all');

  // Inline drill-downs
  const [inspectCookiesTarget, setInspectCookiesTarget] = useState<{ siteKey: string; trackId: string } | null>(null);
  const [inspectLsTarget, setInspectLsTarget] = useState<{
    siteKey: string;
    trackId: string;
    label: string;
  } | null>(null);

  // Create Account Modal
  const [createOpen, setCreateOpen] = useState(false);
  const [createSiteKey, setCreateSiteKey] = useState('');
  const [createSiteLocked, setCreateSiteLocked] = useState(false);
  const [createMode, setCreateMode] = useState<AccountCreateMode>('clean_new');
  const [createLabel, setCreateLabel] = useState('');
  const [createNote, setCreateNote] = useState('');

  // Edit Account Name & Note Modal
  const [editTarget, setEditTarget] = useState<{
    siteKey: string;
    trackId: string;
    label: string;
    accountNote: string;
  } | null>(null);

  // Delete Account Confirm Modal
  const [deleteTarget, setDeleteTarget] = useState<{
    siteKey: string;
    track: SiteTrack;
    isActive: boolean;
    remainingCount: number;
  } | null>(null);

  // Account-Scoped Cookie JSON Import Modal
  const [importTarget, setImportTarget] = useState<{
    siteKey: string;
    trackId: string;
    label: string;
  } | null>(null);

  // Account-Scoped Dev <-> Prod Env Sync Modal
  const [envModalTarget, setEnvModalTarget] = useState<{
    siteKey: string;
    track: SiteTrack;
  } | null>(null);
  const [envTargetUrl, setEnvTargetUrl] = useState('http://localhost:3000');
  const [envRuleScope, setEnvRuleScope] = useState<'device' | 'space'>('device');
  const [envSyncLs, setEnvSyncLs] = useState(true);
  const [envAdaptHttp, setEnvAdaptHttp] = useState(true);
  const [envCleanTarget, setEnvCleanTarget] = useState(true);
  const [envAutoSync, setEnvAutoSync] = useState(true);
  const [envAutoReload, setEnvAutoReload] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [overview, rulesData, candidateList] = await Promise.all([
        sidePanelApi.getSitesOverview(),
        sidePanelApi.getRulesAndBlacklist().catch(() => null),
        sidePanelApi.scanBrowserCandidateSites().catch(() => [] as BrowserCandidateSite[]),
      ]);
      setSites((overview || []).filter(s => s.binding.state !== 'BLACKLISTED'));
      setEnvRules(rulesData?.envSyncRules ?? []);
      setCandidates((candidateList || []).filter(c => !c.blacklisted && c.cookieCount > 0));
    } catch (err) {
      toast.error(`加载多账号数据失败：${extractErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll, refreshSignal]);

  useEffect(() => {
    if (initialSiteFilter) {
      setLocalSearch(initialSiteFilter);
      setFilterMode('all');
      onConsumeInitialSiteFilter?.();
    }
  }, [initialSiteFilter, onConsumeInitialSiteFilter]);

  const handleAfterMutation = async () => {
    await loadAll();
    await onStatusChanged();
  };

  // --- Computed Metrics ---
  const stats = useMemo(() => {
    const activeSites = sites.filter(s => s.binding.state !== 'UNMANAGED');
    const totalTracks = activeSites.reduce((sum, s) => sum + s.allTracks.length, 0);
    const multiAccountSites = activeSites.filter(s => s.allTracks.length >= 2).length;
    return {
      sitesCount: activeSites.length,
      totalTracks,
      multiAccountSites,
      envRulesCount: envRules.length,
    };
  }, [sites, envRules]);

  const effectiveQuery = (localSearch || globalSearch).trim().toLowerCase();

  const filteredSites = useMemo(() => {
    return sites
      .filter(s => s.binding.state !== 'UNMANAGED' || s.allTracks.length > 0)
      .filter(s => {
        if (filterMode === 'multi' && s.allTracks.length < 2) return false;
        if (filterMode === 'single' && s.allTracks.length >= 2) return false;
        if (!effectiveQuery) return true;
        return (
          s.siteKey.toLowerCase().includes(effectiveQuery) ||
          s.allTracks.some(
            tr =>
              tr.label.toLowerCase().includes(effectiveQuery) ||
              (tr.accountNote || '').toLowerCase().includes(effectiveQuery) ||
              tr.originDeviceName.toLowerCase().includes(effectiveQuery),
          )
        );
      })
      .sort((a, b) => {
        // Multi-account sites surface first, then most recently updated
        const multiDiff = Number(b.allTracks.length >= 2) - Number(a.allTracks.length >= 2);
        if (multiDiff !== 0) return multiDiff;
        if (b.allTracks.length !== a.allTracks.length) return b.allTracks.length - a.allTracks.length;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
  }, [sites, filterMode, effectiveQuery]);

  const siteSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ siteKey: string; desc: string }> = [];
    for (const s of sites) {
      if (seen.has(s.siteKey)) continue;
      seen.add(s.siteKey);
      list.push({ siteKey: s.siteKey, desc: `已纳管 · ${s.allTracks.length} 个账号` });
    }
    for (const c of candidates) {
      if (seen.has(c.siteKey)) continue;
      seen.add(c.siteKey);
      list.push({ siteKey: c.siteKey, desc: `本机已登录 · ${c.cookieCount} Cookie` });
    }
    return list;
  }, [sites, candidates]);

  // --- Handlers ---
  const openCreateModal = (presetSiteKey?: string) => {
    setCreateSiteKey(presetSiteKey || sites[0]?.siteKey || candidates[0]?.siteKey || '');
    setCreateSiteLocked(Boolean(presetSiteKey));
    setCreateMode('clean_new');
    setCreateLabel('');
    setCreateNote('');
    setCreateOpen(true);
  };

  const handleConfirmCreateAccount = async () => {
    const normSite = normalizeManualSiteKey(createSiteKey) || createSiteKey.trim().toLowerCase();
    if (!normSite) {
      toast.warning('请选择或输入目标站点域名（如 github.com）');
      return;
    }
    setBusyKey(`create:${normSite}`);
    try {
      const created = await sidePanelApi.createSiteAccountTrack(normSite, {
        mode: createMode,
        label: createLabel.trim() || undefined,
        accountNote: createNote.trim() || undefined,
        triggerRefresh: createMode === 'clean_new',
      });
      toast.success(
        createMode === 'clean_new'
          ? `已保存原账号并切换至空白账号「${created.label}」，请在网页直接登录新账号`
          : `已将 ${normSite} 当前登录态另存为账号「${created.label}」`,
      );
      setCreateOpen(false);
      await handleAfterMutation();
    } catch (err) {
      toast.error(`新增账号失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleSwitchAccount = async (siteKey: string, track: SiteTrack) => {
    setBusyKey(`switch:${track.trackId}`);
    try {
      await sidePanelApi.switchSiteTrack(siteKey, track.trackId);
      toast.success(`已切换 ${siteKey} 至账号「${track.label}」（已自动保存后悔药）`);
      await handleAfterMutation();
    } catch (err) {
      toast.error(`切换账号失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRotateSite = async (siteKey: string) => {
    setBusyKey(`rotate:${siteKey}`);
    try {
      const res = await sidePanelApi.rotateSiteTrack(siteKey, 'next');
      toast.success(`${siteKey} 已轮换至账号「${res.track.label}」(${res.index}/${res.total})`);
      await handleAfterMutation();
    } catch (err) {
      toast.error(`轮换账号失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleMoveTrackOrder = async (site: SiteSummaryView, trackId: string, delta: -1 | 1) => {
    const ids = site.allTracks.map(t => t.trackId);
    const idx = ids.indexOf(trackId);
    const nextIdx = idx + delta;
    if (idx < 0 || nextIdx < 0 || nextIdx >= ids.length) return;
    const reordered = [...ids];
    const [moved] = reordered.splice(idx, 1);
    reordered.splice(nextIdx, 0, moved);

    setBusyKey(`reorder:${trackId}`);
    try {
      await sidePanelApi.reorderSiteTracks(site.siteKey, reordered);
      toast.success(`已调整 ${site.siteKey} 的多账号轮换顺序`);
      await handleAfterMutation();
    } catch (err) {
      toast.error(`调整顺序失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleConfirmEditAccount = async () => {
    if (!editTarget || !editTarget.label.trim()) return;
    setBusyKey(`edit:${editTarget.trackId}`);
    try {
      await sidePanelApi.updateSiteTrack(editTarget.siteKey, editTarget.trackId, {
        label: editTarget.label.trim(),
        accountNote: editTarget.accountNote.trim(),
      });
      toast.success('账号名称与备注已保存');
      setEditTarget(null);
      await handleAfterMutation();
    } catch (err) {
      toast.error(`更新账号信息失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleConfirmDeleteAccount = async () => {
    if (!deleteTarget) return;
    const { siteKey, track } = deleteTarget;
    setBusyKey(`delete:${track.trackId}`);
    try {
      const res = await sidePanelApi.deleteSiteTrack(siteKey, track.trackId);
      toast.success(
        res.switchedToTrack
          ? `已删除账号「${track.label}」，并自动切回「${res.switchedToTrack.label}」`
          : `已删除账号「${track.label}」`,
      );
      setDeleteTarget(null);
      await handleAfterMutation();
    } catch (err) {
      toast.error(`删除账号失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleExportAccountCookies = async (siteKey: string, track: SiteTrack) => {
    setBusyKey(`export:${track.trackId}`);
    try {
      const exported = await sidePanelApi.exportCookiesJson(siteKey, track.trackId);
      const safeLabel = track.label.replace(/[^\w\u4e00-\u9fa5-]+/g, '_');
      downloadJsonFile(`sessionmesh-${siteKey}-${safeLabel}.json`, exported);
      toast.success(`已导出账号「${track.label}」的 ${exported.length} 条 Cookie`);
    } catch (err) {
      toast.error(`导出失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleImportAccountCookies = async (parsed: unknown) => {
    if (!importTarget) return;
    const normalized = parseImportedCookiesJson(parsed, importTarget.siteKey);
    const count = await sidePanelApi.importCookiesJson(normalized, importTarget.siteKey, importTarget.trackId);
    toast.success(`已导入 ${count} 条 Cookie 到账号「${importTarget.label}」`);
    await handleAfterMutation();
  };

  const handleOpenEnvModal = (siteKey: string, track: SiteTrack) => {
    setEnvModalTarget({ siteKey, track });
    setEnvTargetUrl('http://localhost:3000');
    setEnvRuleScope('device');
    setEnvSyncLs(true);
    setEnvAdaptHttp(true);
    setEnvCleanTarget(true);
    setEnvAutoSync(true);
    setEnvAutoReload(true);
  };

  const handleRunAccountEnvInject = async (saveAsRule: boolean) => {
    if (!envModalTarget) return;
    const dst = envTargetUrl.trim();
    if (!dst) {
      toast.warning('请输入目标开发/测试环境地址（如 http://localhost:3000）');
      return;
    }
    const { siteKey, track } = envModalTarget;
    setBusyKey(`env-inject:${track.trackId}`);
    try {
      if (saveAsRule) {
        const saved = await sidePanelApi.upsertEnvSyncRule({
          name: `${siteKey} [${track.label}] → ${dst}`,
          scope: envRuleScope,
          enabled: true,
          sourceSiteKey: siteKey,
          sourceTrackId: track.trackId,
          targetUrl: dst,
          syncCookies: true,
          syncLocalStorage: envSyncLs,
          adaptForHttp: envAdaptHttp,
          cleanTargetBeforeSync: envCleanTarget,
          autoSync: envAutoSync,
          autoReloadTarget: envAutoReload,
        });
        const res = await sidePanelApi.executeEnvSync({ ruleId: saved.id });
        const lsHint = res.appliedLocalStorage > 0 ? `、${res.appliedLocalStorage} 项 LS` : '';
        toast.success(
          `已绑定账号「${track.label}」并同步 ${res.appliedCookies} 条 Cookie${lsHint} 至 ${res.targetHost}`,
        );
      } else {
        const res = await sidePanelApi.executeEnvSync({
          adHoc: {
            sourceSiteKey: siteKey,
            sourceTrackId: track.trackId,
            targetUrl: dst,
            syncCookies: true,
            syncLocalStorage: envSyncLs,
            adaptForHttp: envAdaptHttp,
            cleanTargetBeforeSync: envCleanTarget,
            autoReloadTarget: envAutoReload,
          },
        });
        const lsHint = res.appliedLocalStorage > 0 ? `、${res.appliedLocalStorage} 项 LS` : '';
        toast.success(
          `单次注入完成：已将「${track.label}」的 ${res.appliedCookies} 条 Cookie${lsHint} 写入 ${res.targetHost}`,
        );
      }
      await handleAfterMutation();
    } catch (err) {
      toast.error(`环境同步失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleExecuteEnvRule = async (rule: EnvCookieSyncRule, reverse = false) => {
    setBusyKey(`exec-env:${rule.id}`);
    try {
      const res = await sidePanelApi.executeEnvSync({ ruleId: rule.id, reverse });
      const lsHint = res.appliedLocalStorage > 0 ? `、${res.appliedLocalStorage} 项 LS` : '';
      toast.success(
        `${reverse ? '反向' : '环境'}同步完成：写入 ${res.appliedCookies} 条 Cookie${lsHint}（${res.targetHost}）`,
      );
      await handleAfterMutation();
    } catch (err) {
      toast.error(`执行环境同步失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemoveEnvRule = async (rule: EnvCookieSyncRule) => {
    setBusyKey(`rm-env:${rule.id}`);
    try {
      await sidePanelApi.removeEnvSyncRule(rule.id, rule.scope);
      toast.success(`已删除环境同步规则：${rule.name}`);
      await handleAfterMutation();
    } catch (err) {
      toast.error(`删除规则失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  // --- Inline Drill-Down Views ---
  const inspectingSite = useMemo(
    () => (inspectCookiesTarget ? sites.find(s => s.siteKey === inspectCookiesTarget.siteKey) || null : null),
    [inspectCookiesTarget, sites],
  );

  if (inspectCookiesTarget && inspectingSite) {
    return (
      <CookieDetailView
        site={inspectingSite}
        globalSearch={globalSearch}
        initialTrackId={inspectCookiesTarget.trackId}
        layout={layout}
        onOpenLocalStorage={
          onOpenLocalStorage
            ? onOpenLocalStorage
            : (sk, trId, trLabel) => {
                setInspectCookiesTarget(null);
                if (trId) {
                  setInspectLsTarget({ siteKey: sk, trackId: trId, label: trLabel || shortId(trId, 12) });
                }
              }
        }
        onBack={() => setInspectCookiesTarget(null)}
        onSiteMutated={handleAfterMutation}
      />
    );
  }

  if (inspectLsTarget) {
    return (
      <div className={layout === 'wide' ? 'space-y-3' : 'flex h-full flex-col'}>
        <div
          className={
            layout === 'wide'
              ? 'flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-2.5'
              : 'shrink-0 flex items-center justify-between gap-2 border-b border-border bg-card/60 px-3 py-2'
          }>
          <div className="flex items-center gap-2 min-w-0">
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setInspectLsTarget(null)}>
              <ChevronLeft className="mr-1 h-3.5 w-3.5" />
              返回多账号列表
            </Button>
            <span className="truncate text-xs font-semibold">
              {inspectLsTarget.siteKey} · 账号「{inspectLsTarget.label}」的 LocalStorage
            </span>
          </div>
        </div>
        <div className={layout === 'wide' ? '' : 'min-h-0 flex-1 overflow-hidden'}>
          <LocalStorageTab
            globalSearch={globalSearch}
            filterSiteKey={inspectLsTarget.siteKey}
            filterTrackId={inspectLsTarget.trackId}
            filterTrackLabel={inspectLsTarget.label}
            onClearFilter={() => setInspectLsTarget(null)}
            onStatusChanged={handleAfterMutation}
            refreshSignal={refreshSignal}
            layout={layout}
          />
        </div>
      </div>
    );
  }

  const rulesForEnvModal = envModalTarget
    ? envRules.filter(
        r =>
          r.sourceSiteKey === envModalTarget.siteKey &&
          (r.sourceTrackId === envModalTarget.track.trackId || !r.sourceTrackId),
      )
    : [];

  return (
    <div className={layout === 'wide' ? 'space-y-4' : 'flex h-full flex-col overflow-y-auto p-3 space-y-3'}>
      {/* Wide-Screen Summary Stats */}
      {layout === 'wide' ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-border bg-card p-3.5">
            <div className="text-xs text-muted-foreground">已托管站点</div>
            <div className="mt-1 text-2xl font-bold text-foreground">{stats.sitesCount}</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-3.5">
            <div className="text-xs text-muted-foreground">已保存账号总数</div>
            <div className="mt-1 text-2xl font-bold text-primary">{stats.totalTracks}</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-3.5">
            <div className="text-xs text-muted-foreground">多账号站点 (≥2 号)</div>
            <div className="mt-1 text-2xl font-bold text-emerald-600 dark:text-emerald-400">
              {stats.multiAccountSites}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card p-3.5">
            <div className="text-xs text-muted-foreground">环境同步规则</div>
            <div className="mt-1 text-2xl font-bold text-sky-600 dark:text-sky-400">{stats.envRulesCount}</div>
          </div>
        </div>
      ) : null}

      {/* Top Toolbar: Filter, Local Search & Create Account */}
      <div
        className={
          layout === 'wide'
            ? 'flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-border bg-card px-4 py-3'
            : 'space-y-2'
        }>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" className="h-8 px-3 text-xs font-medium shadow-sm" onClick={() => openCreateModal()}>
            <UserPlus className="mr-1.5 h-3.5 w-3.5" />
            新增账号
          </Button>

          <div className="flex items-center gap-1">
            {(
              [
                ['all', `全部 (${stats.sitesCount})`],
                ['multi', `多账号站点 (${stats.multiAccountSites})`],
                ['single', '单账号站点'],
              ] as Array<[AccountFilterMode, string]>
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setFilterMode(mode)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  filterMode === mode
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="relative w-52 sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={localSearch}
              onChange={e => setLocalSearch(e.target.value)}
              placeholder="按站点、账号名称或备注筛选..."
              className="h-8 pl-8 pr-7 text-xs bg-background"
            />
            {localSearch ? (
              <button
                type="button"
                onClick={() => setLocalSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="清除筛选">
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={loadAll} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Site-Grouped Multi-Account List */}
      {loading && sites.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          正在加载全空间多账号信息...
        </div>
      ) : filteredSites.length === 0 ? (
        <EmptyState
          icon={<Users className="h-5 w-5" />}
          title={
            filterMode === 'multi'
              ? '暂无配置多个账号的站点'
              : sites.length === 0
                ? '暂无已托管账号'
                : '没有匹配的站点或账号'
          }
          description={
            filterMode === 'multi'
              ? '点击「新增账号」为任意网站创建空白新号（自动保活原登录态）或另存当前登录态，即可一键轮换。'
              : '可调整筛选条件或点击上方「新增账号」为任意网站添加独立账号轨道。'
          }
          action={
            <Button size="sm" className="h-8 px-3 text-xs" onClick={() => openCreateModal()}>
              <UserPlus className="mr-1.5 h-3.5 w-3.5" />
              新增账号
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {filteredSites.map(site => {
            const bindingMeta = getBindingMeta(site.binding.state);
            const activeTrackId = site.activeTrack?.trackId;
            const siteEnvRules = envRules.filter(r => r.sourceSiteKey === site.siteKey);

            return (
              <section
                key={site.siteKey}
                className="rounded-xl border border-border bg-card overflow-hidden shadow-2xs">
                {/* Site Group Header */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3.5 py-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <SiteFaviconSmall url={site.favIconUrl} siteKey={site.siteKey} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-foreground">{site.siteKey}</span>
                        <StatusBadge tone={bindingMeta.tone}>{bindingMeta.label}</StatusBadge>
                        <StatusBadge tone={site.allTracks.length >= 2 ? 'primary' : 'neutral'}>
                          {site.allTracks.length} 个账号
                        </StatusBadge>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        当前激活：{site.activeTrack?.label || '未绑定'}
                        {site.activeTrack?.accountNote ? ` · ${site.activeTrack.accountNote}` : ''}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    {site.allTracks.length > 1 ? (
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7 px-2.5 text-xs"
                        disabled={busyKey === `rotate:${site.siteKey}`}
                        onClick={() => void handleRotateSite(site.siteKey)}
                        title="按下方 #1 → #2 → ... 顺序轮换至下一个账号并刷新页面">
                        {busyKey === `rotate:${site.siteKey}` ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Repeat className="mr-1 h-3.5 w-3.5" />
                        )}
                        一键轮换
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => openCreateModal(site.siteKey)}>
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      新增账号
                    </Button>
                  </div>
                </div>

                {/* Account Rows */}
                {site.allTracks.length === 0 ? (
                  <div className="px-4 py-4 text-center text-xs text-muted-foreground">
                    该站点尚未建立账号轨道，点击右上角「新增账号」保存当前登录态或创建空白号。
                  </div>
                ) : (
                  <div className="divide-y divide-border/70">
                    {site.allTracks.map((track, idx) => {
                      const isActive = track.trackId === activeTrackId;
                      const pinnedRules = siteEnvRules.filter(r => r.sourceTrackId === track.trackId);
                      const followRules = isActive ? siteEnvRules.filter(r => !r.sourceTrackId) : [];
                      const linkedRules = [...pinnedRules, ...followRules];
                      const isBusy =
                        busyKey === `switch:${track.trackId}` ||
                        busyKey === `reorder:${track.trackId}` ||
                        busyKey === `export:${track.trackId}` ||
                        busyKey === `delete:${track.trackId}`;

                      return (
                        <div
                          key={track.trackId}
                          className={`px-3.5 py-3 text-xs transition-colors ${
                            isActive ? 'bg-primary/[0.04]' : 'hover:bg-muted/20'
                          }`}>
                          <div className="flex flex-wrap items-start justify-between gap-2.5">
                            {/* Left: Order + Account Info */}
                            <div className="flex items-start gap-2.5 min-w-0 flex-1">
                              {/* Rotation Order & Up/Down Arrows */}
                              <div className="flex flex-col items-center gap-0.5 shrink-0 pt-0.5">
                                <span
                                  className={`flex h-5 min-w-[24px] items-center justify-center rounded-md px-1 font-mono text-[10px] font-bold ${
                                    isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                                  }`}
                                  title="多账号轮换序号">
                                  #{idx + 1}
                                </span>
                                {site.allTracks.length > 1 ? (
                                  <div className="flex items-center gap-0.5">
                                    <button
                                      type="button"
                                      disabled={idx === 0 || isBusy}
                                      onClick={() => void handleMoveTrackOrder(site, track.trackId, -1)}
                                      title="上移轮换顺序"
                                      className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30">
                                      <ArrowUp className="h-3 w-3" />
                                    </button>
                                    <button
                                      type="button"
                                      disabled={idx === site.allTracks.length - 1 || isBusy}
                                      onClick={() => void handleMoveTrackOrder(site, track.trackId, 1)}
                                      title="下移轮换顺序"
                                      className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30">
                                      <ArrowDown className="h-3 w-3" />
                                    </button>
                                  </div>
                                ) : null}
                              </div>

                              {/* Name, Note, Stats, Linked Env Rules */}
                              <div className="min-w-0 flex-1 space-y-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-sm font-semibold text-foreground">{track.label}</span>
                                  {isActive ? (
                                    <StatusBadge tone="success">
                                      <CheckCircle2 className="h-3 w-3" />
                                      当前激活
                                    </StatusBadge>
                                  ) : null}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setEditTarget({
                                        siteKey: site.siteKey,
                                        trackId: track.trackId,
                                        label: track.label,
                                        accountNote: track.accountNote || '',
                                      })
                                    }
                                    className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                    title="编辑账号名称与备注">
                                    <Edit3 className="h-3 w-3" />
                                  </button>
                                </div>

                                {track.accountNote ? (
                                  <div className="flex items-center gap-1 text-[11px] text-amber-800 dark:text-amber-300">
                                    <StickyNote className="h-3 w-3 shrink-0" />
                                    <span className="break-words">{track.accountNote}</span>
                                  </div>
                                ) : null}

                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                                  <span className="inline-flex items-center gap-1">
                                    <Cookie className="h-3 w-3" />
                                    {track.cookieCount} Cookie
                                  </span>
                                  <span className="inline-flex items-center gap-1">
                                    <Database className="h-3 w-3" />
                                    {track.localStorageCount} LS
                                  </span>
                                  <span className="inline-flex items-center gap-1">
                                    <Laptop className="h-3 w-3" />
                                    {track.memberDeviceIds.length} 台设备 · 来源 {track.originDeviceName}
                                  </span>
                                  <span>最近活跃：{formatRelativeTime(track.lastUsedAt || track.updatedAt)}</span>
                                </div>

                                {/* Linked Dev <-> Prod Env Sync Rules Quick Chips */}
                                {linkedRules.length > 0 ? (
                                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                    {linkedRules.map(rule => (
                                      <span
                                        key={rule.id}
                                        className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/[0.06] px-2 py-0.5 text-[10px] text-foreground">
                                        <ArrowLeftRight className="h-2.5 w-2.5 text-primary" />
                                        <span className="font-mono">{rule.targetUrl}</span>
                                        <span className="text-muted-foreground">
                                          ({rule.sourceTrackId ? '固定绑定' : '随激活号'})
                                        </span>
                                        <button
                                          type="button"
                                          disabled={busyKey === `exec-env:${rule.id}`}
                                          onClick={() => void handleExecuteEnvRule(rule, false)}
                                          className="ml-0.5 rounded px-1 py-0.2 font-semibold text-primary hover:bg-primary/15"
                                          title="立即执行此环境同步">
                                          同步
                                        </button>
                                      </span>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            </div>

                            {/* Right: Account Actions */}
                            <div className="flex flex-wrap items-center gap-1 shrink-0">
                              {!isActive ? (
                                <Button
                                  size="sm"
                                  variant="default"
                                  className="h-7 px-2.5 text-[11px]"
                                  disabled={isBusy}
                                  onClick={() => void handleSwitchAccount(site.siteKey, track)}>
                                  {busyKey === `switch:${track.trackId}` ? (
                                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                  ) : null}
                                  切换激活
                                </Button>
                              ) : null}

                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-[11px]"
                                onClick={() =>
                                  setInspectCookiesTarget({ siteKey: site.siteKey, trackId: track.trackId })
                                }
                                title="查看、编辑该账号的 Cookies">
                                <Cookie className="mr-1 h-3 w-3" />
                                Cookies
                              </Button>

                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-[11px]"
                                onClick={() => {
                                  if (onOpenLocalStorage) {
                                    onOpenLocalStorage(site.siteKey, track.trackId, track.label);
                                  } else {
                                    setInspectLsTarget({
                                      siteKey: site.siteKey,
                                      trackId: track.trackId,
                                      label: track.label,
                                    });
                                  }
                                }}
                                title="查看该账号的 LocalStorage">
                                <Database className="mr-1 h-3 w-3" />
                                LS
                              </Button>

                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-[11px]"
                                onClick={() => handleOpenEnvModal(site.siteKey, track)}
                                title="将该账号注入 localhost 或配置开发↔生产自动同步">
                                <ArrowLeftRight className="mr-1 h-3 w-3 text-primary" />
                                注入环境
                              </Button>

                              <DropdownMenu modal={false}>
                                <DropdownMenuTrigger asChild>
                                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="更多账号操作">
                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-48">
                                  <DropdownMenuItem
                                    onClick={() =>
                                      setEditTarget({
                                        siteKey: site.siteKey,
                                        trackId: track.trackId,
                                        label: track.label,
                                        accountNote: track.accountNote || '',
                                      })
                                    }>
                                    <Edit3 className="mr-2 h-3.5 w-3.5" />
                                    编辑名称与备注
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={() => void handleExportAccountCookies(site.siteKey, track)}>
                                    <Download className="mr-2 h-3.5 w-3.5" />
                                    导出此账号 Cookies JSON
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() =>
                                      setImportTarget({
                                        siteKey: site.siteKey,
                                        trackId: track.trackId,
                                        label: track.label,
                                      })
                                    }>
                                    <Upload className="mr-2 h-3.5 w-3.5" />
                                    导入 Cookies 到此账号
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    className="text-rose-600 focus:text-rose-600"
                                    onClick={() =>
                                      setDeleteTarget({
                                        siteKey: site.siteKey,
                                        track,
                                        isActive,
                                        remainingCount: site.allTracks.length - 1,
                                      })
                                    }>
                                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                                    删除此账号
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* Create New Account Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={createSiteLocked ? `为 ${createSiteKey} 新增账号` : '为站点新增多账号轨道'}
        description="支持无损保存当前登录态并清空页面以登录第二个账号（不会触发服务端注销），也可将当前登录态另存为命名账号。"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={!createSiteKey.trim() || Boolean(busyKey?.startsWith('create:'))}
              onClick={() => void handleConfirmCreateAccount()}>
              {busyKey?.startsWith('create:') ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {createMode === 'clean_new' ? '创建并清空页面去登录' : '保存当前登录态'}
            </Button>
          </>
        }>
        <div className="space-y-3 text-xs">
          {!createSiteLocked ? (
            <div className="space-y-1">
              <Label htmlFor="acct-create-site" className="text-xs">
                目标站点域名 *
              </Label>
              <Input
                id="acct-create-site"
                list="accounts-create-site-suggestions"
                value={createSiteKey}
                onChange={e => setCreateSiteKey(e.target.value)}
                placeholder="选择或输入域名（例如 github.com）"
                className="h-8 text-xs font-mono"
              />
              <datalist id="accounts-create-site-suggestions">
                {siteSuggestions.map(item => (
                  <option key={item.siteKey} value={item.siteKey}>
                    {item.desc}
                  </option>
                ))}
              </datalist>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <div className="flex items-start gap-2 rounded-lg border border-border p-2.5 hover:bg-muted/30">
              <input
                id="acct-mgr-mode-clean"
                type="radio"
                name="acct-mgr-create-mode"
                checked={createMode === 'clean_new'}
                onChange={() => setCreateMode('clean_new')}
                className="mt-0.5 cursor-pointer accent-primary"
              />
              <label htmlFor="acct-mgr-mode-clean" className="min-w-0 flex-1 cursor-pointer">
                <span className="block font-medium text-foreground">新建空白账号（清空当前页面重新登录）</span>
                <span className="block text-[11px] text-muted-foreground">
                  推荐：无损保留原账号会话，仅清空本机浏览器对应 Cookie/LS 并刷新以登录新号
                </span>
              </label>
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-border p-2.5 hover:bg-muted/30">
              <input
                id="acct-mgr-mode-save"
                type="radio"
                name="acct-mgr-create-mode"
                checked={createMode === 'save_current'}
                onChange={() => setCreateMode('save_current')}
                className="mt-0.5 cursor-pointer accent-primary"
              />
              <label htmlFor="acct-mgr-mode-save" className="min-w-0 flex-1 cursor-pointer">
                <span className="block font-medium text-foreground">将当前浏览器登录态另存为新账号</span>
                <span className="block text-[11px] text-muted-foreground">
                  把当前网页已登录的 Cookie 与 LocalStorage 复制归档为一条独立账号轨道
                </span>
              </label>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="acct-create-label" className="text-xs">
              账号名称（可选）
            </Label>
            <Input
              id="acct-create-label"
              value={createLabel}
              onChange={e => setCreateLabel(e.target.value)}
              placeholder="例如：超级管理员 / 运营号 B / 联调测试号"
              onKeyDown={e => {
                if (e.key === 'Enter') void handleConfirmCreateAccount();
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="acct-create-note" className="text-xs">
              账号备注（可选）
            </Label>
            <Input
              id="acct-create-note"
              value={createNote}
              onChange={e => setCreateNote(e.target.value)}
              placeholder="例如：角色权限、绑定邮箱或手机号尾号"
              onKeyDown={e => {
                if (e.key === 'Enter') void handleConfirmCreateAccount();
              }}
            />
          </div>
        </div>
      </Modal>

      {/* Edit Account Name & Note Modal */}
      <Modal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        title={`编辑账号信息 (${editTarget?.siteKey || ''})`}
        description="修改后的账号名称与备注将随同步空间加密同步至所有设备。"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setEditTarget(null)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={!editTarget?.label.trim() || busyKey === `edit:${editTarget?.trackId}`}
              onClick={() => void handleConfirmEditAccount()}>
              {busyKey === `edit:${editTarget?.trackId}` ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              保存修改
            </Button>
          </>
        }>
        <div className="space-y-3 text-xs">
          <div className="space-y-1">
            <Label htmlFor="acct-edit-label" className="text-xs">
              账号名称 *
            </Label>
            <Input
              id="acct-edit-label"
              value={editTarget?.label || ''}
              onChange={e => setEditTarget(prev => (prev ? { ...prev, label: e.target.value } : null))}
              placeholder="输入账号名称"
              onKeyDown={e => {
                if (e.key === 'Enter') void handleConfirmEditAccount();
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="acct-edit-note" className="text-xs">
              账号备注（留空可清除）
            </Label>
            <Input
              id="acct-edit-note"
              value={editTarget?.accountNote || ''}
              onChange={e => setEditTarget(prev => (prev ? { ...prev, accountNote: e.target.value } : null))}
              placeholder="例如：生产超管 / 测试商户 A / 尾号 8888"
              onKeyDown={e => {
                if (e.key === 'Enter') void handleConfirmEditAccount();
              }}
            />
          </div>
        </div>
      </Modal>

      {/* Delete Account Confirmation Modal */}
      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={`删除账号：${deleteTarget?.track.label || ''}`}
        description={`站点：${deleteTarget?.siteKey || ''}`}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!deleteTarget || busyKey === `delete:${deleteTarget?.track.trackId}`}
              onClick={() => void handleConfirmDeleteAccount()}>
              {busyKey === `delete:${deleteTarget?.track.trackId}` ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              确认删除账号
            </Button>
          </>
        }>
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            即将删除账号 <strong className="text-foreground">「{deleteTarget?.track.label}」</strong>（包含{' '}
            {deleteTarget?.track.cookieCount ?? 0} 条 Cookie、{deleteTarget?.track.localStorageCount ?? 0} 项
            LocalStorage）。
          </p>
          {deleteTarget?.isActive ? (
            <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-2.5 text-[11px] text-amber-800 dark:text-amber-300">
              {deleteTarget.remainingCount > 0
                ? '该账号当前处于激活状态：删除前将自动保存本地安全还原点（后悔药），并自动切换至该站点的下一个账号。'
                : '这是该站点的最后一条账号轨道：删除前将自动保存本地还原点，且站点将退回未纳管状态。'}
            </div>
          ) : null}
        </div>
      </Modal>

      {/* Account-Scoped Cookie JSON Import Modal */}
      <JsonImportModal
        open={!!importTarget}
        onClose={() => setImportTarget(null)}
        title={importTarget ? `导入 Cookies 到账号「${importTarget.label}」` : '导入 Cookies'}
        description={
          importTarget
            ? `目标站点：${importTarget.siteKey}。若该账号当前未激活，导入仅写入该账号轨道与云端，不会打断当前网页登录态。`
            : '支持粘贴 Cookie 对象数组或由 SessionMesh 导出的 JSON 文件。'
        }
        placeholder='[{"name": "session", "value": "xxx", "domain": "example.com", "path": "/", "secure": true}]'
        onImport={handleImportAccountCookies}
      />

      {/* Account-Scoped Dev <-> Prod Environment Sync Modal */}
      <Modal
        open={!!envModalTarget}
        onClose={() => setEnvModalTarget(null)}
        title={
          envModalTarget ? `环境同步 · ${envModalTarget.siteKey}「${envModalTarget.track.label}」` : '开发/生产环境同步'
        }
        description="将该账号的登录态 Cookie 与 LocalStorage 重写注入到本地开发端口（自动适配 localhost / HTTP 属性），即使该账号当前未激活也可独立注入。"
        maxWidthClass="max-w-lg"
        footer={
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setEnvModalTarget(null)}>
              关闭
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!envTargetUrl.trim() || Boolean(busyKey?.startsWith('env-inject:'))}
              onClick={() => void handleRunAccountEnvInject(false)}>
              单次注入
            </Button>
            <Button
              size="sm"
              disabled={!envTargetUrl.trim() || Boolean(busyKey?.startsWith('env-inject:'))}
              onClick={() => void handleRunAccountEnvInject(true)}>
              {busyKey?.startsWith('env-inject:') ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowLeftRight className="mr-1.5 h-3.5 w-3.5" />
              )}
              绑定此账号并立即同步
            </Button>
          </div>
        }>
        <div className="space-y-3.5 text-xs">
          {/* Existing linked rules for this account / site */}
          {rulesForEnvModal.length > 0 ? (
            <div className="space-y-1.5">
              <div className="font-semibold text-foreground">已关联的环境同步规则 ({rulesForEnvModal.length})</div>
              <div className="divide-y divide-border rounded-lg border border-border">
                {rulesForEnvModal.map(rule => (
                  <div key={rule.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-foreground truncate">{rule.name}</span>
                        <StatusBadge tone={rule.sourceTrackId ? 'primary' : 'neutral'}>
                          {rule.sourceTrackId ? '绑定此账号' : '跟随激活号'}
                        </StatusBadge>
                      </div>
                      <p className="font-mono text-[10px] text-muted-foreground truncate">
                        → {rule.targetUrl} · {rule.lastSyncedAt ? formatRelativeTime(rule.lastSyncedAt) : '尚未同步'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="default"
                        className="h-6 px-2 text-[11px]"
                        disabled={busyKey === `exec-env:${rule.id}`}
                        onClick={() => void handleExecuteEnvRule(rule, false)}>
                        <Play className="mr-1 h-3 w-3" />
                        同步
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-1.5 text-[10px]"
                        disabled={busyKey === `exec-env:${rule.id}`}
                        onClick={() => void handleExecuteEnvRule(rule, true)}
                        title="从目标开发环境反向写回源站">
                        反向
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-rose-600 hover:bg-rose-500/10"
                        disabled={busyKey === `rm-env:${rule.id}`}
                        onClick={() => void handleRemoveEnvRule(rule)}
                        title="删除规则">
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Quick Target Form */}
          <div className="space-y-2.5 rounded-xl border border-border bg-muted/25 p-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <Label htmlFor="acct-env-target-url" className="text-xs">
                  目标开发 / 测试环境地址 *
                </Label>
                <div className="flex items-center gap-1">
                  {['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:8080'].map(preset => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setEnvTargetUrl(preset)}
                      className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground">
                      {preset.replace('http://', '')}
                    </button>
                  ))}
                </div>
              </div>
              <Input
                id="acct-env-target-url"
                value={envTargetUrl}
                onChange={e => setEnvTargetUrl(e.target.value)}
                placeholder="例如 http://localhost:3000 或 https://dev.example.local"
                className="h-8 text-xs font-mono bg-background"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="acct-env-scope" className="text-xs">
                保存规则生效范围
              </Label>
              <select
                id="acct-env-scope"
                value={envRuleScope}
                onChange={e => setEnvRuleScope(e.target.value as 'device' | 'space')}
                className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground">
                <option value="device">仅本机生效（推荐本地开发端口）</option>
                <option value="space">空间级（全设备加密同步此映射规则）</option>
              </select>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <div className="flex items-center gap-1.5">
                <Switch
                  id="acct-env-http"
                  className="scale-75"
                  checked={envAdaptHttp}
                  onCheckedChange={setEnvAdaptHttp}
                />
                <Label htmlFor="acct-env-http" className="text-[11px] cursor-pointer">
                  HTTP 适配
                </Label>
              </div>
              <div className="flex items-center gap-1.5">
                <Switch id="acct-env-ls" className="scale-75" checked={envSyncLs} onCheckedChange={setEnvSyncLs} />
                <Label htmlFor="acct-env-ls" className="text-[11px] cursor-pointer">
                  含 LocalStorage
                </Label>
              </div>
              <div className="flex items-center gap-1.5">
                <Switch
                  id="acct-env-auto"
                  className="scale-75"
                  checked={envAutoSync}
                  onCheckedChange={setEnvAutoSync}
                />
                <Label htmlFor="acct-env-auto" className="text-[11px] cursor-pointer">
                  变更自动跟随
                </Label>
              </div>
              <div className="flex items-center gap-1.5">
                <Switch
                  id="acct-env-clean"
                  className="scale-75"
                  checked={envCleanTarget}
                  onCheckedChange={setEnvCleanTarget}
                />
                <Label htmlFor="acct-env-clean" className="text-[11px] cursor-pointer">
                  清理目标旧项
                </Label>
              </div>
              <div className="flex items-center gap-1.5">
                <Switch
                  id="acct-env-reload"
                  className="scale-75"
                  checked={envAutoReload}
                  onCheckedChange={setEnvAutoReload}
                />
                <Label htmlFor="acct-env-reload" className="text-[11px] cursor-pointer">
                  自动刷新目标页
                </Label>
              </div>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
};
