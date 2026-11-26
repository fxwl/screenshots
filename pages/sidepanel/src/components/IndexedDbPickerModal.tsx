import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import { formatByteSize } from '@console/lib/format';
import { extractSiteKeyFromUrl, type IndexedDbTargetRule, type InspectedIndexedDbDatabase } from '@sessionmesh/shared';
import { Button, Input, Label } from '@sessionmesh/ui';
import { AlertTriangle, CheckSquare, Database, Loader2, RefreshCw, Search } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from './common/Badge';
import { Modal } from './common/Modal';

export const DEFAULT_INDEXEDDB_QUOTA_BYTES = 1024 * 1024; // 1 MB

export interface IndexedDbPickerModalProps {
  open: boolean;
  onClose: () => void;
  initialSiteKey?: string;
  initialOrigin?: string;
  existingTargets?: IndexedDbTargetRule[];
  confirmLabel?: string;
  onApplyTargets: (siteKey: string, targets: IndexedDbTargetRule[], origin: string) => Promise<void> | void;
}

interface TabOriginOption {
  origin: string;
  siteKey: string;
  title: string;
  active: boolean;
}

function makeStoreKey(dbName: string, storeName: string): string {
  return `${dbName}\u0000${storeName}`;
}

export const IndexedDbPickerModal: React.FC<IndexedDbPickerModalProps> = ({
  open,
  onClose,
  initialSiteKey,
  initialOrigin,
  existingTargets,
  confirmLabel = '应用所选库表到同步规则',
  onApplyTargets,
}) => {
  const [tabOptions, setTabOptions] = useState<TabOriginOption[]>([]);
  const [originInput, setOriginInput] = useState('');
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [databases, setDatabases] = useState<InspectedIndexedDbDatabase[]>([]);
  const [selectedStoreKeys, setSelectedStoreKeys] = useState<Set<string>>(new Set());

  const runInspect = useCallback(
    async (targetOrigin: string, preselectTargets?: IndexedDbTargetRule[]) => {
      const trimmed = targetOrigin.trim();
      if (!trimmed) return;
      let normalizedOrigin = trimmed;
      try {
        normalizedOrigin = new URL(trimmed).origin;
      } catch {
        setScanError('请输入合法的 Origin（如 https://app.example.com）');
        return;
      }

      setScanning(true);
      setScanError(null);
      try {
        const res = await sidePanelApi.inspectPageIndexedDb(normalizedOrigin);
        if (!res.available) {
          setDatabases([]);
          setScanError(res.reason || `未找到已打开的 ${normalizedOrigin} 标签页，请先在浏览器中打开该页面后再扫描`);
          return;
        }
        const dbs = res.databases || [];
        setDatabases(dbs);

        const nextSelected = new Set<string>();
        const targets = preselectTargets ?? existingTargets ?? [];
        for (const db of dbs) {
          const matchingTarget = targets.find(t => t.dbName === db.dbName);
          if (matchingTarget) {
            const allowedStores = matchingTarget.objectStores;
            for (const st of db.stores) {
              if (!allowedStores || allowedStores.length === 0 || allowedStores.includes(st.name)) {
                nextSelected.add(makeStoreKey(db.dbName, st.name));
              }
            }
          }
        }
        setSelectedStoreKeys(nextSelected);
      } catch (err) {
        setDatabases([]);
        setScanError(extractErrorMessage(err));
      } finally {
        setScanning(false);
      }
    },
    [existingTargets],
  );

  useEffect(() => {
    if (!open) return;
    setDatabases([]);
    setScanError(null);
    setApplying(false);

    const init = async () => {
      const options: TabOriginOption[] = [];
      const seenOrigins = new Set<string>();
      if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
        try {
          const tabs = await new Promise<chrome.tabs.Tab[]>(resolve => {
            chrome.tabs.query({}, result => resolve(result || []));
          });
          for (const t of tabs) {
            if (!t.url || !/^https?:\/\//i.test(t.url)) continue;
            try {
              const parsed = new URL(t.url);
              if (seenOrigins.has(parsed.origin)) continue;
              seenOrigins.add(parsed.origin);
              options.push({
                origin: parsed.origin,
                siteKey: extractSiteKeyFromUrl(parsed.origin) || parsed.hostname,
                title: t.title || parsed.origin,
                active: Boolean(t.active),
              });
            } catch {
              // ignore invalid tab URL
            }
          }
        } catch {
          // ignore outside extension runtime
        }
      }
      setTabOptions(options);

      const normInitSite = initialSiteKey?.trim().toLowerCase();
      const preferred =
        (initialOrigin && initialOrigin.trim()) ||
        (normInitSite
          ? options.find(o => o.siteKey === normInitSite || o.origin.toLowerCase().includes(normInitSite))?.origin
          : undefined) ||
        options.find(o => o.active)?.origin ||
        options[0]?.origin ||
        (normInitSite ? `https://${normInitSite}` : '');

      setOriginInput(preferred);
      if (preferred) {
        void runInspect(preferred, existingTargets);
      }
    };

    void init();
  }, [open, initialSiteKey, initialOrigin, existingTargets, runInspect]);

  const toggleStore = (dbName: string, storeName: string) => {
    const key = makeStoreKey(dbName, storeName);
    setSelectedStoreKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllDbStores = (db: InspectedIndexedDbDatabase) => {
    const keys = db.stores.map(st => makeStoreKey(db.dbName, st.name));
    const allChecked = keys.length > 0 && keys.every(k => selectedStoreKeys.has(k));
    setSelectedStoreKeys(prev => {
      const next = new Set(prev);
      for (const k of keys) {
        if (allChecked) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  };

  const selectionSummary = useMemo(() => {
    let storeCount = 0;
    let totalBytes = 0;
    const targets: IndexedDbTargetRule[] = [];

    for (const db of databases) {
      const pickedStores: string[] = [];
      for (const st of db.stores) {
        if (selectedStoreKeys.has(makeStoreKey(db.dbName, st.name))) {
          pickedStores.push(st.name);
          storeCount += 1;
          totalBytes += st.estimatedBytes;
        }
      }
      if (pickedStores.length > 0) {
        targets.push({
          dbName: db.dbName,
          objectStores: pickedStores,
        });
      }
    }

    return { storeCount, totalBytes, targets };
  }, [databases, selectedStoreKeys]);

  const exceedsDefaultLimit = selectionSummary.totalBytes > DEFAULT_INDEXEDDB_QUOTA_BYTES;

  const handleConfirm = async () => {
    if (selectionSummary.targets.length === 0) {
      toast.warning('请至少勾选一个 IndexedDB ObjectStore');
      return;
    }
    const resolvedSiteKey =
      initialSiteKey?.trim().toLowerCase() || extractSiteKeyFromUrl(originInput.trim()) || originInput.trim();
    setApplying(true);
    try {
      await onApplyTargets(resolvedSiteKey, selectionSummary.targets, originInput.trim());
      onClose();
    } catch (err) {
      toast.error(`保存 IndexedDB 目标失败：${extractErrorMessage(err)}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!applying) onClose();
      }}
      title={
        <span className="flex items-center gap-1.5">
          <Database className="h-4 w-4 text-primary" />
          扫描页面 IndexedDB 库表（轻量白名单）
        </span>
      }
      description="SessionMesh 仅对显式勾选的轻量认证库表执行同步（默认 1MB 熔断保护，自动跳过 Blob/FileSystemHandle 等不可序列化句柄）。"
      maxWidthClass="max-w-lg"
      footer={
        <>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={applying}>
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={applying || scanning || selectionSummary.targets.length === 0}
            onClick={() => void handleConfirm()}>
            {applying ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckSquare className="mr-1.5 h-3.5 w-3.5" />
            )}
            {confirmLabel} ({selectionSummary.storeCount})
          </Button>
        </>
      }>
      <div className="space-y-3 text-xs">
        {/* Origin Selector & Scan Button */}
        <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-2.5">
          {tabOptions.length > 0 ? (
            <div className="space-y-1">
              <Label htmlFor="idb-picker-tab-select" className="text-[11px]">
                从已打开网页选择 Origin
              </Label>
              <select
                id="idb-picker-tab-select"
                value={tabOptions.some(t => t.origin === originInput) ? originInput : ''}
                onChange={e => {
                  if (e.target.value) {
                    setOriginInput(e.target.value);
                    void runInspect(e.target.value);
                  }
                }}
                className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground">
                <option value="">选择打开的标签页 Origin...</option>
                {tabOptions.map(tab => (
                  <option key={tab.origin} value={tab.origin}>
                    {tab.origin}
                    {tab.active ? ' (当前标签页)' : ''} — {tab.title}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="space-y-1">
            <Label htmlFor="idb-picker-origin" className="text-[11px]">
              目标 Origin *
            </Label>
            <div className="flex items-center gap-1.5">
              <Input
                id="idb-picker-origin"
                value={originInput}
                onChange={e => setOriginInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void runInspect(originInput);
                }}
                placeholder="https://app.example.com"
                className="h-8 bg-background font-mono text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0 px-2.5 text-xs"
                disabled={scanning || !originInput.trim()}
                onClick={() => void runInspect(originInput)}>
                {scanning ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="mr-1 h-3.5 w-3.5" />
                )}
                扫描
              </Button>
            </div>
          </div>
        </div>

        {/* Scan Output */}
        {scanning ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在读取页面 IndexedDB 库表结构与体积估算...
          </div>
        ) : scanError ? (
          <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-[11px] text-amber-900 dark:text-amber-200 space-y-2">
            <p>{scanError}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px] bg-background"
              onClick={() => void runInspect(originInput)}>
              <RefreshCw className="mr-1 h-3 w-3" />
              重新扫描
            </Button>
          </div>
        ) : databases.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 p-5 text-center text-[11px] text-muted-foreground">
            该页面暂未检测到 IndexedDB 数据库（或尚未扫描）。
          </div>
        ) : (
          <div className="space-y-2.5">
            {databases.map(db => {
              const allChecked =
                db.stores.length > 0 && db.stores.every(st => selectedStoreKeys.has(makeStoreKey(db.dbName, st.name)));
              return (
                <div key={db.dbName} className="rounded-xl border border-border bg-card overflow-hidden">
                  <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
                    <label className="flex cursor-pointer items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        onChange={() => toggleAllDbStores(db)}
                        className="h-3.5 w-3.5 rounded accent-primary"
                      />
                      <span className="truncate font-mono text-xs font-semibold text-foreground">{db.dbName}</span>
                      <StatusBadge tone="neutral">v{db.version}</StatusBadge>
                    </label>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      约 {formatByteSize(db.totalEstimatedBytes)}
                    </span>
                  </div>

                  {db.stores.length === 0 ? (
                    <div className="px-3 py-2 text-[11px] text-muted-foreground">该数据库下无 ObjectStore</div>
                  ) : (
                    <div className="divide-y divide-border/60">
                      {db.stores.map(st => {
                        const checked = selectedStoreKeys.has(makeStoreKey(db.dbName, st.name));
                        return (
                          <label
                            key={st.name}
                            className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 hover:bg-muted/20">
                            <div className="flex items-center gap-2 min-w-0">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleStore(db.dbName, st.name)}
                                className="h-3.5 w-3.5 rounded accent-primary"
                              />
                              <span className="truncate font-mono text-xs text-foreground">{st.name}</span>
                              {st.keyPath ? (
                                <span className="text-[10px] text-muted-foreground font-mono">
                                  keyPath: {Array.isArray(st.keyPath) ? st.keyPath.join(',') : st.keyPath}
                                </span>
                              ) : null}
                            </div>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {st.recordCount} 条 · {formatByteSize(st.estimatedBytes)}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Quota Summary Bar */}
        {databases.length > 0 ? (
          <div
            className={`rounded-lg border p-2.5 text-[11px] flex items-center justify-between gap-2 ${
              exceedsDefaultLimit
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-800 dark:text-rose-200'
                : 'border-border bg-muted/30 text-muted-foreground'
            }`}>
            <span className="flex items-center gap-1.5">
              {exceedsDefaultLimit ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" /> : null}
              已选 {selectionSummary.storeCount} 个 Store · 预估总体积：
              <strong className="text-foreground">{formatByteSize(selectionSummary.totalBytes)}</strong>
            </span>
            <span>默认 1MB 熔断保护</span>
          </div>
        ) : null}
      </div>
    </Modal>
  );
};
