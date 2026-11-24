import { extractErrorMessage, sidePanelApi } from '@src/lib/api';
import { useBannerPrefs } from '@src/lib/bannerPrefs';
import {
  buildCookieHeader,
  copyToClipboard,
  downloadJsonFile,
  formatCookieExpiry,
  formatDateTime,
  formatRelativeTime,
  getBindingMeta,
  getCookieSyncStatusMeta,
  getSameSiteLabel,
  shortId,
  toBrowserCookieInput,
} from '@src/lib/format';
import type { BrowserCookieInput, CookieRecord, DeleteScope, SiteSummaryView } from '@sessionmesh/shared';
import { Button, Input } from '@sessionmesh/ui';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  CloudDownload,
  CloudUpload,
  Copy,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FileJson,
  GitBranch,
  Globe,
  History,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Tag,
  Trash2,
  Unlink,
  Upload,
  X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from './common/Badge';
import { EmptyState } from './common/EmptyState';
import { JsonImportModal } from './common/JsonImportModal';
import { Modal } from './common/Modal';
import { ThreeScopeDeleteModal } from './common/ThreeScopeDeleteModal';
import { VersionHistoryDrawer } from './common/VersionHistoryDrawer';
import { CookieEditorModal } from './CookieEditorModal';
import { UnmanageSiteModal } from './UnmanageSiteModal';
import type { UnmanageSiteScope } from './UnmanageSiteModal';

export interface CookieDetailViewProps {
  site: SiteSummaryView;
  globalSearch: string;
  onBack: () => void;
  onSiteMutated: () => Promise<void>;
}

type CookieQuickFilter = 'all' | 'active' | 'failed' | 'deleted' | 'httpOnly' | 'secure' | 'session';

