import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import type { AttentionItem } from '@sessionmesh/shared';
import { Button } from '@sessionmesh/ui';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  FolderKey,
  Info,
  Loader2,
  RefreshCw,
  Settings,
  Sliders,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { toast } from 'sonner';

export interface AttentionBannerProps {
  items: AttentionItem[];
  onRefreshAll: () => Promise<void>;
  onNavigateTab: (tab: 'sites' | 'conflicts' | 'history' | 'rules', siteKey?: string) => void;
  onOpenOptions: () => void;
}

export const AttentionBanner: React.FC<AttentionBannerProps> = ({
  items,
  onRefreshAll,
  onNavigateTab,
  onOpenOptions,
}) => {
  const [expanded, setExpanded] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!items || items.length === 0) {
    return null;
  }

  const hasError = items.some(i => i.severity === 'error');
  const hasWarning = items.some(i => i.severity === 'warning');
  const dismissibleCount = items.filter(i => i.dismissible).length;

  const handleDismiss = async (itemId: string, msg?: string) => {
    setBusyId(`dismiss:${itemId}`);
    try {
      await sidePanelApi.dismissAttentionItem(itemId);
      if (msg) toast.success(msg);
      await onRefreshAll();
    } catch (err) {
      toast.error(`关闭失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleRetryCookies = async (item: AttentionItem) => {
    setBusyId(item.id);
    try {
      const res = await sidePanelApi.retryFailedCookies(item.siteKey);
      if (res.failed === 0) {
        toast.success(`已重新写入 ${res.succeeded} 条 Cookie`);
      } else {
        toast.warning(`成功 ${res.succeeded} 条，仍有 ${res.failed} 条受阻`);
      }
      await onRefreshAll();
    } catch (err) {
      toast.error(`重试失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleRebuild = async (id: string) => {
    setBusyId(id);
    try {
      await sidePanelApi.rebuildIndex();
      toast.success('远端索引重建完成');
      await onRefreshAll();
    } catch (err) {
      toast.error(`重建失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleGc = async (id: string) => {
    setBusyId(id);
    try {
      const res = await sidePanelApi.garbageCollect();
      toast.success(`释放完成：移除旧事件 ${res.removedEventFiles} 个，回收墓碑 ${res.reclaimedTombstones} 条`);
      await onRefreshAll();
    } catch (err) {
      toast.error(`清理失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleForceReload = async (item: AttentionItem) => {
    if (item.tabId === undefined) return;
    setBusyId(item.id);
    try {
      await sidePanelApi.forceReloadTab(item.tabId);
      toast.success(`已刷新 ${item.siteKey || '目标'} 页面`);
      await onRefreshAll();
    } catch (err) {
      toast.error(`刷新失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleSync = async (id: string) => {
    setBusyId(id);
    try {
      const res = await sidePanelApi.syncNow();
      if (res.errorMessage) {
        toast.warning(`云端暂时繁忙，系统将继续后台自动退避重试：${res.errorMessage}`);
      } else {
        toast.success('同步重试完成');
      }
      await onRefreshAll();
    } catch (err) {
      toast.error(`同步失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const barClass = hasError
    ? 'border-rose-500/35 bg-rose-500/10 text-rose-900 dark:text-rose-200'
    : hasWarning
      ? 'border-amber-500/35 bg-amber-500/10 text-amber-900 dark:text-amber-200'
      : 'border-sky-500/35 bg-sky-500/10 text-sky-900 dark:text-sky-200';

  return (
    <div className={`shrink-0 border-b px-3 py-2 text-xs ${barClass}`}>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-semibold">
          {hasError ? (
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
          ) : hasWarning ? (
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          ) : (
            <Info className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
          )}
          <span>待处理事项（{items.length} 项）</span>
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5 opacity-70" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 opacity-70" />
          )}
        </button>

        {dismissibleCount > 0 ? (
          <button
            type="button"
            disabled={busyId !== null}
            onClick={() => void handleDismiss('all', '已忽略并关闭所有可关闭提醒')}
            className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50">
            <X className="h-3 w-3" />
            {dismissibleCount > 1 ? '全部忽略' : '忽略关闭'}
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div className="mt-2 max-h-48 space-y-1.5 overflow-y-auto pr-0.5">
          {items.map(item => {
            const isBusy = busyId === item.id || busyId === `dismiss:${item.id}`;
            return (
              <div
                key={item.id}
                className="flex items-start justify-between gap-2 rounded-md border border-border/80 bg-background px-2.5 py-2 text-foreground">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-medium leading-snug">{item.title}</div>
                  <p className="text-[11px] text-muted-foreground leading-snug break-words">{item.detail}</p>
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {item.kind === 'pending_decision' ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => onNavigateTab('sites', item.siteKey)}
                        className="h-6 px-2 text-[11px]">
                        前往选择版本
                        <ArrowRight className="ml-1 h-3 w-3" />
                      </Button>
                    ) : null}

                    {item.kind === 'conflict' ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => onNavigateTab('conflicts', item.siteKey)}
                        className="h-6 px-2 text-[11px]">
                        前往冲突中心处理
                        <ArrowRight className="ml-1 h-3 w-3" />
                      </Button>
                    ) : null}

                    {item.kind === 'apply_failed' ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => void handleRetryCookies(item)}
                        className="h-6 px-2 text-[11px]">
                        {busyId === item.id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-1 h-3 w-3" />
                        )}
                        重试写入
                      </Button>
                    ) : null}

                    {item.kind === 'corrupted_file' ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => void handleRebuild(item.id)}
                        className="h-6 px-2 text-[11px]">
                        {busyId === item.id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <Wrench className="mr-1 h-3 w-3" />
                        )}
                        重建索引
                      </Button>
                    ) : null}

                    {item.kind === 'storage_full' ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => void handleGc(item.id)}
                        className="h-6 px-2 text-[11px]">
                        {busyId === item.id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="mr-1 h-3 w-3" />
                        )}
                        清理历史 (GC)
                      </Button>
                    ) : null}

                    {item.kind === 'auth_error' || item.kind === 'decrypt_error' ? (
                      <Button type="button" size="sm" onClick={onOpenOptions} className="h-6 px-2 text-[11px]">
                        <Settings className="mr-1 h-3 w-3" />
                        打开控制中心
                      </Button>
                    ) : null}

                    {item.kind === 'latest_error' || item.kind === 'retry_task' || item.kind === 'pending_upload' ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => void handleSync(item.id)}
                        className="h-6 px-2 text-[11px]">
                        {busyId === item.id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-1 h-3 w-3" />
                        )}
                        立即同步
                      </Button>
                    ) : null}

                    {item.kind === 'deferred_reload' ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => void handleForceReload(item)}
                        className="h-6 px-2 text-[11px]">
                        {busyId === item.id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-1 h-3 w-3" />
                        )}
                        立即刷新该页
                      </Button>
                    ) : null}

                    {item.kind === 'cookie_expiring' ? (
                      <>
                        {item.siteKey ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                              const url = `https://${item.siteKey}`;
                              if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
                                chrome.tabs.create({ url });
                              } else {
                                window.open(url, '_blank');
                              }
                            }}
                            className="h-6 px-2 text-[11px]">
                            <ExternalLink className="mr-1 h-3 w-3" />
                            打开站点续期
                          </Button>
                        ) : null}
                        {item.siteKey ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => onNavigateTab('sites', item.siteKey)}
                            className="h-6 px-2 text-[11px]">
                            查看 Cookies
                          </Button>
                        ) : null}
                      </>
                    ) : null}

                    {item.kind === 'local_dir_permission_needed' ? (
                      <Button type="button" size="sm" onClick={onOpenOptions} className="h-6 px-2 text-[11px]">
                        <FolderKey className="mr-1 h-3 w-3" />
                        前往控制中心恢复目录授权
                      </Button>
                    ) : null}

                    {item.kind === 'indexeddb_quota_exceeded' ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => onNavigateTab('rules', item.siteKey)}
                        className="h-6 px-2 text-[11px]">
                        <Sliders className="mr-1 h-3 w-3" />
                        调整同步规则
                      </Button>
                    ) : null}

                    {item.kind === 'ephemeral_track_expired' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={isBusy}
                        onClick={() => void handleDismiss(item.id, '已关闭临时账号清理通知')}
                        className="h-6 px-2 text-[11px]">
                        <Clock className="mr-1 h-3 w-3" />
                        知道了
                      </Button>
                    ) : null}
                  </div>
                </div>

                {item.dismissible ||
                item.kind === 'cookie_expiring' ||
                item.kind === 'indexeddb_quota_exceeded' ||
                item.kind === 'ephemeral_track_expired' ? (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleDismiss(item.id, '已关闭该提示')}
                    title="忽略并关闭此提示"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
