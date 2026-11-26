import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import { useBannerPrefs } from '@console/lib/bannerPrefs';
import {
  buildCookieHeader,
  copyToClipboard,
  downloadJsonFile,
  formatRelativeTime,
  getBindingMeta,
  getCookieSyncStatusMeta,
  shortId,
} from '@console/lib/format';
import type {
  AccountCreateMode,
  BrowserCookieInput,
  PendingSiteDecision,
  SiteBindingState,
  SiteDecisionAction,
  SiteSummaryView,
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
} from '@sessionmesh/ui';
import {
  AlertTriangle,
  Ban,
  ChevronRight,
  CloudDownload,
  CloudUpload,
  Cookie,
  Copy,
  Database,
  Download,
  FileJson,
  GitBranch,
  Globe,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Repeat,
  ShieldAlert,
  ShieldBan,
  Tag,
  Trash2,
  Unlink,
  Upload,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AddManagedSitesModal } from './AddManagedSitesModal';
import { StatusBadge } from './common/Badge';
import { EmptyState } from './common/EmptyState';
import { JsonImportModal } from './common/JsonImportModal';
import { Modal } from './common/Modal';
import { CookieDetailView } from './CookieDetailView';
import { UnmanageSiteModal } from './UnmanageSiteModal';
import type { UnmanageSiteScope } from './UnmanageSiteModal';

export interface SitesAndCookiesTabProps {
  globalSearch: string;
  initialSiteKey?: string | null;
  initialTrackId?: string | null;
  onConsumeInitialSite?: () => void;
  onStatusChanged: () => Promise<void> | void;
  refreshSignal: number;
  layout?: 'compact' | 'wide';
  onOpenAccounts?: (siteKey?: string) => void;
  onOpenLocalStorage?: (siteKey: string, trackId?: string, trackLabel?: string) => void;
}

type BindingFilter = 'ALL' | SiteBindingState;

