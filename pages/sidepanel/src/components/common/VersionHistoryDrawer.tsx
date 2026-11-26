import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import {
  decodeTypedClonePreview,
  formatDateTime,
  formatRelativeTime,
  getOperationMeta,
  shortId,
} from '@console/lib/format';
import type { SyncEvent } from '@sessionmesh/shared';
import { Button } from '@sessionmesh/ui';
import { History, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from './Badge';
import { EmptyState } from './EmptyState';
import { SlideOverDrawer } from './Modal';

export interface VersionHistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  siteKey?: string;
  objectId?: string;
  onRestored?: () => void;
}

const formatEventStatus = (status?: string): string => {
  switch (status) {
    case 'COMMITTED':
      return '已提交';
    case 'QUEUED':
      return '待上传';
    case 'FAILED':
      return '失败';
    case 'CONFLICT':
      return '冲突';
    default:
      return status || '-';
  }
};

export const VersionHistoryDrawer: React.FC<VersionHistoryDrawerProps> = ({
  open,
  onClose,
  title,
  siteKey,
  objectId,
  onRestored,
}) => {
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    if (!open || !objectId) return;
    setLoading(true);
    try {
      const data = await sidePanelApi.getHistoryAndLogs({
        siteKey,
        objectId,
        limit: 50,
      });
      const sorted = [...(data.events || [])].sort((a, b) => b.createdAt - a.createdAt);
      setEvents(sorted);
    } catch (err) {
      toast.error(`加载版本历史失败：${extractErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, [open, siteKey, objectId]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleRestore = async (eventId: string) => {
    setRestoringId(eventId);
    try {
      await sidePanelApi.restoreHistoricalEvent(eventId);
      toast.success('已生成新的版本恢复事件并应用');
      await loadHistory();
      onRestored?.();
    } catch (err) {
      toast.error(`恢复历史版本失败：${extractErrorMessage(err)}`);
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <SlideOverDrawer
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-1.5">
          <History className="h-4 w-4 text-primary" />
          版本历史：{title}
        </span>
      }
      subtitle={objectId ? `逻辑 ID：${objectId}` : undefined}>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">共 {events.length} 条历史版本事件，点击恢复将生成新因果版本</p>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={loadHistory} disabled={loading}>
            <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>

        {loading && events.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在读取事件日志...
          </div>
        ) : events.length === 0 ? (
          <EmptyState
            icon={<History className="h-5 w-5" />}
            title="暂无该条目的历史事件"
            description="当发生新建、更新、删除或恢复同步事件后，历史记录会显示在这里。"
          />
        ) : (
          <div className="space-y-2.5">
            {events.map(ev => {
              const opMeta = getOperationMeta(ev.operation);
              const previewValue =
                ev.objectType === 'cookie'
                  ? ev.cookieData?.value
                  : ev.objectType === 'localStorage'
                    ? ev.localStorageData?.value
                    : ev.objectType === 'sessionStorage'
                      ? ev.sessionStorageData?.value
                      : ev.objectType === 'indexedDb' && ev.indexedDbData?.encodedValue !== undefined
                        ? decodeTypedClonePreview(ev.indexedDbData.encodedValue)
                        : undefined;
              const canRestore = ev.operation !== 'CHECKPOINT' && ev.operation !== 'SNAPSHOT';
              return (
                <div key={ev.eventId} className="rounded-lg border border-border bg-card p-3 text-xs space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <StatusBadge tone={opMeta.tone}>{opMeta.label}</StatusBadge>
                      <span className="truncate font-medium text-foreground">
                        {ev.deviceName || shortId(ev.deviceId, 12)}
                      </span>
                      <span className="text-[11px] text-muted-foreground">#{ev.deviceSeq}</span>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground" title={formatDateTime(ev.createdAt)}>
                      {formatRelativeTime(ev.createdAt)}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-1 text-[11px] text-muted-foreground">
                    <div className="truncate">
                      版本：<span className="font-mono text-foreground/80">{shortId(ev.version?.versionId, 16)}</span>
                    </div>
                    <div className="truncate text-right">
                      状态：<span className="text-foreground/80">{formatEventStatus(ev.status)}</span>
                    </div>
                  </div>

                  {previewValue !== undefined ? (
                    <div className="rounded border border-border/70 bg-muted/40 p-2 font-mono text-[11px] break-all max-h-24 overflow-y-auto">
                      {previewValue === '' ? '<空字符串>' : previewValue}
                    </div>
                  ) : null}

                  {ev.deleteReason ? (
                    <p className="text-[11px] text-rose-600 dark:text-rose-400">删除原因：{ev.deleteReason}</p>
                  ) : null}

                  <div className="flex items-center justify-between pt-1 border-t border-border/60">
                    <span className="text-[10px] font-mono text-muted-foreground">{formatDateTime(ev.createdAt)}</span>
                    {canRestore ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        disabled={restoringId === ev.eventId}
                        onClick={() => handleRestore(ev.eventId)}>
                        {restoringId === ev.eventId ? (
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
      </div>
    </SlideOverDrawer>
  );
};
