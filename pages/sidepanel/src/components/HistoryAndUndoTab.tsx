import { extractErrorMessage, sidePanelApi } from '@src/lib/api';
import { useBannerPrefs } from '@src/lib/bannerPrefs';
import {
  copyToClipboard,
  downloadJsonFile,
  formatDateTime,
  formatRelativeTime,
  getBindingMeta,
  getOperationMeta,
  shortId,
} from '@src/lib/format';
import type { EventOperation, LogEntry, SafetyUndoPoint, SyncEvent } from '@sessionmesh/shared';
import { Button } from '@sessionmesh/ui';
import {
  AlertCircle,
  AlertTriangle,
  Cookie,
  Copy,
  Database,
  Download,
  FileText,
  History,
  Info,
  Lightbulb,
  Loader2,
  RefreshCw,
  RotateCcw,
  Undo2,
  X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from './common/Badge';
import { EmptyState } from './common/EmptyState';
import { Modal } from './common/Modal';

export interface HistoryAndUndoTabProps {
  globalSearch: string;
  onStatusChanged: () => Promise<void> | void;
  refreshSignal: number;
}

type HistorySubView = 'undo' | 'events' | 'logs';

function formatUndoReason(reason: string): string {
  if (!reason) return '覆盖前自动备份';
  if (reason.startsWith('switch_track:')) return '切换网站轨道前自动备份';
  if (reason.startsWith('use_remote_track:')) return '采用云端版本覆盖前自动备份';
  if (reason.startsWith('restore_backup:')) return '恢复远端加密备份前自动备份';
  if (reason.startsWith('batch_decision')) return '批量决策覆盖前自动备份';
  return reason;
}

export const HistoryAndUndoTab: React.FC<HistoryAndUndoTabProps> = ({
  globalSearch,
  onStatusChanged,
  refreshSignal,
}) => {
  const [subView, setSubView] = useState<HistorySubView>('undo');
  const [undoPoints, setUndoPoints] = useState<SafetyUndoPoint[]>([]);
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Filters
  const [siteFilter, setSiteFilter] = useState<string>('ALL');
  const [opFilter, setOpFilter] = useState<'ALL' | EventOperation>('ALL');
  const [logLevelFilter, setLogLevelFilter] = useState<'ALL' | 'error' | 'warn' | 'info'>('ALL');
  const [confirmUndo, setConfirmUndo] = useState<SafetyUndoPoint | null>(null);

  const { isBannerVisible, dismissBanner } = useBannerPrefs();

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [undoRes, histRes] = await Promise.all([
        sidePanelApi.getUndoPoints(),
        sidePanelApi.getHistoryAndLogs({ limit: 200 }),
      ]);
      setUndoPoints([...(undoRes || [])].sort((a, b) => b.createdAt - a.createdAt));
      setEvents([...(histRes?.events || [])].sort((a, b) => b.createdAt - a.createdAt));
      setLogs([...(histRes?.logs || [])].sort((a, b) => b.timestamp - a.timestamp));
    } catch (err) {
      toast.error(`加载历史与日志失败：${extractErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll, refreshSignal]);

  const handleApplyUndo = async (point: SafetyUndoPoint) => {
    setBusyId(`undo:${point.undoId}`);
    try {
      await sidePanelApi.applyUndoPoint(point.undoId);
      toast.success(`已撤销覆盖并恢复 ${point.siteKey} 的本机原登录态`);
      setConfirmUndo(null);
      await loadAll();
      await onStatusChanged();
    } catch (err) {
      toast.error(`恢复还原点失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleRestoreEvent = async (event: SyncEvent) => {
    setBusyId(`restore:${event.eventId}`);
    try {
      await sidePanelApi.restoreHistoricalEvent(event.eventId);
      toast.success(`已为 ${event.siteKey} 生成版本恢复事件并应用`);
      await loadAll();
      await onStatusChanged();
    } catch (err) {
      toast.error(`恢复历史版本失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleExportLogs = (copyOnly = false) => {
    const payload = {
      exportedAt: new Date().toISOString(),
      totalLogs: filteredLogs.length,
      logs: filteredLogs,
    };
    if (copyOnly) {
      copyToClipboard(JSON.stringify(payload, null, 2)).then(ok => {
        if (ok) toast.success('已复制脱敏诊断日志 JSON');
        else toast.error('复制失败');
      });
    } else {
      downloadJsonFile(`sessionmesh-diagnostics-${Date.now()}.json`, payload);
      toast.success(`已导出 ${filteredLogs.length} 条脱敏诊断日志`);
    }
  };

  const query = globalSearch.trim().toLowerCase();

  const distinctEventSites = useMemo(() => {
    return Array.from(new Set(events.map(e => e.siteKey).filter(Boolean))).sort();
  }, [events]);

  const filteredUndoPoints = useMemo(() => {
    return undoPoints.filter(p => {
      if (!query) return true;
      return p.siteKey.toLowerCase().includes(query) || p.reason.toLowerCase().includes(query);
    });
  }, [undoPoints, query]);

  const filteredEvents = useMemo(() => {
    return events.filter(ev => {
      if (siteFilter !== 'ALL' && ev.siteKey !== siteFilter) return false;
      if (opFilter !== 'ALL' && ev.operation !== opFilter) return false;
      if (!query) return true;
      const objName = ev.cookieData?.name || ev.localStorageData?.key || ev.objectId;
      return (
        ev.siteKey.toLowerCase().includes(query) ||
        objName.toLowerCase().includes(query) ||
        (ev.deviceName || ev.deviceId).toLowerCase().includes(query) ||
        (ev.version?.versionId || '').toLowerCase().includes(query)
      );
    });
  }, [events, siteFilter, opFilter, query]);

  const filteredLogs = useMemo(() => {
    return logs.filter(l => {
      if (logLevelFilter !== 'ALL' && l.level !== logLevelFilter) return false;
      if (!query) return true;
      return (
        l.message.toLowerCase().includes(query) ||
        l.phase.toLowerCase().includes(query) ||
        (l.code || '').toLowerCase().includes(query) ||
        (l.siteKey || '').toLowerCase().includes(query) ||
        (l.suggestion || '').toLowerCase().includes(query)
      );
    });
  }, [logs, logLevelFilter, query]);

  return (
    <div className="flex h-full flex-col">
      {/* 3 Sub-view Navigation */}
      <div className="shrink-0 border-b border-border bg-card/50 px-3 py-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSubView('undo')}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              subView === 'undo'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}>
            <Undo2 className="h-3 w-3" />
            后悔药 ({undoPoints.length})
          </button>
          <button
            type="button"
            onClick={() => setSubView('events')}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              subView === 'events'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}>
            <History className="h-3 w-3" />
            版本事件 ({events.length})
          </button>
          <button
            type="button"
            onClick={() => setSubView('logs')}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              subView === 'logs'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}>
            <FileText className="h-3 w-3" />
            诊断日志 ({logs.length})
          </button>
        </div>

        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={loadAll} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Sub-view Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading && undoPoints.length === 0 && events.length === 0 && logs.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在读取还原点、历史事件与诊断日志...
          </div>
        ) : subView === 'undo' ? (
          /* Sub-view A: Local Safety Undo Points */
          <>
            {isBannerVisible('history_undo_intro_banner', 'general') ? (
              <div className="rounded-xl border border-sky-500/30 bg-sky-500/[0.07] p-3 text-xs space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-semibold text-sky-800 dark:text-sky-300">
                    <Undo2 className="h-4 w-4 shrink-0" />
                    <span>本地安全还原点（覆盖前自动“后悔药”）</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 text-sky-800 dark:text-sky-200">
                    <button
                      type="button"
                      onClick={() => void dismissBanner('history_undo_intro_banner')}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-sky-500/15">
                      不再提示
                    </button>
                    <button
                      type="button"
                      onClick={() => void dismissBanner('history_undo_intro_banner')}
                      className="rounded p-0.5 hover:bg-sky-500/15"
                      aria-label="关闭还原点说明">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-sky-800/85 dark:text-sky-200/85 leading-relaxed">
                  每次执行「采用远端轨道覆盖本机」「切换站点轨道」或「批量决策」前，SessionMesh
                  都会自动备份您本机该站点的原有 Cookies、LocalStorage 与轨道绑定关系（保留最近 20
                  条），随时可一键无损撤销恢复。
                </p>
              </div>
            ) : null}

            {filteredUndoPoints.length === 0 ? (
              <EmptyState
                icon={<Undo2 className="h-5 w-5" />}
                title="暂无本地安全还原点"
                description="当执行轨道切换或远端覆盖本机操作时，系统会自动在此保存还原快照。"
              />
            ) : (
              <div className="space-y-2.5">
                {filteredUndoPoints.map(point => {
                  const lsOriginsCount = Object.keys(point.localStorageByOrigin || {}).length;
                  const prevBindingMeta = point.previousBinding ? getBindingMeta(point.previousBinding.state) : null;
                  return (
                    <div key={point.undoId} className="rounded-xl border border-border bg-card p-3 text-xs space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-foreground">{point.siteKey}</span>
                            {prevBindingMeta ? (
                              <StatusBadge tone={prevBindingMeta.tone}>原状态：{prevBindingMeta.label}</StatusBadge>
                            ) : null}
                          </div>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{formatUndoReason(point.reason)}</p>
                        </div>
                        <span
                          className="shrink-0 text-[11px] text-muted-foreground"
                          title={formatDateTime(point.createdAt)}>
                          {formatRelativeTime(point.createdAt)}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Cookie className="h-3 w-3" />
                          {point.cookies.length} 条原 Cookie
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Database className="h-3 w-3" />
                          {lsOriginsCount} 个原 LocalStorage Origin
                        </span>
                        <span className="font-mono text-[10px]">{formatDateTime(point.createdAt)}</span>
                      </div>

                      <div className="flex justify-end pt-1.5 border-t border-border/60">
                        <Button
                          size="sm"
                          variant="default"
                          className="h-7 px-2.5 text-xs"
                          disabled={busyId === `undo:${point.undoId}`}
                          onClick={() => setConfirmUndo(point)}>
                          {busyId === `undo:${point.undoId}` ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          一键撤销覆盖恢复本机原登录态
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : subView === 'events' ? (
          /* Sub-view B: Version Event History */
          <>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="按站点筛选事件"
                value={siteFilter}
                onChange={e => setSiteFilter(e.target.value)}
                className="h-7 max-w-[170px] rounded-md border border-input bg-background px-2 text-xs text-foreground">
                <option value="ALL">全部站点 ({distinctEventSites.length})</option>
                {distinctEventSites.map(s => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>

              <select
                aria-label="按操作类型筛选事件"
                value={opFilter}
                onChange={e => setOpFilter(e.target.value as 'ALL' | EventOperation)}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground">
                <option value="ALL">全部操作</option>
                <option value="CREATE">新建 (CREATE)</option>
                <option value="UPDATE">更新 (UPDATE)</option>
                <option value="DELETE">删除 (DELETE)</option>
                <option value="RESTORE">恢复 (RESTORE)</option>
                <option value="SNAPSHOT">快照 (SNAPSHOT)</option>
                <option value="CHECKPOINT">检查点 (CHECKPOINT)</option>
              </select>
            </div>

            {filteredEvents.length === 0 ? (
              <EmptyState
                icon={<History className="h-5 w-5" />}
                title="暂无匹配的版本事件"
                description="同步过程中每次新建、更新、删除或恢复都会记录不可变因果版本事件。"
              />
            ) : (
              <div className="space-y-2">
                {filteredEvents.map(ev => {
                  const opMeta = getOperationMeta(ev.operation);
                  const objName =
                    ev.objectType === 'cookie'
                      ? ev.cookieData?.name || ev.objectId
                      : ev.localStorageData?.key || ev.objectId;
                  const canRestore = ev.operation !== 'SNAPSHOT' && ev.operation !== 'CHECKPOINT';

                  return (
                    <div key={ev.eventId} className="rounded-xl border border-border bg-card p-2.5 text-xs space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                          <StatusBadge tone={opMeta.tone}>{opMeta.label}</StatusBadge>
                          <StatusBadge tone="neutral">{ev.objectType === 'cookie' ? 'Cookie' : 'LS'}</StatusBadge>
                          <span className="font-semibold text-foreground">{ev.siteKey}</span>
                          <code className="max-w-[160px] truncate rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                            {objName}
                          </code>
                        </div>
                        <span
                          className="shrink-0 text-[10px] text-muted-foreground"
                          title={formatDateTime(ev.createdAt)}>
                          {formatRelativeTime(ev.createdAt)}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span className="truncate">
                          设备：{ev.deviceName || shortId(ev.deviceId, 12)} (#{ev.deviceSeq}) · v:
                          <span className="font-mono">{shortId(ev.version?.versionId, 14)}</span>
                        </span>
                        {canRestore ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-[11px] shrink-0"
                            disabled={busyId === `restore:${ev.eventId}`}
                            onClick={() => handleRestoreEvent(ev)}>
                            {busyId === `restore:${ev.eventId}` ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCcw className="mr-1 h-3 w-3" />
                            )}
                            恢复此版本
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          /* Sub-view C: Diagnostic & Error Logs */
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                {(
                  [
                    ['ALL', '全部'],
                    ['error', '错误'],
                    ['warn', '警告'],
                    ['info', '信息'],
                  ] as Array<['ALL' | 'error' | 'warn' | 'info', string]>
                ).map(([lvl, label]) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => setLogLevelFilter(lvl)}
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                      logLevelFilter === lvl
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:text-foreground'
                    }`}>
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => handleExportLogs(true)}>
                  <Copy className="mr-1 h-3 w-3" />
                  复制
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => handleExportLogs(false)}>
                  <Download className="mr-1 h-3 w-3" />
                  导出 JSON
                </Button>
              </div>
            </div>

            {filteredLogs.length === 0 ? (
              <EmptyState
                icon={<FileText className="h-5 w-5" />}
                title="暂无诊断日志"
                description="所有日志均已自动脱敏，严禁包含密码、Authorization 头或敏感 Cookie 明文。"
              />
            ) : (
              <div className="space-y-2">
                {filteredLogs.map(log => {
                  const isErr = log.level === 'error';
                  const isWarn = log.level === 'warn';
                  return (
                    <div
                      key={log.id}
                      className={`rounded-xl border p-2.5 text-xs space-y-1.5 ${
                        isErr
                          ? 'border-rose-500/35 bg-rose-500/[0.04]'
                          : isWarn
                            ? 'border-amber-500/35 bg-amber-500/[0.04]'
                            : 'border-border bg-card'
                      }`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge tone={isErr ? 'danger' : isWarn ? 'warning' : 'info'}>
                            {isErr ? (
                              <AlertCircle className="h-3 w-3" />
                            ) : isWarn ? (
                              <AlertTriangle className="h-3 w-3" />
                            ) : (
                              <Info className="h-3 w-3" />
                            )}
                            {log.level.toUpperCase()}
                          </StatusBadge>
                          <StatusBadge tone="neutral">{log.phase}</StatusBadge>
                          {log.code ? <code className="font-mono text-[11px] font-semibold">{log.code}</code> : null}
                          {log.siteKey ? (
                            <span className="text-[11px] text-muted-foreground">{log.siteKey}</span>
                          ) : null}
                        </div>
                        <span
                          className="shrink-0 text-[10px] font-mono text-muted-foreground"
                          title={formatDateTime(log.timestamp)}>
                          {formatRelativeTime(log.timestamp)}
                        </span>
                      </div>

                      <p className="text-foreground/95 leading-snug break-words">{log.message}</p>

                      {log.suggestion ? (
                        <div className="flex items-start gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 py-1.5 text-[11px] text-foreground/85">
                          <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                          <span>建议：{log.suggestion}</span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Confirm Undo Modal */}
      <Modal
        open={!!confirmUndo}
        onClose={() => setConfirmUndo(null)}
        title={`恢复本地安全还原点：${confirmUndo?.siteKey || ''}`}
        description="将把本机浏览器中该站点的 Cookies、LocalStorage 与轨道绑定恢复到覆盖前的快照状态。"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setConfirmUndo(null)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={!confirmUndo || busyId === `undo:${confirmUndo?.undoId}`}
              onClick={() => confirmUndo && handleApplyUndo(confirmUndo)}>
              确认恢复原登录态
            </Button>
          </>
        }>
        {confirmUndo ? (
          <div className="space-y-2 text-xs">
            <p className="text-muted-foreground">
              备份原因：<span className="text-foreground">{confirmUndo.reason}</span>
            </p>
            <p className="text-muted-foreground">
              快照时间：<span className="text-foreground">{formatDateTime(confirmUndo.createdAt)}</span>
            </p>
            <p className="text-muted-foreground">
              包含内容：<span className="text-foreground">{confirmUndo.cookies.length} 条 Cookie</span>，
              <span className="text-foreground">
                {Object.keys(confirmUndo.localStorageByOrigin || {}).length} 个 LocalStorage Origin
              </span>
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  );
};
