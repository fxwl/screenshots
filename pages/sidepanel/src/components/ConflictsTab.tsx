import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import { useBannerPrefs } from '@console/lib/bannerPrefs';
import {
  copyToClipboard,
  decodeIdbKeyPreview,
  decodeTypedClonePreview,
  formatCookieExpiry,
  formatDateTime,
  formatRelativeTime,
  getObjectTypeLabel,
  getSameSiteLabel,
  shortId,
} from '@console/lib/format';
import type {
  ConflictRecord,
  CookieRecord,
  IndexedDbRecord,
  LocalStorageRecord,
  SessionStorageRecord,
  SyncRecord,
} from '@sessionmesh/shared';
import { Button } from '@sessionmesh/ui';
import {
  CheckCircle2,
  Clock,
  Copy,
  GitMerge,
  Laptop,
  Loader2,
  RefreshCw,
  Scale,
  Server,
  Trophy,
  X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from './common/Badge';
import { EmptyState } from './common/EmptyState';

export interface ConflictsTabProps {
  globalSearch: string;
  onStatusChanged: () => Promise<void> | void;
  refreshSignal: number;
  layout?: 'compact' | 'wide';
}

function isCookieRecord(rec: SyncRecord): rec is CookieRecord {
  return 'domain' in rec && 'name' in rec;
}

function isIndexedDbRecord(rec: SyncRecord): rec is IndexedDbRecord {
  return 'dbName' in rec && 'encodedKey' in rec;
}

function getSyncRecordValueText(rec: SyncRecord): string {
  if (isIndexedDbRecord(rec)) {
    return decodeTypedClonePreview(rec.encodedValue);
  }
  return (rec as CookieRecord | LocalStorageRecord | SessionStorageRecord).value;
}

function getSyncRecordNameText(rec: SyncRecord): string {
  if (isCookieRecord(rec)) return rec.name;
  if (isIndexedDbRecord(rec)) return `${rec.dbName}.${rec.storeName}:${decodeIdbKeyPreview(rec.encodedKey)}`;
  return rec.key;
}

const RecordSideCard: React.FC<{
  side: 'local' | 'remote';
  record: SyncRecord;
  isWinner: boolean;
  valueDiffers: boolean;
}> = ({ side, record, isWinner, valueDiffers }) => {
  const isCookie = isCookieRecord(record);
  const isIdb = isIndexedDbRecord(record);
  const valueText = getSyncRecordValueText(record);
  const vcEntries = Object.entries(record.version?.vectorClock || {});

  return (
    <div
      className={`rounded-lg border p-2.5 text-[11px] space-y-2 ${
        isWinner ? 'border-primary/50 bg-primary/[0.04]' : 'border-border bg-muted/20'
      }`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-1.5">
        <span className="inline-flex items-center gap-1 font-semibold text-foreground">
          {side === 'local' ? (
            <Laptop className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
          ) : (
            <Server className="h-3.5 w-3.5 text-primary" />
          )}
          {side === 'local' ? '本机版本 (Local)' : '远端版本 (Remote)'}
        </span>
        {isWinner ? (
          <StatusBadge tone="primary">
            <Trophy className="h-2.5 w-2.5" />
            自动胜出
          </StatusBadge>
        ) : null}
      </div>

      {/* Value */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">值 {valueDiffers ? '(存在差异)' : '(值相同)'}</span>
          <button
            type="button"
            onClick={async () => {
              const ok = await copyToClipboard(valueText);
              if (ok) toast.success('已复制该版本值');
            }}
            className="text-muted-foreground hover:text-foreground"
            title="复制值">
            <Copy className="h-3 w-3" />
          </button>
        </div>
        <pre
          className={`max-h-24 overflow-auto whitespace-pre-wrap break-all rounded border p-1.5 font-mono text-[10px] ${
            valueDiffers
              ? 'border-amber-500/40 bg-amber-500/[0.06] text-foreground'
              : 'border-border/70 bg-background text-foreground/90'
          }`}>
          {record.deleted ? '<已删除 Tombstone>' : valueText || '<空字符串>'}
        </pre>
      </div>

      {/* Attributes */}
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        {isCookie ? (
          <>
            <p className="truncate">
              域/路径：
              <span className="font-mono text-foreground">
                {record.domain}
                {record.path}
              </span>
            </p>
            <p>
              标记：
              <span className="text-foreground">
                {record.secure ? 'Secure ' : ''}
                {record.httpOnly ? 'HttpOnly ' : ''}
                {record.hostOnly ? 'HostOnly ' : ''}
                SameSite={getSameSiteLabel(record.sameSite)}
              </span>
            </p>
            <p className="truncate">
              过期：<span className="text-foreground">{formatCookieExpiry(record.expirationDate, record.session)}</span>
            </p>
            {record.partitionKey?.topLevelSite ? (
              <p className="truncate">
                PartitionKey：<span className="font-mono text-foreground">{record.partitionKey.topLevelSite}</span>
              </p>
            ) : null}
          </>
        ) : isIdb ? (
          <>
            <p className="truncate">
              Origin：<span className="font-mono text-foreground">{record.origin}</span>
            </p>
            <p className="truncate">
              库表：
              <span className="font-mono text-foreground">
                {record.dbName} / {record.storeName}
              </span>
            </p>
            <p className="truncate">
              Key：<span className="font-mono text-foreground">{decodeIdbKeyPreview(record.encodedKey)}</span>
            </p>
          </>
        ) : (
          <>
            <p className="truncate">
              Origin：<span className="font-mono text-foreground">{record.origin}</span>
            </p>
            <p className="truncate">
              Key：<span className="font-mono text-foreground">{record.key}</span>
            </p>
          </>
        )}
      </div>

      {/* Device, HLC & Vector Clock */}
      <div className="space-y-1 border-t border-border/60 pt-1.5 text-[10px] text-muted-foreground">
        <p className="truncate">
          来源设备：
          <span className="font-medium text-foreground">
            {record.sourceDeviceName || shortId(record.sourceDevice, 12)}
          </span>
        </p>
        <p className="flex items-center gap-1" title={formatDateTime(record.updatedAt)}>
          <Clock className="h-3 w-3 shrink-0" />
          <span>{formatDateTime(record.updatedAt)}</span>
        </p>
        <p className="truncate font-mono">
          HLC: {record.version?.hlc?.physicalMs ?? '-'} / L:{record.version?.hlc?.logical ?? 0}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px]">VC:</span>
          {vcEntries.length === 0 ? (
            <span className="font-mono">{'{}'}</span>
          ) : (
            vcEntries.map(([devId, seq]) => (
              <code
                key={devId}
                className="rounded border border-border bg-background px-1 py-0.2 font-mono text-[9px] text-foreground">
                {shortId(devId, 8)}:{String(seq)}
              </code>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export const ConflictsTab: React.FC<ConflictsTabProps> = ({
  globalSearch,
  onStatusChanged,
  refreshSignal,
  layout = 'compact',
}) => {
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterMode, setFilterMode] = useState<'unresolved' | 'all'>('unresolved');
  const [busyId, setBusyId] = useState<string | null>(null);

  const { isBannerVisible, dismissBanner } = useBannerPrefs();

  const loadConflicts = useCallback(async () => {
    setLoading(true);
    try {
      const list = await sidePanelApi.getConflicts();
      setConflicts(
        [...(list || [])].sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.detectedAt - a.detectedAt),
      );
    } catch (err) {
      toast.error(`加载冲突列表失败：${extractErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConflicts();
  }, [loadConflicts, refreshSignal]);

  const handleResolve = async (conflict: ConflictRecord, choose: 'local' | 'remote') => {
    setBusyId(`${conflict.conflictId}:${choose}`);
    try {
      await sidePanelApi.resolveConflict(conflict.conflictId, choose);
      toast.success(
        choose === 'local'
          ? `已采用本机版本并同步覆盖 (${conflict.siteKey})`
          : `已采用远端版本并应用到本地 (${conflict.siteKey})`,
      );
      await loadConflicts();
      await onStatusChanged();
    } catch (err) {
      toast.error(`解决冲突失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const query = globalSearch.trim().toLowerCase();
  const unresolvedCount = conflicts.filter(c => !c.resolved).length;

  const filteredConflicts = conflicts.filter(c => {
    if (filterMode === 'unresolved' && c.resolved) return false;
    if (!query) return true;
    const itemName = getSyncRecordNameText(c.localRecord);
    const localVal = getSyncRecordValueText(c.localRecord);
    const remoteVal = getSyncRecordValueText(c.remoteRecord);
    return (
      c.siteKey.toLowerCase().includes(query) ||
      itemName.toLowerCase().includes(query) ||
      localVal.toLowerCase().includes(query) ||
      remoteVal.toLowerCase().includes(query)
    );
  });

  return (
    <div className={layout === 'wide' ? 'space-y-4' : 'flex h-full flex-col'}>
      {/* Header Toolbar */}
      <div
        className={
          layout === 'wide'
            ? 'flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-2.5'
            : 'shrink-0 border-b border-border bg-card/50 px-3 py-2 flex items-center justify-between gap-2'
        }>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setFilterMode('unresolved')}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              filterMode === 'unresolved'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}>
            待处理 ({unresolvedCount})
          </button>
          <button
            type="button"
            onClick={() => setFilterMode('all')}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              filterMode === 'all'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}>
            全部记录 ({conflicts.length})
          </button>
        </div>

        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={loadConflicts} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Body */}
      <div className={layout === 'wide' ? 'space-y-3' : 'flex-1 overflow-y-auto p-3 space-y-3'}>
        {isBannerVisible('conflicts_hlc_notice', 'general') ? (
          <div className="rounded-xl border border-border bg-muted/30 p-2.5 text-[11px] text-muted-foreground flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <Scale className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                当同一同步轨道内的多台设备对同一条目并发修改（向量时钟不可比较）时，SessionMesh 会通过主基准策略或确定性
                HLC 全序规则自动收敛一致，并在此完整保留双方版本，您可随时手动改选「本机版」或「远端版」。
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => void dismissBanner('conflicts_hlc_notice')}
                className="rounded px-1.5 py-0.5 text-[10px] hover:bg-muted">
                不再提示
              </button>
              <button
                type="button"
                onClick={() => void dismissBanner('conflicts_hlc_notice')}
                className="rounded p-0.5 hover:bg-muted"
                aria-label="关闭冲突规则说明">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : null}

        {loading && conflicts.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在读取冲突中心...
          </div>
        ) : filteredConflicts.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="h-5 w-5 text-emerald-500" />}
            title={filterMode === 'unresolved' ? '当前没有待处理的并发冲突' : '暂无任何冲突历史记录'}
            description="同轨道不同对象的更新会自动无冲突合并；仅当同一对象并发修改时才会出现在这里。"
          />
        ) : (
          <div className="space-y-3">
            {filteredConflicts.map(conflict => {
              const itemName = getSyncRecordNameText(conflict.localRecord);
              const valueDiffers =
                getSyncRecordValueText(conflict.localRecord) !== getSyncRecordValueText(conflict.remoteRecord);
              const resolvingLocal = busyId === `${conflict.conflictId}:local`;
              const resolvingRemote = busyId === `${conflict.conflictId}:remote`;

              return (
                <article
                  key={conflict.conflictId}
                  className={`rounded-xl border p-3 text-xs space-y-2.5 ${
                    conflict.resolved ? 'border-border bg-card/70' : 'border-amber-500/40 bg-card shadow-sm'
                  }`}>
                  {/* Conflict Card Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <GitMerge className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                        <span className="font-semibold text-foreground">{conflict.siteKey}</span>
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{itemName}</code>
                        <StatusBadge tone="neutral">{getObjectTypeLabel(conflict.objectType)}</StatusBadge>
                      </div>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span>检测于 {formatRelativeTime(conflict.detectedAt)}</span>
                        <span>·</span>
                        <span className="font-mono">轨道 {shortId(conflict.trackId, 14)}</span>
                      </p>
                    </div>

                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {conflict.resolved ? (
                        <StatusBadge tone="success">
                          {conflict.resolvedBy === 'user' ? '已手动裁决' : '已自动收敛'}
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="warning">待审查</StatusBadge>
                      )}
                      <StatusBadge tone="primary">
                        默认胜出：{conflict.winningSide === 'local' ? '本机版' : '远端版'}
                      </StatusBadge>
                    </div>
                  </div>

                  {/* Side-by-Side Comparison */}
                  <div className="grid grid-cols-1 min-[440px]:grid-cols-2 gap-2">
                    <RecordSideCard
                      side="local"
                      record={conflict.localRecord}
                      isWinner={conflict.winningSide === 'local'}
                      valueDiffers={valueDiffers}
                    />
                    <RecordSideCard
                      side="remote"
                      record={conflict.remoteRecord}
                      isWinner={conflict.winningSide === 'remote'}
                      valueDiffers={valueDiffers}
                    />
                  </div>

                  {/* Resolution Actions */}
                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
                    <Button
                      size="sm"
                      variant={conflict.winningSide === 'local' ? 'default' : 'outline'}
                      className="h-7 px-2.5 text-xs"
                      disabled={resolvingLocal || resolvingRemote}
                      onClick={() => handleResolve(conflict, 'local')}>
                      {resolvingLocal ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                      采用本机版
                    </Button>
                    <Button
                      size="sm"
                      variant={conflict.winningSide === 'remote' ? 'default' : 'outline'}
                      className="h-7 px-2.5 text-xs"
                      disabled={resolvingLocal || resolvingRemote}
                      onClick={() => handleResolve(conflict, 'remote')}>
                      {resolvingRemote ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                      采用远端版
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
