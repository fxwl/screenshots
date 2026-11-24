import type { PendingSiteDecision, SiteDecisionAction } from '@sessionmesh/core';
import { unwrapCommand } from '@sessionmesh/shared';
import { Badge, Button } from '@sessionmesh/ui';
import { Ban, Check, CloudDownload, CloudUpload, GitBranch, Loader2, Monitor } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { extractErrorMessage, formatRelativeTime } from '../utils/helpers';

interface InlineDecisionsProps {
  decisions: PendingSiteDecision[];
  currentSiteKey?: string | null;
  onResolved: () => Promise<void>;
}

export function InlineDecisions({ decisions, currentSiteKey, onResolved }: InlineDecisionsProps) {
  const [busySite, setBusySite] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  // Put current site first if it is pending
  const sorted = [...decisions].sort((a, b) => {
    if (currentSiteKey && a.siteKey === currentSiteKey) return -1;
    if (currentSiteKey && b.siteKey === currentSiteKey) return 1;
    return b.detectedAt - a.detectedAt;
  });

  const handleResolve = async (siteKey: string, action: SiteDecisionAction, msg: string) => {
    setBusySite(siteKey);
    try {
      await unwrapCommand({ type: 'RESOLVE_SITE_DECISION', siteKey, action });
      toast.success(`${siteKey}：${msg}`);
      await onResolved();
    } catch (err) {
      toast.error(`决策失败：${extractErrorMessage(err)}`);
    } finally {
      setBusySite(null);
    }
  };

  const handleBatchIndependent = async () => {
    setBatchBusy(true);
    try {
      await unwrapCommand({
        type: 'RESOLVE_BATCH_DECISIONS',
        siteKeys: sorted.map(d => d.siteKey),
        action: { type: 'keep_independent' },
      });
      toast.success(`已将全部 ${sorted.length} 个站点设为各自独立维护`);
      await onResolved();
    } catch (err) {
      toast.error(`批量决策失败：${extractErrorMessage(err)}`);
    } finally {
      setBatchBusy(false);
    }
  };

  const handleBatchUseRemote = async () => {
    setBatchBusy(true);
    try {
      for (const d of sorted) {
        const track = d.remoteTracks[0];
        if (!track) continue;
        await unwrapCommand({
          type: 'RESOLVE_SITE_DECISION',
          siteKey: d.siteKey,
          action: { type: 'use_remote_track', trackId: track.trackId },
        });
      }
      toast.success(`已全部采用云端主版本（已保留本地后悔药）`);
      await onResolved();
    } catch (err) {
      toast.error(`批量决策部分失败：${extractErrorMessage(err)}`);
      await onResolved();
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <div className="space-y-2.5">
      {sorted.length > 1 ? (
        <div className="flex items-center justify-end gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={batchBusy}
            onClick={handleBatchIndependent}
            className="h-7 px-2 text-[11px]">
            全部各自独立
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={batchBusy}
            onClick={handleBatchUseRemote}
            className="h-7 px-2 text-[11px]">
            全部用云端主版
          </Button>
        </div>
      ) : null}

      <div className="max-h-60 space-y-2 overflow-y-auto pr-0.5">
        {sorted.map(d => {
          const isBusy = busySite === d.siteKey || batchBusy;
          const isCurrent = !!currentSiteKey && d.siteKey === currentSiteKey;
          const isMultiTrack = d.reason === 'multiple_remote_tracks' || d.remoteTracks.length > 1;
          const primaryTrack = d.remoteTracks[0];

          return (
            <div
              key={d.siteKey}
              className={`rounded-lg border bg-background p-2.5 text-xs ${
                isCurrent ? 'border-primary/60 ring-1 ring-primary/30' : 'border-border'
              }`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate font-semibold text-foreground">{d.siteKey}</span>
                  {isCurrent ? (
                    <Badge variant="default" className="px-1.5 py-0 text-[10px]">
                      当前页
                    </Badge>
                  ) : null}
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {isMultiTrack ? `${d.remoteTracks.length} 条云端轨道` : `本机 ${d.localCookieCount} Cookie`}
                </span>
              </div>

              {isMultiTrack ? (
                <div className="mt-2 space-y-1.5">
                  {d.remoteTracks.map(track => (
                    <div
                      key={track.trackId}
                      className="flex items-center justify-between gap-2 rounded-md border border-border/80 bg-muted/35 px-2 py-1.5">
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">{track.label}</div>
                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <Monitor className="h-2.5 w-2.5 shrink-0" />
                          <span className="truncate">{track.originDeviceName}</span>
                          <span>· {track.cookieCount} Cookie</span>
                          <span>· {formatRelativeTime(track.updatedAt)}</span>
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        disabled={isBusy}
                        onClick={() =>
                          handleResolve(
                            d.siteKey,
                            { type: 'use_remote_track', trackId: track.trackId },
                            `已跟随「${track.label}」`,
                          )
                        }
                        className="h-6 shrink-0 px-2 text-[11px]">
                        {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
                        跟随
                      </Button>
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => handleResolve(d.siteKey, { type: 'keep_independent' }, '已新建独立轨道')}
                      className="h-6 px-2 text-[11px]">
                      <GitBranch className="mr-1 h-3 w-3" />
                      独立新建
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isBusy}
                      onClick={() =>
                        handleResolve(d.siteKey, { type: 'blacklist', scope: 'device' }, '已加入本机黑名单')
                      }
                      className="h-6 px-2 text-[11px] text-destructive hover:text-destructive">
                      <Ban className="mr-1 h-3 w-3" />
                      拉黑
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {primaryTrack ? (
                    <div className="text-[11px] text-muted-foreground">
                      云端：{primaryTrack.label}（{primaryTrack.originDeviceName} · {primaryTrack.cookieCount} Cookie ·{' '}
                      {formatRelativeTime(primaryTrack.updatedAt)}）
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-1.5">
                    {primaryTrack ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={isBusy}
                        onClick={() =>
                          handleResolve(
                            d.siteKey,
                            { type: 'use_remote_track', trackId: primaryTrack.trackId },
                            '已用云端版本覆盖本机',
                          )
                        }
                        className="h-7 text-[11px]">
                        {isBusy ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <CloudDownload className="mr-1 h-3 w-3" />
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
                        handleResolve(
                          d.siteKey,
                          { type: 'use_local_override_track', trackId: primaryTrack?.trackId },
                          '已用本机版本覆盖云端',
                        )
                      }
                      className="h-7 text-[11px]">
                      <CloudUpload className="mr-1 h-3 w-3" />
                      用本机版本
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => handleResolve(d.siteKey, { type: 'keep_independent' }, '已设为各自独立维护')}
                      className="h-7 text-[11px]">
                      <GitBranch className="mr-1 h-3 w-3" />
                      各自独立
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isBusy}
                      onClick={() =>
                        handleResolve(d.siteKey, { type: 'blacklist', scope: 'device' }, '已加入本机黑名单')
                      }
                      className="h-7 text-[11px] text-destructive hover:text-destructive">
                      <Ban className="mr-1 h-3 w-3" />
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