const SiteFavicon: React.FC<{ url?: string; siteKey: string }> = ({ url, siteKey }) => {
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

export const SitesAndCookiesTab: React.FC<SitesAndCookiesTabProps> = ({
  globalSearch,
  initialSiteKey,
  initialTrackId,
  onConsumeInitialSite,
  onStatusChanged,
  refreshSignal,
  layout = 'compact',
  onOpenAccounts,
  onOpenLocalStorage,
}) => {
  const [sites, setSites] = useState<SiteSummaryView[]>([]);
  const [pendingDecisions, setPendingDecisions] = useState<PendingSiteDecision[]>([]);
  const [loading, setLoading] = useState(true);
  const [bindingFilter, setBindingFilter] = useState<BindingFilter>('ALL');
  const [selectedSiteKey, setSelectedSiteKey] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [selectedPendingKeys, setSelectedPendingKeys] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Per-site modals
  const [addSitesOpen, setAddSitesOpen] = useState(false);
  const [unmanageTargetSite, setUnmanageTargetSite] = useState<string | null>(null);
  const [importSiteKey, setImportSiteKey] = useState<string | undefined>(undefined);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{
    siteKey: string;
    trackId: string;
    label: string;
    accountNote: string;
  } | null>(null);
  const [splitTargetSite, setSplitTargetSite] = useState<string | null>(null);
  const [splitLabel, setSplitLabel] = useState('');
  const [createAcctSite, setCreateAcctSite] = useState<string | null>(null);
  const [createAcctMode, setCreateAcctMode] = useState<AccountCreateMode>('clean_new');
  const [createAcctLabel, setCreateAcctLabel] = useState('');
  const [createAcctNote, setCreateAcctNote] = useState('');

  const { isBannerVisible, dismissBanner } = useBannerPrefs();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [overview, pending] = await Promise.all([
        sidePanelApi.getSitesOverview(),
        sidePanelApi.getPendingDecisions(),
      ]);
      setSites(overview || []);
      setPendingDecisions(pending || []);
      setSelectedPendingKeys(prev => {
        const valid = new Set((pending || []).map(p => p.siteKey));
        return new Set([...prev].filter(k => valid.has(k)));
      });
    } catch (err) {
      toast.error(`加载站点列表失败：${extractErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData, refreshSignal]);

  useEffect(() => {
    if (initialSiteKey && sites.some(s => s.siteKey === initialSiteKey)) {
      setSelectedSiteKey(initialSiteKey);
      setSelectedTrackId(initialTrackId || null);
      onConsumeInitialSite?.();
    }
  }, [initialSiteKey, initialTrackId, sites, onConsumeInitialSite]);

  const handleAfterMutation = async () => {
    await loadData();
    await onStatusChanged();
  };

  // --- Pending Decision Handlers ---
  const handleResolveSingle = async (siteKey: string, action: SiteDecisionAction, desc: string) => {
    setBusyKey(`decision:${siteKey}`);
    try {
      await sidePanelApi.resolveSiteDecision(siteKey, action);
      toast.success(`${siteKey}：${desc}`);
      await handleAfterMutation();
    } catch (err) {
      toast.error(`决策失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const targetPendingKeys =
    selectedPendingKeys.size > 0 ? [...selectedPendingKeys] : pendingDecisions.map(p => p.siteKey);

  const handleBatchUniformDecision = async (action: SiteDecisionAction, label: string) => {
    if (targetPendingKeys.length === 0) return;
    setBusyKey('batch-decision');
    try {
      await sidePanelApi.resolveBatchDecisions(targetPendingKeys, action);
      toast.success(`已批量处理 ${targetPendingKeys.length} 个站点：${label}`);
      setSelectedPendingKeys(new Set());
      await handleAfterMutation();
    } catch (err) {
      toast.error(`批量处理失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleBatchUseLatestRemote = async () => {
    if (targetPendingKeys.length === 0) return;
    setBusyKey('batch-remote');
    let ok = 0;
    let fail = 0;
    try {
      for (const sk of targetPendingKeys) {
        const decision = pendingDecisions.find(d => d.siteKey === sk);
        const latestTrack = decision?.remoteTracks?.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (!latestTrack) {
          fail++;
          continue;
        }
        try {
          await sidePanelApi.resolveSiteDecision(sk, { type: 'use_remote_track', trackId: latestTrack.trackId });
          ok++;
        } catch {
          fail++;
        }
      }
      if (fail === 0) {
        toast.success(`已批量采用远端最新轨道 (${ok} 个站点)，原数据已自动备份至还原点`);
      } else {
        toast.warning(`批量处理完成：成功 ${ok} 个，失败 ${fail} 个`);
      }
      setSelectedPendingKeys(new Set());
      await handleAfterMutation();
    } finally {
      setBusyKey(null);
    }
  };

  // --- Site Track & Cookie Quick Controls ---
  const handleSwitchTrack = async (siteKey: string, targetTrackId: string) => {
    setBusyKey(`track:${siteKey}`);
    try {
      await sidePanelApi.switchSiteTrack(siteKey, targetTrackId);
      toast.success(`${siteKey} 已切换轨道（已自动创建本机安全还原点）`);
      await handleAfterMutation();
    } catch (err) {
      toast.error(`切换轨道失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleSiteSync = async (siteKey: string, direction: 'push' | 'pull') => {
    setBusyKey(`sync:${direction}:${siteKey}`);
    try {
      const res = await sidePanelApi.syncNow({ siteKey, direction });
      if (res.errorMessage) {
        toast.warning(`${siteKey} 暂时无法连接云端，系统将继续后台自动重试：${res.errorMessage}`);
      } else {
        const refreshHint = direction === 'pull' && res.appliedCookies > 0 ? '，刷新对应网页即可生效' : '';
        toast.success(
          direction === 'push'
            ? `${siteKey} 推送完成（${res.pushedEvents} 个事件）`
            : `${siteKey} 拉取完成（应用 ${res.appliedCookies} 条，失败 ${res.failedCookies} 条${refreshHint}）`,
        );
      }
      await handleAfterMutation();
    } catch (err) {
      toast.error(`单站同步失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleCopySiteCookies = async (siteKey: string, asJson: boolean) => {
    setBusyKey(`copy:${siteKey}`);
    try {
      const exported = await sidePanelApi.exportCookiesJson(siteKey);
      if (exported.length === 0) {
        toast.warning(`${siteKey} 暂无可复制的 Cookie`);
        return;
      }
      const text = asJson ? JSON.stringify(exported, null, 2) : buildCookieHeader(exported);
      const ok = await copyToClipboard(text);
      if (ok) toast.success(`已复制 ${siteKey} 的 ${exported.length} 条 Cookie (${asJson ? 'JSON' : 'Header'})`);
      else toast.error('复制到剪贴板失败');
    } catch (err) {
      toast.error(`复制失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleExportSiteCookies = async (siteKey?: string) => {
    setBusyKey(`export:${siteKey || 'all'}`);
    try {
      const exported = await sidePanelApi.exportCookiesJson(siteKey);
      downloadJsonFile(`sessionmesh-cookies-${siteKey || 'all-sites'}.json`, exported);
      toast.success(`已导出 ${exported.length} 条 Cookie`);
    } catch (err) {
      toast.error(`导出失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleImportCookies = async (parsed: unknown) => {
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown }).cookies)
        ? (parsed as { cookies: unknown[] }).cookies
        : null;
    if (!arr || arr.length === 0) {
      throw new Error('JSON 必须是包含 Cookie 对象的数组');
    }
    const normalized: BrowserCookieInput[] = arr.map((item: Record<string, unknown>) => ({
      name: String(item.name ?? ''),
      value: String(item.value ?? ''),
      domain: String(item.domain ?? importSiteKey ?? ''),
      path: String(item.path ?? '/'),
      secure: Boolean(item.secure ?? true),
      httpOnly: Boolean(item.httpOnly ?? false),
      sameSite: (item.sameSite as BrowserCookieInput['sameSite']) || 'unspecified',
      session: Boolean(item.session ?? !item.expirationDate),
      expirationDate: typeof item.expirationDate === 'number' ? item.expirationDate : undefined,
      hostOnly: Boolean(item.hostOnly ?? false),
      storeId: typeof item.storeId === 'string' ? item.storeId : undefined,
      partitionKey: (item.partitionKey as BrowserCookieInput['partitionKey']) ?? null,
    }));
    const count = await sidePanelApi.importCookiesJson(normalized, importSiteKey);
    toast.success(`已成功导入 ${count} 条 Cookie`);
    await handleAfterMutation();
  };

  const handleQuickBlacklist = async (siteKey: string, scope: 'device' | 'space') => {
    setBusyKey(`bl:${siteKey}`);
    try {
      await sidePanelApi.addBlacklistEntry({
        pattern: siteKey,
        matchType: 'subdomain',
        scope,
        reason: '侧边栏快捷拉黑',
        presetCategory: 'custom',
      });
      toast.success(`已将 ${siteKey} 加入${scope === 'space' ? '空间级' : '本机级'}黑名单`);
      await handleAfterMutation();
    } catch (err) {
      toast.error(`加入黑名单失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleConfirmRename = async () => {
    if (!renameTarget || !renameTarget.label.trim()) return;
    setBusyKey(`rename:${renameTarget.siteKey}`);
    try {
      await sidePanelApi.updateSiteTrack(renameTarget.siteKey, renameTarget.trackId, {
        label: renameTarget.label.trim(),
        accountNote: renameTarget.accountNote.trim(),
      });
      toast.success('账号信息已更新');
      setRenameTarget(null);
      await handleAfterMutation();
    } catch (err) {
      toast.error(`更新失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleConfirmSplit = async () => {
    if (!splitTargetSite) return;
    setBusyKey(`split:${splitTargetSite}`);
    try {
      await sidePanelApi.splitSiteIndependent(splitTargetSite, splitLabel.trim() || undefined);
      toast.success(`${splitTargetSite} 已拆分为本机独立轨道`);
      setSplitTargetSite(null);
      setSplitLabel('');
      await handleAfterMutation();
    } catch (err) {
      toast.error(`拆分独立轨道失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRotateAccount = async (siteKey: string) => {
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

  const handleConfirmCreateAccount = async () => {
    if (!createAcctSite) return;
    setBusyKey(`create-acct:${createAcctSite}`);
    try {
      const created = await sidePanelApi.createSiteAccountTrack(createAcctSite, {
        mode: createAcctMode,
        label: createAcctLabel.trim() || undefined,
        accountNote: createAcctNote.trim() || undefined,
        triggerRefresh: createAcctMode === 'clean_new',
      });
      toast.success(
        createAcctMode === 'clean_new'
          ? `已保存原账号并切换至空白账号「${created.label}」，请在网页登录新账号`
          : `已将当前登录态另存为账号「${created.label}」`,
      );
      setCreateAcctSite(null);
      setCreateAcctLabel('');
      setCreateAcctNote('');
      await handleAfterMutation();
    } catch (err) {
      toast.error(`创建账号失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeleteAccount = async (siteKey: string, trackId: string, label: string) => {
    setBusyKey(`del-acct:${trackId}`);
    try {
      await sidePanelApi.deleteSiteTrack(siteKey, trackId);
      toast.success(`已移除账号轨道「${label}」`);
      await handleAfterMutation();
    } catch (err) {
      toast.error(`移除账号失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleConfirmUnmanage = async (siteKey: string, scope: UnmanageSiteScope) => {
    await sidePanelApi.removeManagedSite(siteKey, scope);
    toast.success(
      scope === 'device_unmanage'
        ? `已将 ${siteKey} 移出本机同步管理（不影响其他设备）`
        : `已将 ${siteKey} 从整个同步空间移除`,
    );
    await handleAfterMutation();
  };

  // Drill-down Cookie Detail View
  const activeSite = useMemo(
    () => (selectedSiteKey ? sites.find(s => s.siteKey === selectedSiteKey) || null : null),
    [selectedSiteKey, sites],
  );

  if (activeSite) {
    return (
      <CookieDetailView
        site={activeSite}
        globalSearch={globalSearch}
        initialTrackId={selectedTrackId}
        layout={layout}
        onOpenLocalStorage={onOpenLocalStorage}
        onBack={() => {
          setSelectedSiteKey(null);
          setSelectedTrackId(null);
        }}
        onSiteMutated={handleAfterMutation}
      />
    );
  }

  const query = globalSearch.trim().toLowerCase();
  const filteredSites = sites
    .filter(s => {
      if (bindingFilter !== 'ALL' && s.binding.state !== bindingFilter) return false;
      if (!query) return true;
      return (
        s.siteKey.toLowerCase().includes(query) ||
        (s.activeTrack?.label || '').toLowerCase().includes(query) ||
        (s.activeTrack?.accountNote || '').toLowerCase().includes(query) ||
        s.allTracks.some(
          tr => tr.label.toLowerCase().includes(query) || (tr.accountNote || '').toLowerCase().includes(query),
        ) ||
        (s.sourceDeviceName || '').toLowerCase().includes(query)
      );
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const allPendingSelected =
    pendingDecisions.length > 0 && pendingDecisions.every(p => selectedPendingKeys.has(p.siteKey));

  return (
    <div className={layout === 'wide' ? 'space-y-4' : 'flex h-full flex-col overflow-y-auto p-3 space-y-3'}>
      {/* Pending Site Decisions Queue */}
      {pendingDecisions.length > 0 ? (
        <section className="rounded-xl border border-amber-500/40 bg-amber-500/[0.07] p-3 space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <h3 className="text-xs font-semibold text-foreground">待确认站点队列 ({pendingDecisions.length})</h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  为避免静默覆盖本机或远端登录态，以下站点需要您确认同步策略（覆盖前会自动创建本地还原点）。
                </p>
              </div>
            </div>
          </div>

          {/* Batch Resolution Bar */}
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-500/25 bg-background/80 p-2">
            <label className="mr-1 flex cursor-pointer items-center gap-1 text-[11px] font-medium">
              <input
                type="checkbox"
                checked={allPendingSelected}
                onChange={() => {
                  if (allPendingSelected) setSelectedPendingKeys(new Set());
                  else setSelectedPendingKeys(new Set(pendingDecisions.map(p => p.siteKey)));
                }}
                className="h-3.5 w-3.5 rounded accent-primary"
              />
              <span>
                {selectedPendingKeys.size > 0
                  ? `已选 ${selectedPendingKeys.size} 站`
                  : `全选 (${pendingDecisions.length})`}
              </span>
            </label>
            <Button
              variant="default"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={busyKey === 'batch-remote' || busyKey === 'batch-decision'}
              onClick={handleBatchUseLatestRemote}>
              一键采用最新远端
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={busyKey === 'batch-decision'}
              onClick={() => handleBatchUniformDecision({ type: 'use_local_override_track' }, '全部用本机覆盖')}>
              全部用本机覆盖
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={busyKey === 'batch-decision'}
              onClick={() => handleBatchUniformDecision({ type: 'keep_independent' }, '全部各自独立维护')}>
              全部独立维护
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px] text-rose-600 dark:text-rose-400"
              disabled={busyKey === 'batch-decision'}
              onClick={() => handleBatchUniformDecision({ type: 'blacklist', scope: 'device' }, '全部本机拉黑')}>
              批量拉黑
            </Button>
          </div>

          {/* Individual Pending Site Cards */}
          <div className="space-y-2">
            {pendingDecisions.map(item => {
              const isBusy = busyKey === `decision:${item.siteKey}`;
              const checked = selectedPendingKeys.has(item.siteKey);
              return (
                <div key={item.siteKey} className="rounded-lg border border-border bg-card p-2.5 text-xs space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <input
                        id={`pending-${item.siteKey}`}
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setSelectedPendingKeys(prev => {
                            const next = new Set(prev);
                            if (next.has(item.siteKey)) next.delete(item.siteKey);
                            else next.add(item.siteKey);
                            return next;
                          });
                        }}
                        className="h-3.5 w-3.5 rounded accent-primary cursor-pointer"
                      />
                      <SiteFavicon siteKey={item.siteKey} />
                      <label htmlFor={`pending-${item.siteKey}`} className="min-w-0 cursor-pointer">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-semibold text-foreground">{item.siteKey}</span>
                          <StatusBadge tone="warning">
                            {item.reason === 'both_sides_have_data' ? '双端均有登录态' : '云端多轨道待选'}
                          </StatusBadge>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          本机：
                          {item.hasLocalData
                            ? `${item.localCookieCount} Cookie · ${item.localLocalStorageCount} LS`
                            : '无数据'}
                          {' · '}
                          云端：{item.remoteTracks.length} 条轨道
                        </p>
                      </label>
                    </div>
                    {isBusy ? <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" /> : null}
                  </div>

                  {/* Remote Track Choices */}
                  <div className="space-y-1.5">
                    {item.remoteTracks.map(tr => (
                      <div
                        key={tr.trackId}
                        className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/30 px-2 py-1.5">
                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-medium text-foreground">
                            轨道「{tr.label}」
                            <span className="ml-1 font-normal text-muted-foreground">
                              ({tr.originDeviceName} · {tr.memberDeviceIds.length} 设备)
                            </span>
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {tr.cookieCount} Cookie · {tr.localStorageCount} LS · 更新于{' '}
                            {formatRelativeTime(tr.updatedAt)}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="default"
                          className="h-6 px-2 text-[11px] shrink-0"
                          disabled={isBusy}
                          onClick={() =>
                            handleResolveSingle(
                              item.siteKey,
                              { type: 'use_remote_track', trackId: tr.trackId },
                              `已跟随轨道「${tr.label}」`,
                            )
                          }>
                          采用此轨道
                        </Button>
                      </div>
                    ))}
                  </div>

                  {/* Local Override / Independent / Blacklist */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-border/60">
                    {item.hasLocalData ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        disabled={isBusy}
                        onClick={() =>
                          handleResolveSingle(
                            item.siteKey,
                            { type: 'use_local_override_track', trackId: item.remoteTracks[0]?.trackId },
                            '已用本机版本覆盖远端轨道',
                          )
                        }>
                        用本机覆盖
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px]"
                      disabled={isBusy}
                      onClick={() =>
                        handleResolveSingle(item.siteKey, { type: 'keep_independent' }, '已设为各自独立维护轨道')
                      }>
                      各自独立维护
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px] text-muted-foreground hover:text-rose-600"
                      disabled={isBusy}
                      onClick={() =>
                        handleResolveSingle(item.siteKey, { type: 'blacklist', scope: 'device' }, '已加入本机黑名单')
                      }>
                      本机拉黑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px] text-rose-600 hover:bg-rose-500/10"
                      disabled={isBusy}
                      onClick={() =>
                        handleResolveSingle(item.siteKey, { type: 'blacklist', scope: 'space' }, '已加入空间黑名单')
                      }>
                      全空间拉黑
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Sites Primary Action & Binding Filter Toolbar */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="default"
            size="sm"
            className="h-8 px-3 text-xs font-medium shadow-sm"
            onClick={() => setAddSitesOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            添加同步网站
          </Button>

          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => {
                setImportSiteKey(undefined);
                setImportModalOpen(true);
              }}>
              <Upload className="mr-1 h-3 w-3" />
              导入
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => handleExportSiteCookies(undefined)}>
              <Download className="mr-1 h-3 w-3" />
              导出全部
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={loadData} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          {(
            [
              ['ALL', `全部 (${sites.length})`],
              ['AUTO_BOUND', '自动绑定'],
              ['USER_BOUND', '手动跟随'],
              ['INDEPENDENT', '独立轨道'],
              ['PENDING_CHOICE', '待确认'],
              ['BLACKLISTED', '黑名单'],
            ] as Array<[BindingFilter, string]>
          ).map(([state, label]) => (
            <button
              key={state}
              type="button"
              onClick={() => setBindingFilter(state)}
              className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                bindingFilter === state
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Dismissible Rolling Token Damping Notice */}
      {sites.some(s => s.rollingTokenDamped) && isBannerVisible('sites_rolling_token_notice', 'degraded') ? (
        <div className="rounded-xl border border-amber-500/35 bg-amber-500/[0.08] p-2.5 text-xs text-amber-900 dark:text-amber-200">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 space-y-0.5">
                <p className="font-semibold">检测到滚动令牌（Rolling Token）高频轮换，已自动启用阻尼保护</p>
                <p className="text-[11px] opacity-90 leading-relaxed">
                  部分站点短时间内频繁刷新会话令牌，SessionMesh 已自动降低高频写回频率以避免多设备互踢或同步风暴。
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => void dismissBanner('sites_rolling_token_notice')}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-amber-500/20">
                不再提示
              </button>
              <button
                type="button"
                onClick={() => void dismissBanner('sites_rolling_token_notice')}
                className="rounded p-0.5 hover:bg-amber-500/20"
                aria-label="关闭滚动令牌提示">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Site & Track List */}
      {loading && sites.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          正在加载已同步站点与轨道...
        </div>
      ) : filteredSites.length === 0 ? (
        <EmptyState
          icon={<Cookie className="h-5 w-5" />}
          title={sites.length === 0 ? '尚未添加需要同步的网站' : '暂无匹配的站点记录'}
          description={
            sites.length === 0
              ? '按需选择需要同步登录态的网站，或手动输入域名预先纳管；未纳管的浏览网页不会被自动上传。'
              : '可调整筛选条件或搜索关键词，也可以直接添加新的同步网站。'
          }
          action={
            <Button size="sm" className="h-8 px-3 text-xs" onClick={() => setAddSitesOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              添加同步网站
            </Button>
          }
        />
      ) : (
        <div className={layout === 'wide' ? 'grid gap-3 xl:grid-cols-2' : 'space-y-2.5'}>
          {filteredSites.map(site => {
            const bindingMeta = getBindingMeta(site.binding.state);
            const syncMeta = getCookieSyncStatusMeta(site.syncStatus);
            const isBlacklisted = site.binding.state === 'BLACKLISTED';
            return (
              <div
                key={site.siteKey}
                className="flex flex-col justify-between rounded-xl border border-border bg-card p-3 transition-colors hover:border-primary/40 space-y-2.5">
                {/* Clickable Main Site Header */}
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSiteKey(site.siteKey);
                      setSelectedTrackId(site.activeTrack?.trackId || null);
                    }}
                    className="group flex flex-1 items-start gap-2.5 text-left min-w-0">
                    <SiteFavicon url={site.favIconUrl} siteKey={site.siteKey} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-foreground group-hover:text-primary group-hover:underline">
                          {site.siteKey}
                        </span>
                        <StatusBadge tone={bindingMeta.tone}>{bindingMeta.label}</StatusBadge>
                        <StatusBadge tone={syncMeta.tone}>{syncMeta.label}</StatusBadge>
                        {site.allTracks.length > 1 ? (
                          <StatusBadge tone="primary">{site.allTracks.length} 账号</StatusBadge>
                        ) : null}
                        {site.rollingTokenDamped ? (
                          <StatusBadge tone="warning">
                            <ShieldAlert className="h-3 w-3" />
                            滚动令牌阻尼
                          </StatusBadge>
                        ) : null}
                      </div>

                      {/* Track & Metrics */}
                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1 text-foreground/85 font-medium">
                          <GitBranch className="h-3 w-3 text-primary" />
                          {site.activeTrack?.label || '未绑定轨道'}
                        </span>
                        {site.activeTrack?.accountNote ? (
                          <span className="truncate max-w-[160px] text-[10px] text-muted-foreground">
                            ({site.activeTrack.accountNote})
                          </span>
                        ) : null}
                        {site.activeTrack ? (
                          <span className="inline-flex items-center gap-0.5">
                            <Users className="h-3 w-3" />
                            {site.activeTrack.memberDeviceIds.length} 设备
                          </span>
                        ) : null}
                        <span className="inline-flex items-center gap-0.5">
                          <Cookie className="h-3 w-3" />
                          {site.cookieCount}
                        </span>
                        <span className="inline-flex items-center gap-0.5">
                          <Database className="h-3 w-3" />
                          {site.localStorageCount}
                        </span>
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                        <span>版本：{shortId(site.latestVersionId, 14)}</span>
                        <span>·</span>
                        <span>来源：{site.sourceDeviceName || '-'}</span>
                        <span>·</span>
                        <span>更新：{formatRelativeTime(site.updatedAt)}</span>
                      </div>
                    </div>
                  </button>

                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-1.5 text-xs shrink-0 text-primary"
                    onClick={() => {
                      setSelectedSiteKey(site.siteKey);
                      setSelectedTrackId(site.activeTrack?.trackId || null);
                    }}>
                    Cookies
                    <ChevronRight className="ml-0.5 h-3.5 w-3.5" />
                  </Button>
                </div>

                {/* Clean Track Controls & Overflow Action Menu */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 pt-2 border-t border-border/60">
                  {isBlacklisted ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <ShieldBan className="h-3.5 w-3.5 text-rose-500" />
                      已加入黑名单，已阻断同步与多账号轮换
                    </span>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      {site.allTracks.length > 0 ? (
                        <select
                          aria-label={`切换 ${site.siteKey} 的同步轨道`}
                          value={site.activeTrack?.trackId || ''}
                          disabled={busyKey === `track:${site.siteKey}`}
                          onChange={e => handleSwitchTrack(site.siteKey, e.target.value)}
                          className="h-6 max-w-[165px] truncate rounded border border-input bg-background px-1.5 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
                          {site.allTracks.map((tr, idx) => (
                            <option key={tr.trackId} value={tr.trackId}>
                              #{idx + 1} {tr.label} ({tr.cookieCount}条)
                            </option>
                          ))}
                        </select>
                      ) : null}

                      {site.allTracks.length > 1 ? (
                        <Button
                          variant="default"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          disabled={busyKey === `rotate:${site.siteKey}`}
                          onClick={() => handleRotateAccount(site.siteKey)}
                          title="按顺序一键轮换到下一个账号并刷新页面">
                          <Repeat className="mr-1 h-3 w-3" />
                          轮换
                        </Button>
                      ) : null}

                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => {
                          setCreateAcctSite(site.siteKey);
                          setCreateAcctMode('clean_new');
                          setCreateAcctLabel('');
                          setCreateAcctNote('');
                        }}
                        title="新增多账号（清空页面登录新号 / 保存当前登录态）">
                        <UserPlus className="mr-1 h-3 w-3" />
                        新账号
                      </Button>

                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-1.5 text-[11px]"
                        disabled={busyKey === `sync:push:${site.siteKey}`}
                        onClick={() => handleSiteSync(site.siteKey, 'push')}
                        title="推送本机此站点变更">
                        <CloudUpload className="mr-0.5 h-3 w-3" />推
                      </Button>

                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-1.5 text-[11px]"
                        disabled={busyKey === `sync:pull:${site.siteKey}`}
                        onClick={() => handleSiteSync(site.siteKey, 'pull')}
                        title="拉取此站点远端最新状态">
                        <CloudDownload className="mr-0.5 h-3 w-3" />拉
                      </Button>
                    </div>
                  )}

                  <div className="flex items-center gap-1 shrink-0">
                    {onOpenAccounts && !isBlacklisted ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-primary"
                        onClick={() => onOpenAccounts(site.siteKey)}
                        title="在多账号管理中心管理该站全部账号">
                        <Users className="mr-1 h-3 w-3" />
                        账号
                      </Button>
                    ) : null}

                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="h-6 px-1.5 text-[11px]" title="更多站点操作">
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onClick={() => handleCopySiteCookies(site.siteKey, false)}>
                          <Copy className="mr-2 h-3.5 w-3.5" />
                          复制 Cookie Header
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleCopySiteCookies(site.siteKey, true)}>
                          <FileJson className="mr-2 h-3.5 w-3.5" />
                          复制 Cookies JSON
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleExportSiteCookies(site.siteKey)}>
                          <Download className="mr-2 h-3.5 w-3.5" />
                          导出 Cookies JSON
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setImportSiteKey(site.siteKey);
                            setImportModalOpen(true);
                          }}>
                          <Upload className="mr-2 h-3.5 w-3.5" />
                          导入 Cookies JSON
                        </DropdownMenuItem>
                        {onOpenLocalStorage ? (
                          <DropdownMenuItem
                            onClick={() =>
                              onOpenLocalStorage(site.siteKey, site.activeTrack?.trackId, site.activeTrack?.label)
                            }>
                            <Database className="mr-2 h-3.5 w-3.5" />
                            查看 LocalStorage
                          </DropdownMenuItem>
                        ) : null}
                        {!isBlacklisted ? (
                          <>
                            <DropdownMenuSeparator />
                            {site.activeTrack ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  setRenameTarget({
                                    siteKey: site.siteKey,
                                    trackId: site.activeTrack!.trackId,
                                    label: site.activeTrack!.label,
                                    accountNote: site.activeTrack!.accountNote || '',
                                  })
                                }>
                                <Tag className="mr-2 h-3.5 w-3.5" />
                                编辑账号名称与备注
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                              onClick={() => {
                                setSplitTargetSite(site.siteKey);
                                setSplitLabel('');
                              }}>
                              <GitBranch className="mr-2 h-3.5 w-3.5" />
                              拆分为独立维护轨道
                            </DropdownMenuItem>
                            {site.activeTrack && site.allTracks.length > 1 ? (
                              <DropdownMenuItem
                                className="text-rose-600 focus:text-rose-600"
                                disabled={busyKey === `del-acct:${site.activeTrack.trackId}`}
                                onClick={() =>
                                  handleDeleteAccount(site.siteKey, site.activeTrack!.trackId, site.activeTrack!.label)
                                }>
                                <Trash2 className="mr-2 h-3.5 w-3.5" />
                                删除当前账号
                              </DropdownMenuItem>
                            ) : null}
                          </>
                        ) : null}
                        {site.binding.state !== 'BLACKLISTED' && site.binding.state !== 'UNMANAGED' ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-amber-700 focus:text-amber-700 dark:text-amber-400"
                              onClick={() => setUnmanageTargetSite(site.siteKey)}>
                              <Unlink className="mr-2 h-3.5 w-3.5" />
                              移出同步管理
                            </DropdownMenuItem>
                          </>
                        ) : null}
                        {!isBlacklisted ? (
                          <DropdownMenuItem
                            className="text-rose-600 focus:text-rose-600"
                            disabled={busyKey === `bl:${site.siteKey}`}
                            onClick={() => handleQuickBlacklist(site.siteKey, 'device')}>
                            <Ban className="mr-2 h-3.5 w-3.5" />
                            加入本机黑名单
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add Managed Sites Modal */}
      <AddManagedSitesModal open={addSitesOpen} onClose={() => setAddSitesOpen(false)} onAdded={handleAfterMutation} />

      {/* Unmanage / Remove Site Confirmation Modal */}
      <UnmanageSiteModal
        siteKey={unmanageTargetSite}
        onClose={() => setUnmanageTargetSite(null)}
        onConfirm={handleConfirmUnmanage}
      />

      {/* Import Cookies Modal */}
      <JsonImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        title={importSiteKey ? `导入 Cookies JSON (${importSiteKey})` : '导入 Cookies JSON'}
        description="支持粘贴标准 Cookie JSON 数组或从文件读取，导入后将自动进入因果版本库同步。"
        placeholder='[{"name": "token", "value": "xxx", "domain": "github.com", "path": "/", "secure": true}]'
        onImport={handleImportCookies}
      />

      {/* Edit Account Name & Note Modal */}
      <Modal
        open={!!renameTarget}
        onClose={() => setRenameTarget(null)}
        title={`编辑账号信息 (${renameTarget?.siteKey || ''})`}
        description="设置账号别名与备注（如「公司账号」「主号 / 手机号尾号 1234」）。"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setRenameTarget(null)}>
              取消
            </Button>
            <Button size="sm" disabled={!renameTarget?.label.trim()} onClick={handleConfirmRename}>
              保存
            </Button>
          </>
        }>
        <div className="space-y-3 text-xs">
          <div className="space-y-1">
            <Label htmlFor="sites-rename-label" className="text-xs">
              账号名称 *
            </Label>
            <Input
              id="sites-rename-label"
              value={renameTarget?.label || ''}
              onChange={e => setRenameTarget(prev => (prev ? { ...prev, label: e.target.value } : null))}
              placeholder="输入账号名称"
              onKeyDown={e => {
                if (e.key === 'Enter') void handleConfirmRename();
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sites-rename-note" className="text-xs">
              账号备注（可选）
            </Label>
            <Input
              id="sites-rename-note"
              value={renameTarget?.accountNote || ''}
              onChange={e => setRenameTarget(prev => (prev ? { ...prev, accountNote: e.target.value } : null))}
              placeholder="例如：管理员权限 / 绑定邮箱或尾号"
              onKeyDown={e => {
                if (e.key === 'Enter') void handleConfirmRename();
              }}
            />
          </div>
        </div>
      </Modal>

      {/* Split Independent Track Modal */}
      <Modal
        open={!!splitTargetSite}
        onClose={() => setSplitTargetSite(null)}
        title={`拆分为独立轨道 (${splitTargetSite || ''})`}
        description="本机将为该站点创建一条独立同步轨道，不再与其他设备的原轨道互相覆盖。"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setSplitTargetSite(null)}>
              取消
            </Button>
            <Button size="sm" onClick={handleConfirmSplit}>
              确认拆分
            </Button>
          </>
        }>
        <Input
          value={splitLabel}
          onChange={e => setSplitLabel(e.target.value)}
          placeholder="自定义新轨道名称（可选）"
          onKeyDown={e => {
            if (e.key === 'Enter') handleConfirmSplit();
          }}
        />
      </Modal>
      {/* Create Multi-Account Track Modal */}
      <Modal
        open={!!createAcctSite}
        onClose={() => setCreateAcctSite(null)}
        title={`新增账号 (${createAcctSite || ''})`}
        description="支持无损保存当前登录态并清空浏览器以登录新账号（不会使原账号服务端登录态失效），方便随时一键轮换。"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setCreateAcctSite(null)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={busyKey === `create-acct:${createAcctSite || ''}`}
              onClick={handleConfirmCreateAccount}>
              {createAcctMode === 'clean_new' ? '创建并清空页面去登录' : '保存当前登录态'}
            </Button>
          </>
        }>
        <div className="space-y-3 text-xs">
          <div className="space-y-1.5">
            <div className="flex items-start gap-2 rounded-lg border border-border p-2.5 hover:bg-muted/30">
              <input
                id="sites-acct-mode-clean"
                type="radio"
                name="create-acct-mode"
                checked={createAcctMode === 'clean_new'}
                onChange={() => setCreateAcctMode('clean_new')}
                className="mt-0.5 cursor-pointer accent-primary"
              />
              <label htmlFor="sites-acct-mode-clean" className="min-w-0 flex-1 cursor-pointer">
                <span className="block font-medium text-foreground">新建空白账号（清空当前页面重新登录）</span>
                <span className="block text-[11px] text-muted-foreground">
                  推荐：自动保护当前账号登录态，仅清空本机浏览器对应 Cookie 并刷新网页以登录第二个账号
                </span>
              </label>
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-border p-2.5 hover:bg-muted/30">
              <input
                id="sites-acct-mode-save"
                type="radio"
                name="create-acct-mode"
                checked={createAcctMode === 'save_current'}
                onChange={() => setCreateAcctMode('save_current')}
                className="mt-0.5 cursor-pointer accent-primary"
              />
              <label htmlFor="sites-acct-mode-save" className="min-w-0 flex-1 cursor-pointer">
                <span className="block font-medium text-foreground">将当前浏览器登录态另存为新账号</span>
                <span className="block text-[11px] text-muted-foreground">
                  将当前网页已登录的 Cookie 复制保存为一条新的命名账号轨道
                </span>
              </label>
            </div>
          </div>
          <Input
            value={createAcctLabel}
            onChange={e => setCreateAcctLabel(e.target.value)}
            placeholder="账号名称（例如：超级管理员 / 运营号 B / 测试商户）"
            onKeyDown={e => {
              if (e.key === 'Enter') void handleConfirmCreateAccount();
            }}
          />
          <Input
            value={createAcctNote}
            onChange={e => setCreateAcctNote(e.target.value)}
            placeholder="账号备注（可选，如 角色权限 / 绑定邮箱或尾号）"
            onKeyDown={e => {
              if (e.key === 'Enter') void handleConfirmCreateAccount();
            }}
          />
        </div>
      </Modal>
    </div>
  );
};