export const CookieDetailView: React.FC<CookieDetailViewProps> = ({ site, globalSearch, onBack, onSiteMutated }) => {
  const [cookies, setCookies] = useState<CookieRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [localSearch, setLocalSearch] = useState('');
  const [quickFilter, setQuickFilter] = useState<CookieQuickFilter>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [faviconError, setFaviconError] = useState(false);

  // Modals & Drawers
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingCookie, setEditingCookie] = useState<CookieRecord | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<CookieRecord[]>([]);
  const [historyTarget, setHistoryTarget] = useState<CookieRecord | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [renameTrackOpen, setRenameTrackOpen] = useState(false);
  const [renameTrackValue, setRenameTrackValue] = useState('');
  const [splitTrackOpen, setSplitTrackOpen] = useState(false);
  const [splitTrackLabel, setSplitTrackLabel] = useState('');
  const [unmanageOpen, setUnmanageOpen] = useState(false);

  const { isBannerVisible, dismissBanner } = useBannerPrefs();

  const loadCookies = useCallback(async () => {
    setLoading(true);
    try {
      const list = await sidePanelApi.getSiteCookies(site.siteKey, site.activeTrack?.trackId);
      setCookies(list || []);
      setSelectedIds(prev => {
        const valid = new Set((list || []).map(c => c.logicalId));
        return new Set([...prev].filter(id => valid.has(id)));
      });
    } catch (err) {
      toast.error(`加载 Cookies 失败：${extractErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, [site.siteKey, site.activeTrack?.trackId]);

  useEffect(() => {
    loadCookies();
  }, [loadCookies]);

  const effectiveSearch = (localSearch || globalSearch).trim().toLowerCase();

  const filteredCookies = useMemo(() => {
    return cookies
      .filter(ck => {
        if (quickFilter === 'active' && ck.deleted) return false;
        if (quickFilter === 'failed' && ck.applyResult?.accepted !== false && ck.syncStatus !== 'APPLY_FAILED') {
          return false;
        }
        if (quickFilter === 'deleted' && !ck.deleted) return false;
        if (quickFilter === 'httpOnly' && !ck.httpOnly) return false;
        if (quickFilter === 'secure' && !ck.secure) return false;
        if (quickFilter === 'session' && !ck.session) return false;

        if (!effectiveSearch) return true;
        return (
          ck.name.toLowerCase().includes(effectiveSearch) ||
          ck.value.toLowerCase().includes(effectiveSearch) ||
          ck.domain.toLowerCase().includes(effectiveSearch) ||
          ck.path.toLowerCase().includes(effectiveSearch) ||
          (ck.sourceDeviceName || '').toLowerCase().includes(effectiveSearch) ||
          (ck.version?.versionId || '').toLowerCase().includes(effectiveSearch)
        );
      })
      .sort((a, b) => Number(a.deleted) - Number(b.deleted) || a.name.localeCompare(b.name));
  }, [cookies, quickFilter, effectiveSearch]);

  const allFilteredSelected = filteredCookies.length > 0 && filteredCookies.every(ck => selectedIds.has(ck.logicalId));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredCookies.map(c => c.logicalId)));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleReveal = (id: string) => {
    setRevealedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSaveCookie = async (input: BrowserCookieInput) => {
    const saved = await sidePanelApi.upsertCookie(site.siteKey, input);
    if (saved.applyResult?.accepted === false) {
      toast.warning(`Cookie 已保存到轨道，但本机写入未通过校验：${saved.applyResult.reason || '浏览器拒绝'}`);
    } else {
      toast.success(`已保存 Cookie「${input.name}」并同步至当前轨道`);
    }
    await loadCookies();
    await onSiteMutated();
  };

  const handleApplyCookie = async (cookie: CookieRecord) => {
    setBusyAction(`apply:${cookie.logicalId}`);
    try {
      const updated = await sidePanelApi.applyCookieToBrowser(cookie.logicalId);
      const res = updated?.applyResult;
      if (res?.accepted) {
        const extra = res.degradedPartitionKey ? '（已自动降级 PartitionKey）' : '';
        toast.success(`回读校验通过：${cookie.name} 已生效${extra}`);
      } else if (res && res.accepted === false) {
        toast.error(`写入回读校验失败 (${cookie.name})：${res.reason || '浏览器未接受该 Cookie'}`);
      } else {
        toast.success(`已向浏览器写入 ${cookie.name}`);
      }
      await loadCookies();
    } catch (err) {
      toast.error(`应用失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleBatchApply = async () => {
    const targets = cookies.filter(c => selectedIds.has(c.logicalId) && !c.deleted);
    if (targets.length === 0) return;
    setBusyAction('batch-apply');
    let okCount = 0;
    let failCount = 0;
    try {
      for (const ck of targets) {
        try {
          const updated = await sidePanelApi.applyCookieToBrowser(ck.logicalId);
          if (updated?.applyResult?.accepted === false) failCount++;
          else okCount++;
        } catch {
          failCount++;
        }
      }
      if (failCount === 0) {
        toast.success(`批量写入完成：${okCount} 条均通过回读校验`);
      } else {
        toast.warning(`批量写入完成：${okCount} 条通过，${failCount} 条回读失败`);
      }
      await loadCookies();
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmDelete = async (scope: DeleteScope) => {
    const ids = deleteTargets.map(c => c.logicalId);
    if (ids.length === 0) return;
    await sidePanelApi.deleteCookies(ids, scope, site.siteKey);
    const scopeLabel =
      scope === 'local_only' ? '仅本机浏览器' : scope === 'remote_track_only' ? '仅云端当前轨道' : '全设备 Tombstone';
    toast.success(`已删除 ${ids.length} 条 Cookie（作用域：${scopeLabel}）`);
    setSelectedIds(prev => {
      const next = new Set(prev);
      ids.forEach(id => next.delete(id));
      return next;
    });
    await loadCookies();
    await onSiteMutated();
  };

  const handleSiteSync = async (direction: 'push' | 'pull') => {
    setBusyAction(`sync:${direction}`);
    try {
      const res = await sidePanelApi.syncNow({ siteKey: site.siteKey, direction });
      if (res.errorMessage) {
        toast.warning(`${site.siteKey} 暂时无法连接云端，系统将继续后台自动重试：${res.errorMessage}`);
      } else {
        const refreshHint = direction === 'pull' && res.appliedCookies > 0 ? '，刷新对应网页即可生效' : '';
        toast.success(
          direction === 'push'
            ? `推送完成：上传 ${res.pushedEvents} 个事件`
            : `拉取完成：拉取 ${res.pulledEvents} 个事件，写入 ${res.appliedCookies} 条，失败 ${res.failedCookies} 条${refreshHint}`,
        );
      }
      await loadCookies();
      await onSiteMutated();
    } catch (err) {
      toast.error(`单站同步失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleCopyHeader = async (subset?: CookieRecord[]) => {
    const list = (subset ?? cookies).filter(c => !c.deleted);
    if (list.length === 0) {
      toast.warning('没有可复制的有效 Cookie');
      return;
    }
    const ok = await copyToClipboard(buildCookieHeader(list));
    if (ok) toast.success(`已复制 ${list.length} 条 Cookie Header`);
    else toast.error('复制到剪贴板失败');
  };

  const handleCopyJson = async (subset?: CookieRecord[]) => {
    const list = (subset ?? cookies).filter(c => !c.deleted).map(toBrowserCookieInput);
    if (list.length === 0) {
      toast.warning('没有可复制的有效 Cookie');
      return;
    }
    const ok = await copyToClipboard(JSON.stringify(list, null, 2));
    if (ok) toast.success(`已复制 ${list.length} 条 Cookie JSON`);
    else toast.error('复制到剪贴板失败');
  };

  const handleExportJson = async () => {
    setBusyAction('export');
    try {
      const exported = await sidePanelApi.exportCookiesJson(site.siteKey);
      downloadJsonFile(`sessionmesh-cookies-${site.siteKey}.json`, exported);
      toast.success(`已导出 ${exported.length} 条 Cookie JSON`);
    } catch (err) {
      toast.error(`导出失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleImportJson = async (parsed: unknown) => {
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown }).cookies)
        ? (parsed as { cookies: unknown[] }).cookies
        : null;
    if (!arr || arr.length === 0) {
      throw new Error('JSON 必须是包含 Cookie 对象的非空数组');
    }
    const normalized: BrowserCookieInput[] = arr.map((item: Record<string, unknown>) => ({
      name: String(item.name ?? ''),
      value: String(item.value ?? ''),
      domain: String(item.domain ?? site.siteKey),
      path: String(item.path ?? '/'),
      secure: Boolean(item.secure ?? true),
      httpOnly: Boolean(item.httpOnly ?? false),
      sameSite: (item.sameSite as BrowserCookieInput['sameSite']) || 'unspecified',
      session: Boolean(item.session ?? !item.expirationDate),
      expirationDate: typeof item.expirationDate === 'number' ? item.expirationDate : undefined,
      hostOnly: Boolean(item.hostOnly ?? false),
      storeId: typeof item.storeId === 'string' && item.storeId !== 'default' ? item.storeId : undefined,
      partitionKey: (item.partitionKey as BrowserCookieInput['partitionKey']) ?? null,
    }));
    const count = await sidePanelApi.importCookiesJson(normalized, site.siteKey);
    toast.success(`已导入 ${count} 条 Cookie 到 ${site.siteKey}`);
    await loadCookies();
    await onSiteMutated();
  };

  const handleSwitchTrack = async (targetTrackId: string) => {
    if (!targetTrackId || targetTrackId === site.activeTrack?.trackId) return;
    setBusyAction('track-switch');
    try {
      await sidePanelApi.switchSiteTrack(site.siteKey, targetTrackId);
      toast.success('已切换同步轨道（切换前已自动保存本地还原点）');
      await onSiteMutated();
      await loadCookies();
    } catch (err) {
      toast.error(`切换轨道失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmRenameTrack = async () => {
    if (!site.activeTrack || !renameTrackValue.trim()) return;
    setBusyAction('track-rename');
    try {
      await sidePanelApi.renameSiteTrack(site.siteKey, site.activeTrack.trackId, renameTrackValue.trim());
      toast.success('轨道名称已更新');
      setRenameTrackOpen(false);
      await onSiteMutated();
    } catch (err) {
      toast.error(`重命名失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmSplitTrack = async () => {
    setBusyAction('track-split');
    try {
      await sidePanelApi.splitSiteIndependent(site.siteKey, splitTrackLabel.trim() || undefined);
      toast.success('已拆分为本机独立维护轨道');
      setSplitTrackOpen(false);
      setSplitTrackLabel('');
      await onSiteMutated();
      await loadCookies();
    } catch (err) {
      toast.error(`拆分独立轨道失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmUnmanage = async (siteKey: string, scope: UnmanageSiteScope) => {
    await sidePanelApi.removeManagedSite(siteKey, scope);
    toast.success(
      scope === 'device_unmanage'
        ? `已将 ${siteKey} 移出本机同步管理（不影响其他设备）`
        : `已将 ${siteKey} 从整个同步空间移除`,
    );
    await onSiteMutated();
    onBack();
  };

  const bindingMeta = getBindingMeta(site.binding.state);
  const selectedCookies = cookies.filter(c => selectedIds.has(c.logicalId));

  return (
    <div className="flex h-full flex-col">
      {/* Site Detail Top Bar */}
      <div className="shrink-0 border-b border-border bg-card/60 px-3 py-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Button variant="outline" size="icon" className="h-7 w-7 shrink-0" onClick={onBack} title="返回站点列表">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {site.favIconUrl && !faviconError ? (
              <img
                src={site.favIconUrl}
                alt=""
                className="h-5 w-5 shrink-0 rounded"
                onError={() => setFaviconError(true)}
              />
            ) : (
              <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <h2 className="truncate text-sm font-semibold">{site.siteKey}</h2>
                <StatusBadge tone={bindingMeta.tone}>{bindingMeta.label}</StatusBadge>
              </div>
              <p className="truncate text-[11px] text-muted-foreground">
                轨道：{site.activeTrack?.label || '未绑定'} · {site.activeTrack?.memberDeviceIds?.length || 0} 台设备 ·{' '}
                {cookies.filter(c => !c.deleted).length} 条生效 Cookie
              </p>
            </div>
          </div>

          <Button
            size="sm"
            className="h-7 px-2 text-xs shrink-0"
            onClick={() => {
              setEditingCookie(null);
              setEditorOpen(true);
            }}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            新建
          </Button>
        </div>

        {/* Track Switcher & Actions Row */}
        <div className="flex flex-wrap items-center gap-1.5">
          {site.allTracks.length > 0 ? (
            <select
              aria-label="切换站点同步轨道"
              value={site.activeTrack?.trackId || ''}
              disabled={busyAction === 'track-switch'}
              onChange={e => handleSwitchTrack(e.target.value)}
              className="h-7 max-w-[185px] truncate rounded-md border border-input bg-background px-2 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
              {site.allTracks.map(tr => (
                <option key={tr.trackId} value={tr.trackId}>
                  {tr.label} ({tr.cookieCount}条 · {tr.memberDeviceIds.length}设备)
                </option>
              ))}
            </select>
          ) : null}

          {site.activeTrack ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => {
                setRenameTrackValue(site.activeTrack?.label || '');
                setRenameTrackOpen(true);
              }}
              title="重命名当前轨道">
              <Tag className="mr-1 h-3 w-3" />
              重命名
            </Button>
          ) : null}

          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => setSplitTrackOpen(true)}
            title="拆分为独立维护轨道">
            <GitBranch className="mr-1 h-3 w-3" />
            独立维护
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={busyAction === 'sync:push'}
            onClick={() => handleSiteSync('push')}>
            <CloudUpload className="mr-1 h-3 w-3" />
            推送
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={busyAction === 'sync:pull'}
            onClick={() => handleSiteSync('pull')}>
            <CloudDownload className="mr-1 h-3 w-3" />
            拉取
          </Button>

          <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={() => handleCopyHeader()}>
            <Copy className="mr-1 h-3 w-3" />
            Header
          </Button>

          <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={() => handleCopyJson()}>
            <FileJson className="mr-1 h-3 w-3" />
            复制 JSON
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={busyAction === 'export'}
            onClick={handleExportJson}>
            <Download className="mr-1 h-3 w-3" />
            导出
          </Button>

          <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setImportOpen(true)}>
            <Upload className="mr-1 h-3 w-3" />
            导入
          </Button>

          {site.binding.state !== 'BLACKLISTED' && site.binding.state !== 'UNMANAGED' ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px] border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
              onClick={() => setUnmanageOpen(true)}
              title="移出本机管理或从整个同步空间移除">
              <Unlink className="mr-1 h-3 w-3" />
              移出管理
            </Button>
          ) : null}
        </div>

        {/* Dismissible Rolling Token Damping Notice */}
        {site.rollingTokenDamped && isBannerVisible('cookie_detail_rolling_token', 'degraded') ? (
          <div className="rounded-lg border border-amber-500/35 bg-amber-500/[0.08] px-2.5 py-2 text-[11px] text-amber-900 dark:text-amber-200">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-1.5 min-w-0">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>
                  该站点当前触发了 <strong>滚动令牌阻尼保护</strong>，短时高频刷新 Cookie 会被自动合并防抖。
                </span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => void dismissBanner('cookie_detail_rolling_token')}
                  className="rounded px-1 py-0.5 text-[10px] hover:bg-amber-500/20">
                  不再提示
                </button>
                <button
                  type="button"
                  onClick={() => void dismissBanner('cookie_detail_rolling_token')}
                  className="rounded p-0.5 hover:bg-amber-500/20"
                  aria-label="关闭滚动令牌提示">
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Search & Filter Row */}
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={localSearch}
              onChange={e => setLocalSearch(e.target.value)}
              placeholder="按名称、值、域名、路径或版本号筛选 Cookie..."
              className="h-7 pl-7 text-xs bg-background"
            />
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={loadCookies} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar pb-0.5">
          {(
            [
              ['all', '全部'],
              ['active', '生效中'],
              ['failed', '写入失败'],
              ['httpOnly', 'HttpOnly'],
              ['secure', 'Secure'],
              ['session', 'Session'],
              ['deleted', '已删除'],
            ] as Array<[CookieQuickFilter, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setQuickFilter(key)}
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                quickFilter === key
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}>
              {label}
            </button>
          ))}
        </div>

        {/* Batch Selection Toolbar */}
        <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px]">
          <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
            <input
              type="checkbox"
              checked={allFilteredSelected}
              onChange={toggleSelectAll}
              className="h-3.5 w-3.5 rounded accent-primary"
            />
            <span>
              全选当前 ({filteredCookies.length}){selectedIds.size > 0 ? ` · 已选 ${selectedIds.size} 项` : ''}
            </span>
          </label>

          {selectedIds.size > 0 ? (
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={busyAction === 'batch-apply'}
                onClick={handleBatchApply}>
                <Play className="mr-1 h-3 w-3" />
                批量应用
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => handleCopyHeader(selectedCookies)}>
                复制 Header
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => setDeleteTargets(selectedCookies)}>
                <Trash2 className="mr-1 h-3 w-3" />
                删除 ({selectedIds.size})
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Cookie List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading && cookies.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在读取 {site.siteKey} 的 Cookie 记录...
          </div>
        ) : filteredCookies.length === 0 ? (
          <EmptyState
            icon={<Globe className="h-5 w-5" />}
            title="没有匹配的 Cookie"
            description="你可以调整筛选条件、从云端拉取，或手动新建 / 导入 Cookie。"
          />
        ) : (
          filteredCookies.map(ck => {
            const expanded = expandedIds.has(ck.logicalId);
            const revealed = revealedIds.has(ck.logicalId);
            const syncMeta = getCookieSyncStatusMeta(ck.syncStatus);
            const applyFailed = ck.applyResult?.accepted === false;
            const applyOk = ck.applyResult?.accepted === true;

            return (
              <div
                key={ck.logicalId}
                className={`rounded-xl border p-2.5 text-xs transition-colors ${
                  ck.deleted
                    ? 'border-border/60 bg-muted/25 opacity-75'
                    : applyFailed
                      ? 'border-rose-500/40 bg-rose-500/[0.04]'
                      : 'border-border bg-card'
                }`}>
                {/* Cookie Row Header */}
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(ck.logicalId)}
                    onChange={() => toggleSelect(ck.logicalId)}
                    className="mt-1 h-3.5 w-3.5 shrink-0 rounded accent-primary"
                  />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono font-semibold text-foreground break-all">{ck.name}</span>
                          <StatusBadge tone={syncMeta.tone}>{syncMeta.label}</StatusBadge>
                          {ck.deleted ? <StatusBadge tone="danger">Tombstone</StatusBadge> : null}
                          {applyOk ? (
                            <StatusBadge tone="success">
                              <CheckCircle2 className="h-3 w-3" />
                              回读已验证
                            </StatusBadge>
                          ) : null}
                          {applyFailed ? (
                            <StatusBadge tone="danger">
                              <AlertCircle className="h-3 w-3" />
                              写入失败
                            </StatusBadge>
                          ) : null}
                        </div>
                        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground break-all">
                          {ck.hostOnly ? '[HostOnly] ' : ''}
                          {ck.domain}
                          {ck.path}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => toggleExpand(ck.logicalId)}
                        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title={expanded ? '收起完整属性' : '展开完整属性'}>
                        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </button>
                    </div>

                    {/* Value Preview */}
                    <div className="flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 py-1">
                      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90">
                        {revealed
                          ? ck.value || '<空>'
                          : ck.value.length > 18
                            ? `${ck.value.slice(0, 12)}••••••${ck.value.slice(-4)}`
                            : ck.value || '<空>'}
                      </code>
                      <button
                        type="button"
                        onClick={() => toggleReveal(ck.logicalId)}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        title={revealed ? '隐藏完整值' : '显示完整值'}>
                        {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await copyToClipboard(ck.value);
                          if (ok) toast.success(`已复制 ${ck.name} 的值`);
                        }}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        title="复制值">
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* Attribute Chips */}
                    <div className="flex flex-wrap items-center gap-1 text-[10px]">
                      {ck.secure ? <StatusBadge tone="success">Secure</StatusBadge> : null}
                      {ck.httpOnly ? <StatusBadge tone="info">HttpOnly</StatusBadge> : null}
                      <StatusBadge tone="neutral">SameSite: {getSameSiteLabel(ck.sameSite)}</StatusBadge>
                      <StatusBadge tone="neutral">{ck.session ? 'Session' : 'Persistent'}</StatusBadge>
                      {ck.hostOnly ? <StatusBadge tone="neutral">HostOnly</StatusBadge> : null}
                      {ck.partitionKey?.topLevelSite ? (
                        <StatusBadge tone="primary">CHIPS: {ck.partitionKey.topLevelSite}</StatusBadge>
                      ) : null}
                    </div>

                    {/* Apply Failure Reason Highlight */}
                    {applyFailed && ck.applyResult?.reason ? (
                      <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-700 dark:text-rose-300">
                        回读校验失败原因：{ck.applyResult.reason}
                      </div>
                    ) : null}

                    {/* Meta & Quick Action Row */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-border/60 text-[11px] text-muted-foreground">
                      <span className="truncate">
                        {ck.sourceDeviceName || shortId(ck.sourceDevice, 10)} · v:{shortId(ck.version?.versionId, 12)} ·{' '}
                        {formatRelativeTime(ck.updatedAt)}
                      </span>
                      <div className="flex items-center gap-1">
                        {!ck.deleted ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-1.5 text-[11px]"
                            disabled={busyAction === `apply:${ck.logicalId}`}
                            onClick={() => handleApplyCookie(ck)}
                            title="应用到浏览器并执行回读校验">
                            {busyAction === `apply:${ck.logicalId}` ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <Play className="mr-1 h-3 w-3" />
                            )}
                            应用
                          </Button>
                        ) : null}
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-1.5 text-[11px]"
                          onClick={() => {
                            setEditingCookie(ck);
                            setEditorOpen(true);
                          }}>
                          <Edit3 className="mr-1 h-3 w-3" />
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-1.5 text-[11px]"
                          onClick={() => setHistoryTarget(ck)}>
                          <History className="mr-1 h-3 w-3" />
                          历史
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600"
                          onClick={() => setDeleteTargets([ck])}
                          title="选择作用域删除">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    {/* Full Expanded Attribute Inspector */}
                    {expanded ? (
                      <div className="mt-2 rounded-lg border border-border bg-muted/30 p-2.5 text-[11px] space-y-1.5">
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                          <div>
                            <span className="text-muted-foreground">域名：</span>
                            <span className="font-mono break-all">{ck.domain}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">路径：</span>
                            <span className="font-mono">{ck.path}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">过期时间：</span>
                            <span>{formatCookieExpiry(ck.expirationDate, ck.session)}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">存储区 (storeScope)：</span>
                            <span className="font-mono">{ck.storeScope || 'default'}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Secure / HttpOnly：</span>
                            <span>
                              {String(ck.secure)} / {String(ck.httpOnly)}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">HostOnly / SameSite：</span>
                            <span>
                              {String(ck.hostOnly)} / {ck.sameSite}
                            </span>
                          </div>
                          <div className="col-span-2">
                            <span className="text-muted-foreground">PartitionKey：</span>
                            <span className="font-mono">
                              {ck.partitionKey?.topLevelSite
                                ? `${ck.partitionKey.topLevelSite} (crossSite=${String(!!ck.partitionKey.hasCrossSiteAncestor)})`
                                : '无'}
                            </span>
                          </div>
                          <div className="col-span-2">
                            <span className="text-muted-foreground">版本 ID：</span>
                            <span className="font-mono break-all">{ck.version?.versionId || '-'}</span>
                          </div>
                          <div className="col-span-2">
                            <span className="text-muted-foreground">来源设备 / 更新时间：</span>
                            <span>
                              {ck.sourceDeviceName || ck.sourceDevice} · {formatDateTime(ck.updatedAt)}
                            </span>
                          </div>
                          {ck.applyResult ? (
                            <div className="col-span-2">
                              <span className="text-muted-foreground">最近回读校验：</span>
                              <span
                                className={
                                  ck.applyResult.accepted
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-rose-600 dark:text-rose-400'
                                }>
                                {ck.applyResult.accepted ? '通过' : `失败 (${ck.applyResult.reason || '未知原因'})`}
                              </span>
                              <span className="text-muted-foreground">
                                {' '}
                                · {formatDateTime(ck.applyResult.verifiedAt)}
                                {ck.applyResult.degradedPartitionKey ? ' · 已降级 PartitionKey' : ''}
                              </span>
                            </div>
                          ) : null}
                        </div>
                        <div className="pt-1 border-t border-border/60">
                          <span className="text-muted-foreground">完整值：</span>
                          <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-1.5 font-mono text-[10px] border border-border/70">
                            {ck.value || '<空>'}
                          </pre>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Modals & Drawers */}
      <CookieEditorModal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        siteKey={site.siteKey}
        initialCookie={editingCookie}
        onSave={handleSaveCookie}
      />

      <ThreeScopeDeleteModal
        open={deleteTargets.length > 0}
        onClose={() => setDeleteTargets([])}
        itemTypeLabel="Cookie"
        itemNames={deleteTargets.map(c => `${c.name} (${c.domain})`)}
        onConfirm={handleConfirmDelete}
      />

      <VersionHistoryDrawer
        open={!!historyTarget}
        onClose={() => setHistoryTarget(null)}
        title={historyTarget?.name || ''}
        siteKey={site.siteKey}
        objectId={historyTarget?.logicalId}
        onRestored={async () => {
          await loadCookies();
          await onSiteMutated();
        }}
      />

      <JsonImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={`导入 Cookies JSON (${site.siteKey})`}
        description="支持粘贴 Cookie 对象数组或由 SessionMesh 导出的 JSON 文件，导入后会自动写入当前轨道并触发同步。"
        placeholder='[{"name": "session", "value": "abc", "domain": "example.com", "path": "/", "secure": true, "httpOnly": true}]'
        onImport={handleImportJson}
      />

      {/* Rename Track Modal */}
      <Modal
        open={renameTrackOpen}
        onClose={() => setRenameTrackOpen(false)}
        title={`重命名轨道 (${site.siteKey})`}
        description="例如改为「工作账号」「个人主号」「测试小号」，方便多设备识别。"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setRenameTrackOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={!renameTrackValue.trim() || busyAction === 'track-rename'}
              onClick={handleConfirmRenameTrack}>
              保存名称
            </Button>
          </>
        }>
        <Input
          value={renameTrackValue}
          onChange={e => setRenameTrackValue(e.target.value)}
          placeholder="输入新轨道名称"
          onKeyDown={e => {
            if (e.key === 'Enter') handleConfirmRenameTrack();
          }}
        />
      </Modal>

      {/* Split Independent Track Modal */}
      <Modal
        open={splitTrackOpen}
        onClose={() => setSplitTrackOpen(false)}
        title={`拆分为独立轨道 (${site.siteKey})`}
        description="拆分后本机将拥有独立的同步轨道，不再与其他设备的原轨道互相覆盖，其他设备以后也可主动选择跟随此新轨道。"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setSplitTrackOpen(false)}>
              取消
            </Button>
            <Button size="sm" disabled={busyAction === 'track-split'} onClick={handleConfirmSplitTrack}>
              确认拆分
            </Button>
          </>
        }>
        <Input
          value={splitTrackLabel}
          onChange={e => setSplitTrackLabel(e.target.value)}
          placeholder="新轨道名称（留空则使用默认设备名）"
          onKeyDown={e => {
            if (e.key === 'Enter') handleConfirmSplitTrack();
          }}
        />
      </Modal>

      <UnmanageSiteModal
        siteKey={unmanageOpen ? site.siteKey : null}
        onClose={() => setUnmanageOpen(false)}
        onConfirm={handleConfirmUnmanage}
      />
    </div>
  );
};
