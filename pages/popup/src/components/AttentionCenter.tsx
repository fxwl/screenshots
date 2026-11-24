import type { AttentionItem, PendingSiteDecision } from '@sessionmesh/core';
import { unwrapCommand } from '@sessionmesh/shared';
import { Badge, Button, Input } from '@sessionmesh/ui';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  CloudUpload,
  Info,
  Loader2,
  PanelRightOpen,
  RefreshCw,
  Settings,
  Trash2,
  Unlock,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { InlineDecisions } from './InlineDecisions';
import { extractErrorMessage } from '../utils/helpers';

export interface AttentionCenterProps {
  items: AttentionItem[];
  pendingDecisionsCount: number;
  activeSpaceId?: string;
  currentSiteKey?: string | null;
  onRefresh: () => Promise<void>;
  onOpenOptions: () => void;
  onOpenSidePanelTab: (tab: 'sites' | 'conflicts' | 'history') => void;
}

export function AttentionCenter({
  items,
  pendingDecisionsCount,
  activeSpaceId,
  currentSiteKey,
  onRefresh,
  onOpenOptions,
  onOpenSidePanelTab,
}: AttentionCenterProps) {
  const [expanded, setExpanded] = useState(true);
  const [pendingList, setPendingList] = useState<PendingSiteDecision[]>([]);
  const [loadingDecisions, setLoadingDecisions] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [decryptPass, setDecryptPass] = useState('');

  useEffect(() => {
    if (pendingDecisionsCount <= 0) {
      setPendingList([]);
      return;
    }
    let active = true;
    setLoadingDecisions(true);
    void unwrapCommand<PendingSiteDecision[]>({ type: 'GET_PENDING_DECISIONS' })
      .then(list => {
        if (active) {
          setPendingList(Array.isArray(list) ? list : []);
        }
      })
      .catch(() => {
        if (active) setPendingList([]);
      })
      .finally(() => {
        if (active) setLoadingDecisions(false);
      });
    return () => {
      active = false;
    };
  }, [pendingDecisionsCount]);

  const nonDecisionItems = items.filter(item => item.kind !== 'pending_decision');
  const totalCount = pendingDecisionsCount + nonDecisionItems.length;
  if (totalCount <= 0) {
    return null;
  }

  const hasError = items.some(item => item.severity === 'error');
  const hasWarning = pendingDecisionsCount > 0 || items.some(item => item.severity === 'warning');
  const dismissibleItems = nonDecisionItems.filter(item => item.dismissible);

  const handleDismiss = async (itemId: string, successMsg?: string) => {
    setBusyId(`dismiss:${itemId}`);
    try {
      await unwrapCommand({ type: 'DISMISS_ATTENTION_ITEM', itemId });
      if (successMsg) toast.success(successMsg);
      await onRefresh();
    } catch (err) {
      toast.error(`关闭失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleRetryCookies = async (item: AttentionItem) => {
    setBusyId(item.id);
    try {
      const res = await unwrapCommand<{ retried: number; succeeded: number; failed: number }>({
        type: 'RETRY_FAILED_COOKIES',
        siteKey: item.siteKey,
      });
      if ((res?.failed ?? 0) === 0) {
        toast.success(`已成功重新写入 ${res?.succeeded ?? 0} 条 Cookie`);
      } else {
        toast.warning(
          `重试完成：成功 ${res?.succeeded ?? 0} 条，仍有 ${res?.failed ?? 0} 条被浏览器拦截（可点击忽略关闭）`,
        );
      }
      await onRefresh();
    } catch (err) {
      toast.error(`重试写入失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleResolveConflict = async (item: AttentionItem, choose: 'local' | 'remote') => {
    if (!item.conflictId) return;
    setBusyId(`${item.id}:${choose}`);
    try {
      await unwrapCommand({
        type: 'RESOLVE_CONFLICT',
        conflictId: item.conflictId,
        choose,
      });
      toast.success(`${item.siteKey || ''} 已确认采用${choose === 'local' ? '本机' : '云端'}版本并同步`);
      await onRefresh();
    } catch (err) {
      toast.error(`处理冲突失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleRebuildIndex = async (itemId: string) => {
    setBusyId(itemId);
    try {
      await unwrapCommand({ type: 'WEBDAV_REBUILD_INDEX' });
      toast.success('远端索引重建完成');
      await onRefresh();
    } catch (err) {
      toast.error(`重建索引失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleGarbageCollect = async (itemId: string) => {
    setBusyId(itemId);
    try {
      const res = await unwrapCommand<{ removedEventFiles: number; reclaimedTombstones: number }>({
        type: 'WEBDAV_GARBAGE_COLLECT',
      });
      toast.success(
        `空间清理完成：移除旧事件 ${res?.removedEventFiles ?? 0} 个，回收墓碑 ${res?.reclaimedTombstones ?? 0} 条`,
      );
      await onRefresh();
    } catch (err) {
      toast.error(`清理失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleSyncNow = async (itemId: string) => {
    setBusyId(itemId);
    try {
      const res = await unwrapCommand<{
        pushedEvents: number;
        pulledEvents: number;
        appliedCookies: number;
        errorMessage?: string;
        errorCode?: string;
      }>({ type: 'SYNC_NOW' });
      if (res?.errorMessage) {
        toast.warning(`云端暂时繁忙，系统将继续后台自动退避重试：${res.errorMessage}`);
      } else {
        toast.success(
          `同步完成：上传 ${res?.pushedEvents ?? 0}，拉取 ${res?.pulledEvents ?? 0}，应用 ${res?.appliedCookies ?? 0}`,
        );
      }
      await onRefresh();
    } catch (err) {
      toast.error(`同步失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleForceReload = async (item: AttentionItem) => {
    if (item.tabId === undefined) return;
    setBusyId(item.id);
    try {
      const res = await unwrapCommand<{ reloaded: boolean }>({
        type: 'FORCE_RELOAD_TAB',
        tabId: item.tabId,
      });
      if (res?.reloaded) {
        toast.success(`已刷新 ${item.siteKey || '目标'} 页面使新登录态生效`);
      } else {
        toast.info('目标标签页已关闭或已跳转，已清除提醒');
      }
      await onRefresh();
    } catch (err) {
      toast.error(`刷新失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleVerifyDecryptPassword = async (itemId: string) => {
    if (!decryptPass.trim()) {
      toast.warning('请输入空间端到端加密主密码');
      return;
    }
    setBusyId(itemId);
    try {
      await unwrapCommand({
        type: 'UNLOCK_SESSION',
        encryptionPassword: decryptPass,
        spaceId: activeSpaceId,
      });
      setDecryptPass('');
      toast.success('主密码验证通过，已恢复同步');
      await onRefresh();
    } catch (err) {
      toast.error(`密码验证失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const containerBorder = hasError
    ? 'border-destructive/50 bg-destructive/[0.07]'
    : hasWarning
      ? 'border-amber-500/50 bg-amber-500/[0.08]'
      : 'border-sky-500/40 bg-sky-500/[0.07]';

  const headerTextClass = hasError
    ? 'text-destructive'
    : hasWarning
      ? 'text-amber-900 dark:text-amber-200'
      : 'text-sky-900 dark:text-sky-200';

  return (
    <section aria-label="待处理事项清单" className={`rounded-xl border p-3 space-y-2.5 shadow-sm ${containerBorder}`}>
      {/* Header Row */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded(prev => !prev)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {hasError ? (
            <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
          ) : hasWarning ? (
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          ) : (
            <Info className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
          )}
          <span className={`text-xs font-bold ${headerTextClass}`}>待处理事项（{totalCount} 项）</span>
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5 shrink-0 opacity-70" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          )}
        </button>

        {dismissibleItems.length > 0 ? (
          <button
            type="button"
            disabled={busyId !== null}
            onClick={() => void handleDismiss('all', '已忽略并关闭所有可关闭提醒')}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-background/80 hover:text-foreground disabled:opacity-50">
            <X className="h-3 w-3" />
            {dismissibleItems.length > 1 ? '全部忽略关闭' : '忽略关闭'}
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div className="max-h-[268px] space-y-2 overflow-y-auto pr-0.5">
          {/* 1. Pending Site Decisions (Auto-Expanded Inline Resolver) */}
          {pendingDecisionsCount > 0 ? (
            <div className="space-y-2">
              {loadingDecisions ? (
                <div className="flex items-center justify-center rounded-lg border border-border bg-background py-3 text-xs text-muted-foreground">
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  正在加载 {pendingDecisionsCount} 个待决策网站...
                </div>
              ) : (
                <InlineDecisions
                  decisions={pendingList}
                  currentSiteKey={currentSiteKey}
                  onResolved={async () => {
                    await onRefresh();
                    const next = await unwrapCommand<PendingSiteDecision[]>({
                      type: 'GET_PENDING_DECISIONS',
                    }).catch(() => []);
                    setPendingList(Array.isArray(next) ? next : []);
                  }}
                />
              )}
            </div>
          ) : null}

          {/* 2. Actionable Items List */}
          {nonDecisionItems.map(item => {
            const isItemBusy =
              busyId === item.id ||
              busyId === `dismiss:${item.id}` ||
              busyId === `${item.id}:local` ||
              busyId === `${item.id}:remote`;

            return (
              <div
                key={item.id}
                className="rounded-lg border border-border/90 bg-background p-2.5 text-xs space-y-1.5 shadow-2xs">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-foreground">{item.title}</span>
                      <Badge
                        variant={
                          item.severity === 'error' ? 'destructive' : item.severity === 'warning' ? 'warning' : 'info'
                        }
                        className="px-1.5 py-0 text-[9px]">
                        {item.severity === 'error' ? '错误' : item.severity === 'warning' ? '需关注' : '待执行'}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground break-words">
                      {item.detail}
                    </p>
                    {item.suggestion ? (
                      <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/85 break-words">
                        建议：{item.suggestion}
                      </p>
                    ) : null}
                  </div>

                  {item.dismissible ? (
                    <button
                      type="button"
                      disabled={isItemBusy}
                      onClick={() => void handleDismiss(item.id, '已关闭该提示')}
                      title="忽略并关闭此提示"
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>

                {/* Kind-Specific Direct Actions */}
                {item.kind === 'conflict' ? (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <Button
                      type="button"
                      size="sm"
                      disabled={isItemBusy}
                      onClick={() => void handleResolveConflict(item, 'local')}
                      className="h-6 px-2 text-[11px]">
                      {busyId === `${item.id}:local` ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Check className="mr-1 h-3 w-3" />
                      )}
                      保留本机版
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isItemBusy}
                      onClick={() => void handleResolveConflict(item, 'remote')}
                      className="h-6 px-2 text-[11px]">
                      {busyId === `${item.id}:remote` ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Check className="mr-1 h-3 w-3" />
                      )}
                      采用云端版
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onOpenSidePanelTab('conflicts')}
                      className="h-6 px-2 text-[11px]">
                      <PanelRightOpen className="mr-1 h-3 w-3" />
                      对比详情
                    </Button>
                  </div>
                ) : null}

                {item.kind === 'apply_failed' ? (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <Button
                      type="button"
                      size="sm"
                      disabled={isItemBusy}
                      onClick={() => void handleRetryCookies(item)}
                      className="h-6 px-2 text-[11px]">
                      {busyId === item.id ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1 h-3 w-3" />
                      )}
                      重试写入
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isItemBusy}
                      onClick={() => void handleDismiss(item.id, `已忽略 ${item.siteKey || ''} 的受阻 Cookie 提醒`)}
                      className="h-6 px-2 text-[11px]">
                      <X className="mr-1 h-3 w-3" />
                      忽略并关闭
                    </Button>
                  </div>
                ) : null}

                {item.kind === 'corrupted_file' ? (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <Button
                      type="button"
                      size="sm"
                      disabled={isItemBusy}
                      onClick={() => void handleRebuildIndex(item.id)}
                      className="h-6 px-2 text-[11px]">
                      {busyId === item.id ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Wrench className="mr-1 h-3 w-3" />
                      )}
                      重建索引修复
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isItemBusy}
                      onClick={() => void handleDismiss(item.id, '已忽略历史损坏文件提醒')}
                      className="h-6 px-2 text-[11px]">
                      <X className="mr-1 h-3 w-3" />
                      忽略并关闭
                    </Button>
                  </div>
                ) : null}

                {item.kind === 'storage_full' ? (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <Button
                      type="button"
                      size="sm"
                      disabled={isItemBusy}
                      onClick={() => void handleGarbageCollect(item.id)}
                      className="h-6 px-2 text-[11px]">
                      {busyId === item.id ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="mr-1 h-3 w-3" />
                      )}
                      清理历史释放空间 (GC)
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isItemBusy}
                      onClick={() => void handleDismiss(item.id, '已恢复写入并关闭提示')}
                      className="h-6 px-2 text-[11px]">
                      关闭提示
                    </Button>
                  </div>
                ) : null}

                {item.kind === 'auth_error' ? (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <Button type="button" size="sm" onClick={onOpenOptions} className="h-6 px-2 text-[11px]">
                      <Settings className="mr-1 h-3 w-3" />
                      打开控制中心修改连接
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isItemBusy}
                      onClick={() => void handleDismiss(item.id, '已关闭认证错误提示')}
                      className="h-6 px-2 text-[11px]">
                      关闭提示
                    </Button>
                  </div>
                ) : null}

                {item.kind === 'decrypt_error' ? (
                  <div className="space-y-1.5 pt-0.5">
                    <div className="flex gap-1.5">
                      <Input
                        type="password"
                        value={decryptPass}
                        onChange={e => setDecryptPass(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') void handleVerifyDecryptPassword(item.id);
                        }}
                        placeholder="输入正确的空间加密主密码"
                        className="h-7 text-xs"
                      />
                      <Button
                        type="button"
                        size="sm"
                        disabled={isItemBusy}
                        onClick={() => void handleVerifyDecryptPassword(item.id)}
                        className="h-7 shrink-0 px-2.5 text-[11px]">
                        {busyId === item.id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <Unlock className="mr-1 h-3 w-3" />
                        )}
                        重新验证
                      </Button>
                    </div>
                  </div>
                ) : null}

                {item.kind === 'latest_error' || item.kind === 'retry_task' || item.kind === 'offline_pending' ? (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <Button
                      type="button"
                      size="sm"
                      disabled={isItemBusy}
                      onClick={() => void handleSyncNow(item.id)}
                      className="h-6 px-2 text-[11px]">
                      {busyId === item.id ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1 h-3 w-3" />
                      )}
                      立即同步重试
                    </Button>
                    {item.dismissible ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={isItemBusy}
                        onClick={() => void handleDismiss(item.id, '已关闭该提示')}
                        className="h-6 px-2 text-[11px]">
                        关闭提示
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                {item.kind === 'pending_upload' ? (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <Button
                      type="button"
                      size="sm"
                      disabled={isItemBusy}
                      onClick={() => void handleSyncNow(item.id)}
                      className="h-6 px-2 text-[11px]">
                      {busyId === item.id ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <CloudUpload className="mr-1 h-3 w-3" />
                      )}
                      立即上传同步
                    </Button>
                  </div>
                ) : null}

                {item.kind === 'deferred_reload' ? (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <Button
                      type="button"
                      size="sm"
                      disabled={isItemBusy}
                      onClick={() => void handleForceReload(item)}
                      className="h-6 px-2 text-[11px]">
                      {busyId === item.id ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1 h-3 w-3" />
                      )}
                      立即刷新该页
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isItemBusy}
                      onClick={() => void handleDismiss(item.id, '已关闭暂缓刷新提醒')}
                      className="h-6 px-2 text-[11px]">
                      稍后手动刷新
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
