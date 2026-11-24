import type { PendingSiteDecision, SiteDecisionAction } from '@sessionmesh/core';
import { unwrapCommand } from '@sessionmesh/shared';
import { Badge, Button } from '@sessionmesh/ui';
import {
  AlertTriangle,
  Ban,
  Check,
  CloudDownload,
  CloudUpload,
  GitBranch,
  Layers,
  Loader2,
  Monitor,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { extractErrorMessage, formatRelativeTime } from '../utils/helpers';

interface PendingDecisionsPanelProps {
  decisions: PendingSiteDecision[];
  onResolved?: (resolvedSiteKeys: string[]) => void | Promise<void>;
  compact?: boolean;
}

export function PendingDecisionsPanel({ decisions, onResolved, compact = false }: PendingDecisionsPanelProps) {
  const [busySites, setBusySites] = useState<Record<string, boolean>>({});
  const [batchBusy, setBatchBusy] = useState(false);

  if (decisions.length === 0) {
    return null;
  }

  const handleSingleAction = async (siteKey: string, action: SiteDecisionAction, label: string) => {
    setBusySites(prev => ({ ...prev, [siteKey]: true }));
    try {
      await unwrapCommand({ type: 'RESOLVE_SITE_DECISION', siteKey, action });
      toast.success(`${siteKey}：${label}`);
      await onResolved?.([siteKey]);
    } catch (err) {
      toast.error(`${siteKey} 处理失败：${extractErrorMessage(err)}`);
    } finally {
      setBusySites(prev => ({ ...prev, [siteKey]: false }));
    }
  };

  const handleBatchIndependent = async () => {
    setBatchBusy(true);
    const siteKeys = decisions.map(d => d.siteKey);
    try {
      await unwrapCommand({
        type: 'RESOLVE_BATCH_DECISIONS',
        siteKeys,
        action: { type: 'keep_independent' },
      });
      toast.success(`已将 ${siteKeys.length} 个站点设为各自独立维护`);
      await onResolved?.(siteKeys);
    } catch (err) {
      toast.error(`批量操作失败：${extractErrorMessage(err)}`);
    } finally {
      setBatchBusy(false);
    }
  };

  const handleBatchUseRemotePrimary = async () => {
    setBatchBusy(true);
    const resolved: string[] = [];
    try {
      for (const decision of decisions) {
        const primaryTrack = decision.remoteTracks[0];
        if (!primaryTrack) continue;
        await unwrapCommand({
          type: 'RESOLVE_SITE_DECISION',
          siteKey: decision.siteKey,
          action: { type: 'use_remote_track', trackId: primaryTrack.trackId },
        });
        resolved.push(decision.siteKey);
      }
      toast.success(`已为 ${resolved.length} 个站点采用云端主版本（覆盖前已自动创建本地后悔药）`);
      await onResolved?.(resolved);
    } catch (err) {
      toast.error(`批量采用云端版本时出错：${extractErrorMessage(err)}`);
      if (resolved.length > 0) {
        await onResolved?.(resolved);
      }
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3.5 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>共有 {decisions.length} 个站点需要您确认同步策略（确认前绝不静默覆盖）</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={batchBusy}
            onClick={handleBatchIndependent}
            className="h-8 bg-background text-xs">
            {batchBusy ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitBranch className="mr-1.5 h-3.5 w-3.5" />
            )}
            全部各自独立维护
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={batchBusy}
            onClick={handleBatchUseRemotePrimary}
            className="h-8 text-xs">
            {batchBusy ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <CloudDownload className="mr-1.5 h-3.5 w-3.5" />
            )}
            全部使用云端主版本
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {decisions.map(decision => {
          const isBusy = !!busySites[decision.siteKey] || batchBusy;
          const isMultiTrack = decision.reason === 'multiple_remote_tracks' || decision.remoteTracks.length > 1;
          const primaryTrack = decision.remoteTracks[0];

          return (
            <div
              key={decision.siteKey}
              className="rounded-xl border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-base text-foreground">{decision.siteKey}</span>
                  {isMultiTrack ? (
                    <Badge variant="info">
                      <Layers className="h-3 w-3" />
                      云端多条轨道待选（{decision.remoteTracks.length} 套）
                    </Badge>
                  ) : (
                    <Badge variant="warning">双端均有登录态（设备重叠）</Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  本机：
                  {decision.hasLocalData
                    ? `${decision.localCookieCount} Cookie · ${decision.localLocalStorageCount} LS`
                    : '无登录数据'}
                </span>
              </div>

              {isMultiTrack ? (
                <div className="mt-3 space-y-2.5">
                  <p className="text-xs text-muted-foreground">
                    云端存在多个设备维护的不同账号轨道，请选择本机要跟随同步的轨道，或独立新建本机轨道：
                  </p>
                  <div className={`grid gap-2.5 ${compact ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'}`}>
                    {decision.remoteTracks.map(track => (
                      <div
                        key={track.trackId}
                        className="flex flex-col justify-between rounded-lg border border-border bg-muted/30 p-3">
                        <div className="space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-sm text-foreground">{track.label || '未命名轨道'}</span>
                            <Badge variant="outline" className="text-[11px]">
                              {track.memberDeviceIds.length} 台设备
                            </Badge>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <Monitor className="h-3 w-3" />
                              来源：{track.originDeviceName}
                            </span>
                            <span>{track.cookieCount} Cookie</span>
                            <span>{track.localStorageCount} LS</span>
                            <span>更新：{formatRelativeTime(track.updatedAt)}</span>
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          disabled={isBusy}
                          className="mt-3 h-8 w-full text-xs"
                          onClick={() =>
                            handleSingleAction(
                              decision.siteKey,
                              { type: 'use_remote_track', trackId: track.trackId },
                              `已跟随轨道「${track.label}」并同步`,
                            )
                          }>
                          {isBusy ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          跟随此轨道并双向同步
                        </Button>
                      </div>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {decision.hasLocalData ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={isBusy}
                        onClick={() =>
                          handleSingleAction(
                            decision.siteKey,
                            { type: 'use_local_override_track', trackId: primaryTrack?.trackId },
                            '已用本机版本覆盖主轨道',
                          )
                        }
                        className="h-8 text-xs">
                        <CloudUpload className="mr-1.5 h-3.5 w-3.5" />
                        用本机版本覆盖主轨道
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() =>
                        handleSingleAction(decision.siteKey, { type: 'keep_independent' }, '已独立新建本机轨道')
                      }
                      className="h-8 text-xs">
                      <GitBranch className="mr-1.5 h-3.5 w-3.5" />
                      独立新建轨道
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isBusy}
                      onClick={() =>
                        handleSingleAction(
                          decision.siteKey,
                          { type: 'blacklist', scope: 'device' },
                          '已加入本机黑名单（不同步）',
                        )
                      }
                      className="h-8 text-xs text-destructive hover:text-destructive">
                      <Ban className="mr-1.5 h-3.5 w-3.5" />
                      加入本机黑名单
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isBusy}
                      onClick={() =>
                        handleSingleAction(
                          decision.siteKey,
                          { type: 'blacklist', scope: 'space' },
                          '已加入空间黑名单（全设备不同步）',
                        )
                      }
                      className="h-8 text-xs text-destructive hover:text-destructive">
                      <Ban className="mr-1.5 h-3.5 w-3.5" />
                      加入空间黑名单
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  {primaryTrack ? (
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      <div className="rounded-lg border border-border bg-muted/30 p-2.5 text-xs">
                        <div className="font-medium text-foreground">云端版本（{primaryTrack.label}）</div>
                        <div className="mt-1 text-muted-foreground">
                          来源设备：{primaryTrack.originDeviceName} · {primaryTrack.cookieCount} Cookie ·{' '}
                          {primaryTrack.localStorageCount} LS · 更新于 {formatRelativeTime(primaryTrack.updatedAt)}
                        </div>
                      </div>
                      <div className="rounded-lg border border-border bg-muted/30 p-2.5 text-xs">
                        <div className="font-medium text-foreground">本机当前版本</div>
                        <div className="mt-1 text-muted-foreground">
                          {decision.localCookieCount} Cookie · {decision.localLocalStorageCount} LocalStorage
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    {primaryTrack ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={isBusy}
                        onClick={() =>
                          handleSingleAction(
                            decision.siteKey,
                            { type: 'use_remote_track', trackId: primaryTrack.trackId },
                            `已用云端「${primaryTrack.label}」覆盖本机`,
                          )
                        }
                        className="h-8 text-xs">
                        {isBusy ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CloudDownload className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        用云端版本
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isBusy}
                      onClick={() =>
                        handleSingleAction(
                          decision.siteKey,
                          { type: 'use_local_override_track', trackId: primaryTrack?.trackId },
                          '已用本机版本覆盖云端',
                        )
                      }
                      className="h-8 text-xs">
                      <CloudUpload className="mr-1.5 h-3.5 w-3.5" />
                      用本机版本
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() =>
                        handleSingleAction(decision.siteKey, { type: 'keep_independent' }, '已设为各自独立维护')
                      }
                      className="h-8 text-xs">
                      <GitBranch className="mr-1.5 h-3.5 w-3.5" />
                      各自独立维护
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isBusy}
                      onClick={() =>
                        handleSingleAction(decision.siteKey, { type: 'blacklist', scope: 'device' }, '已加入本机黑名单')
                      }
                      className="h-8 text-xs text-destructive hover:text-destructive">
                      <Ban className="mr-1.5 h-3.5 w-3.5" />
                      加入黑名单
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
