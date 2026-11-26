import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import { parseManualSiteKeysInput } from '@console/lib/format';
import type { BrowserCandidateSite } from '@sessionmesh/shared';
import { Button, Input } from '@sessionmesh/ui';
import { CheckCircle2, Cookie, Globe, Loader2, Plus, RefreshCw, Search, ShieldBan, X } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from './common/Badge';
import { Modal } from './common/Modal';

export interface AddManagedSitesModalProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => Promise<void> | void;
}

export const AddManagedSitesModal: React.FC<AddManagedSitesModalProps> = ({ open, onClose, onAdded }) => {
  const [candidates, setCandidates] = useState<BrowserCandidateSite[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [manualInput, setManualInput] = useState('');
  const [manualSites, setManualSites] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const scanCandidates = useCallback(async () => {
    setLoading(true);
    setScanError(null);
    try {
      const list = await sidePanelApi.scanBrowserCandidateSites();
      setCandidates(Array.isArray(list) ? list : []);
    } catch (err) {
      setScanError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSelectedKeys(new Set());
    setManualInput('');
    setManualSites([]);
    void scanCandidates();
  }, [open, scanCandidates]);

  const query = search.trim().toLowerCase();

  const filteredCandidates = useMemo(() => {
    return candidates.filter(item => {
      if (!query) return true;
      return item.siteKey.toLowerCase().includes(query) || item.domains.some(d => d.toLowerCase().includes(query));
    });
  }, [candidates, query]);

  const selectableFiltered = useMemo(
    () => filteredCandidates.filter(c => !c.alreadyManaged && !c.blacklisted),
    [filteredCandidates],
  );

  const alreadyManagedSet = useMemo(
    () => new Set(candidates.filter(c => c.alreadyManaged).map(c => c.siteKey)),
    [candidates],
  );

  const blacklistedSet = useMemo(
    () => new Set(candidates.filter(c => c.blacklisted).map(c => c.siteKey)),
    [candidates],
  );

  const toggleCandidate = (siteKey: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(siteKey)) next.delete(siteKey);
      else next.add(siteKey);
      return next;
    });
  };

  const handleSelectAllSelectable = () => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      for (const item of selectableFiltered) {
        next.add(item.siteKey);
      }
      return next;
    });
  };

  const handleClearSelection = () => {
    setSelectedKeys(new Set());
    setManualSites([]);
  };

  const handleStageManualDomain = () => {
    const parsed = parseManualSiteKeysInput(manualInput);
    if (parsed.length === 0) {
      toast.warning('请输入有效域名，例如 example.com');
      return;
    }
    const blocked = parsed.filter(sk => blacklistedSet.has(sk));
    const already = parsed.filter(sk => alreadyManagedSet.has(sk));
    const usable = parsed.filter(sk => !blacklistedSet.has(sk) && !alreadyManagedSet.has(sk));

    if (blocked.length > 0) {
      toast.warning(`以下域名在黑名单中，无法纳管：${blocked.join(', ')}`);
    }
    if (already.length > 0 && usable.length === 0) {
      toast.info(`域名已在同步管理列表中：${already.join(', ')}`);
    }
    if (usable.length > 0) {
      setManualSites(prev => Array.from(new Set([...prev, ...usable])));
      setManualInput('');
    }
  };

  const handleRemoveManualSite = (siteKey: string) => {
    setManualSites(prev => prev.filter(item => item !== siteKey));
  };

  const pendingManualFromInput = useMemo(() => {
    if (!manualInput.trim()) return [];
    return parseManualSiteKeysInput(manualInput).filter(sk => !blacklistedSet.has(sk) && !alreadyManagedSet.has(sk));
  }, [manualInput, blacklistedSet, alreadyManagedSet]);

  const combinedSiteKeys = useMemo(() => {
    return Array.from(new Set([...selectedKeys, ...manualSites, ...pendingManualFromInput]));
  }, [selectedKeys, manualSites, pendingManualFromInput]);

  const handleConfirmAdd = async () => {
    if (combinedSiteKeys.length === 0) {
      toast.warning('请先勾选至少一个网站，或手动输入域名');
      return;
    }
    setSubmitting(true);
    try {
      const result = await sidePanelApi.addManagedSites(combinedSiteKeys);
      const addedCount = result?.added?.length ?? combinedSiteKeys.length;
      const pendingCount = result?.pendingDecisions?.length ?? 0;
      if (pendingCount > 0) {
        toast.success(`已纳入 ${addedCount} 个网站同步管理（其中 ${pendingCount} 个站点需确认双端轨道）`);
      } else {
        toast.success(`已将 ${addedCount} 个网站纳入同步管理并开始同步`);
      }
      await onAdded();
      onClose();
    } catch (err) {
      toast.error(`纳入同步管理失败：${extractErrorMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title="添加同步网站"
      description="从当前浏览器已有 Cookie 的网站中勾选，或手动输入域名预先纳管；仅纳入管理的网站会被同步。"
      maxWidthClass="max-w-lg"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            已选择 <strong className="text-foreground">{combinedSiteKeys.length}</strong> 个网站
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button size="sm" disabled={submitting || combinedSiteKeys.length === 0} onClick={handleConfirmAdd}>
              {submitting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="mr-1 h-3.5 w-3.5" />
              )}
              纳入同步管理{combinedSiteKeys.length > 0 ? ` (${combinedSiteKeys.length})` : ''}
            </Button>
          </div>
        </div>
      }>
      <div className="space-y-3 text-xs">
        {/* Manual Pre-Add Domain Box */}
        <div className="rounded-lg border border-border bg-muted/25 p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground">手动输入域名预先纳管</span>
            <span className="text-[10px] text-muted-foreground">登录前即可预先添加</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              value={manualInput}
              onChange={e => setManualInput(e.target.value)}
              placeholder="例如 example.com 或 github.com（多个用逗号分隔）"
              className="h-8 flex-1 text-xs font-mono bg-background"
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleStageManualDomain();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2.5 text-xs shrink-0"
              disabled={!manualInput.trim()}
              onClick={handleStageManualDomain}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              加入
            </Button>
          </div>
          {manualSites.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {manualSites.map(sk => (
                <span
                  key={sk}
                  className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary">
                  {sk}
                  <button
                    type="button"
                    onClick={() => handleRemoveManualSite(sk)}
                    className="rounded-full p-0.5 hover:bg-primary/20"
                    aria-label={`移除手动域名 ${sk}`}>
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {/* Browser Candidate Search & Bulk Select */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="搜索浏览器已有网站或子域名..."
                className="h-8 pl-8 pr-7 text-xs bg-background"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="清除搜索">
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={scanCandidates}
              disabled={loading}
              title="重新扫描浏览器 Cookie">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              扫描到 {candidates.length} 个浏览器网站（可选 {selectableFiltered.length} 个）
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSelectAllSelectable}
                disabled={selectableFiltered.length === 0}
                className="font-medium text-primary hover:underline disabled:opacity-40">
                全选可选
              </button>
              <button
                type="button"
                onClick={handleClearSelection}
                disabled={selectedKeys.size === 0 && manualSites.length === 0}
                className="hover:text-foreground disabled:opacity-40">
                清空
              </button>
            </div>
          </div>
        </div>

        {/* Candidate List */}
        {loading && candidates.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin text-primary" />
            正在扫描本机浏览器已保存 Cookie 的网站...
          </div>
        ) : scanError ? (
          <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-300 space-y-2">
            <p>扫描浏览器网站失败：{scanError}</p>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={scanCandidates}>
              重试扫描
            </Button>
          </div>
        ) : filteredCandidates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 py-6 px-3 text-center text-xs text-muted-foreground">
            <Globe className="mx-auto mb-1.5 h-5 w-5 opacity-60" />
            <p>{candidates.length === 0 ? '当前浏览器暂无可扫描的非噪声 Cookie 网站' : '没有匹配的候选网站'}</p>
            <p className="mt-0.5 text-[11px]">您仍可直接在上方输入框手动添加任意域名预先纳管。</p>
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto divide-y divide-border/70 rounded-lg border border-border bg-card">
            {filteredCandidates.map(item => {
              const disabled = item.alreadyManaged || item.blacklisted;
              const checked = selectedKeys.has(item.siteKey);
              const domainsPreview = item.domains.slice(0, 3).join(', ');
              const moreDomains = item.domains.length > 3 ? ` 等 ${item.domains.length} 个域` : '';

              return (
                <label
                  key={item.siteKey}
                  className={`flex items-start gap-2.5 px-3 py-2 transition-colors ${
                    disabled
                      ? 'cursor-not-allowed bg-muted/25 opacity-65'
                      : checked
                        ? 'cursor-pointer bg-primary/[0.06]'
                        : 'cursor-pointer hover:bg-muted/40'
                  }`}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={checked}
                    onChange={() => toggleCandidate(item.siteKey)}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded accent-primary"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-semibold text-foreground">{item.siteKey}</span>
                      <StatusBadge tone="neutral">
                        <Cookie className="h-2.5 w-2.5" />
                        {item.cookieCount}
                      </StatusBadge>
                      {item.alreadyManaged ? (
                        <StatusBadge tone="success">
                          <CheckCircle2 className="h-2.5 w-2.5" />
                          已纳管
                        </StatusBadge>
                      ) : null}
                      {item.blacklisted ? (
                        <StatusBadge tone="neutral">
                          <ShieldBan className="h-2.5 w-2.5" />
                          黑名单
                        </StatusBadge>
                      ) : null}
                    </div>
                    {item.domains.length > 0 ? (
                      <p
                        className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground"
                        title={item.domains.join(', ')}>
                        {domainsPreview}
                        {moreDomains}
                      </p>
                    ) : null}
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
};
