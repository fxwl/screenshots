import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import {
  copyToClipboard,
  decodeIdbKeyPreview,
  decodeTypedClonePreview,
  downloadJsonFile,
  formatByteSize,
  formatDateTime,
  formatRelativeTime,
  getCookieSyncStatusMeta,
  shortId,
} from '@console/lib/format';
import {
  extractSiteKeyFromUrl,
  type DeleteScope,
  type IndexedDbRecord,
  type IndexedDbTargetRule,
  type LocalStorageRecord,
  type SessionStorageRecord,
  type SiteRuleOverride,
  type SpaceSettings,
} from '@sessionmesh/shared';
import { Button, Input, Label } from '@sessionmesh/ui';
import {
  Clock,
  Copy,
  Database,
  Download,
  Edit3,
  FileJson,
  GitBranch,
  HardDrive,
  History,
  Layers,
  Loader2,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
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
import { DEFAULT_INDEXEDDB_QUOTA_BYTES, IndexedDbPickerModal } from './IndexedDbPickerModal';

export interface LocalStorageTabProps {
  globalSearch: string;
  onStatusChanged: () => Promise<void> | void;
  refreshSignal: number;
  layout?: 'compact' | 'wide';
  filterSiteKey?: string | null;
  filterTrackId?: string | null;
  filterTrackLabel?: string | null;
  onClearFilter?: () => void;
}

type StorageSubTab = 'localStorage' | 'sessionStorage' | 'indexedDb';
type KvStorageRecord = LocalStorageRecord | SessionStorageRecord;

interface OriginTrackGroup {
  groupKey: string;
  origin: string;
  siteKey: string;
  trackId: string;
  contextAvailable: boolean;
  items: KvStorageRecord[];
}

interface IndexedDbStoreGroup {
  groupKey: string;
  origin: string;
  siteKey: string;
  trackId: string;
  dbName: string;
  dbVersion?: number;
  storeName: string;
  contextAvailable: boolean;
  totalBytes: number;
  items: IndexedDbRecord[];
}

async function resolveActiveTabOrigin(preferredSiteKey?: string | null): Promise<string | null> {
  if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
    try {
      const tabs = await new Promise<chrome.tabs.Tab[]>(resolve => {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, result => resolve(result || []));
      });
      const url = tabs?.[0]?.url;
      if (url && /^https?:\/\//i.test(url)) {
        const parsed = new URL(url);
        if (!preferredSiteKey || extractSiteKeyFromUrl(parsed.origin) === preferredSiteKey) {
          return parsed.origin;
        }
      }
    } catch {
      // ignore outside extension context
    }
  }
  return null;
}

export const LocalStorageTab: React.FC<LocalStorageTabProps> = ({
  globalSearch,
  onStatusChanged,
  refreshSignal,
  layout = 'compact',
  filterSiteKey,
  filterTrackId,
  filterTrackLabel,
  onClearFilter,
}) => {
  const [subTab, setSubTab] = useState<StorageSubTab>('localStorage');

  const [lsRecords, setLsRecords] = useState<LocalStorageRecord[]>([]);
  const [ssRecords, setSsRecords] = useState<SessionStorageRecord[]>([]);
  const [idbRecords, setIdbRecords] = useState<IndexedDbRecord[]>([]);
  const [spaceSettings, setSpaceSettings] = useState<SpaceSettings | null>(null);
  const [siteOverrides, setSiteOverrides] = useState<Record<string, SiteRuleOverride>>({});

  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);

  // Add / Edit modal (shared for LS and SS)
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorIsEdit, setEditorIsEdit] = useState(false);
  const [formOrigin, setFormOrigin] = useState('');
  const [formKey, setFormKey] = useState('');
  const [formValue, setFormValue] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Delete / History / Import / IndexedDB Picker
  const [deleteTargets, setDeleteTargets] = useState<Array<{ logicalId: string; displayName: string }>>([]);
  const [historyTarget, setHistoryTarget] = useState<{
    title: string;
    siteKey: string;
    logicalId: string;
  } | null>(null);
  const [importOrigin, setImportOrigin] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [idbPickerOpen, setIdbPickerOpen] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const filter = {
        siteKey: filterSiteKey || undefined,
        trackId: filterTrackId || undefined,
      };
      const [lsList, ssList, idbList, statusRes, rulesRes] = await Promise.all([
        sidePanelApi.getLocalStorageRecords(filter),
        sidePanelApi.getSessionStorageRecords(filter).catch(() => [] as SessionStorageRecord[]),
        sidePanelApi.getIndexedDbRecords(filter).catch(() => [] as IndexedDbRecord[]),
        sidePanelApi.getStatusSummaryWithSettings().catch(() => null),
        sidePanelApi.getRulesAndBlacklist().catch(() => null),
      ]);

      setLsRecords(lsList || []);
      setSsRecords(ssList || []);
      setIdbRecords(idbList || []);
      setSpaceSettings(statusRes?.settings ?? null);
      setSiteOverrides(rulesRes?.siteOverrides ?? {});

      const validIds = new Set([
        ...(lsList || []).map(r => r.logicalId),
        ...(ssList || []).map(r => r.logicalId),
        ...(idbList || []).map(r => r.logicalId),
      ]);
      setSelectedIds(prev => new Set([...prev].filter(id => validIds.has(id))));
    } catch (err) {
      toast.error(`加载网页存储记录失败：${extractErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, [filterSiteKey, filterTrackId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll, refreshSignal]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [subTab]);

  const query = globalSearch.trim().toLowerCase();

  // --- Filtered LS / SS ---
  const activeKvRecords: KvStorageRecord[] = subTab === 'sessionStorage' ? ssRecords : lsRecords;
  const kvLabel = subTab === 'sessionStorage' ? 'SessionStorage' : 'LocalStorage';

  const filteredKvRecords = useMemo(() => {
    return activeKvRecords.filter(r => {
      if (!showDeleted && r.deleted) return false;
      if (!query) return true;
      return (
        r.origin.toLowerCase().includes(query) ||
        r.siteKey.toLowerCase().includes(query) ||
        r.key.toLowerCase().includes(query) ||
        r.value.toLowerCase().includes(query) ||
        (r.sourceDeviceName || '').toLowerCase().includes(query)
      );
    });
  }, [activeKvRecords, showDeleted, query]);

  const kvGroups = useMemo<OriginTrackGroup[]>(() => {
    const map = new Map<string, OriginTrackGroup>();
    for (const item of filteredKvRecords) {
      const groupKey = `${item.origin}:::${item.trackId}`;
      const existing = map.get(groupKey);
      if (existing) {
        existing.items.push(item);
        if (item.contextAvailable) existing.contextAvailable = true;
      } else {
        map.set(groupKey, {
          groupKey,
          origin: item.origin,
          siteKey: item.siteKey,
          trackId: item.trackId,
          contextAvailable: Boolean(item.contextAvailable),
          items: [item],
        });
      }
    }
    return [...map.values()]
      .map(g => ({
        ...g,
        items: g.items.sort((a, b) => Number(a.deleted) - Number(b.deleted) || a.key.localeCompare(b.key)),
      }))
      .sort((a, b) => a.origin.localeCompare(b.origin));
  }, [filteredKvRecords]);

  // --- Filtered IndexedDB ---
  const filteredIdbRecords = useMemo(() => {
    return idbRecords.filter(r => {
      if (!showDeleted && r.deleted) return false;
      if (!query) return true;
      return (
        r.origin.toLowerCase().includes(query) ||
        r.siteKey.toLowerCase().includes(query) ||
        r.dbName.toLowerCase().includes(query) ||
        r.storeName.toLowerCase().includes(query) ||
        decodeIdbKeyPreview(r.encodedKey).toLowerCase().includes(query) ||
        decodeTypedClonePreview(r.encodedValue).toLowerCase().includes(query) ||
        (r.sourceDeviceName || '').toLowerCase().includes(query)
      );
    });
  }, [idbRecords, showDeleted, query]);

  const idbGroups = useMemo<IndexedDbStoreGroup[]>(() => {
    const map = new Map<string, IndexedDbStoreGroup>();
    for (const item of filteredIdbRecords) {
      const groupKey = `${item.origin}:::${item.trackId}:::${item.dbName}:::${item.storeName}`;
      const existing = map.get(groupKey);
      if (existing) {
        existing.items.push(item);
        if (!item.deleted) existing.totalBytes += item.byteLength || 0;
        if (item.contextAvailable) existing.contextAvailable = true;
      } else {
        map.set(groupKey, {
          groupKey,
          origin: item.origin,
          siteKey: item.siteKey,
          trackId: item.trackId,
          dbName: item.dbName,
          dbVersion: item.dbVersion,
          storeName: item.storeName,
          contextAvailable: Boolean(item.contextAvailable),
          totalBytes: item.deleted ? 0 : item.byteLength || 0,
          items: [item],
        });
      }
    }
    return [...map.values()]
      .map(g => ({
        ...g,
        items: g.items.sort(
          (a, b) => Number(a.deleted) - Number(b.deleted) || a.encodedKey.localeCompare(b.encodedKey),
        ),
      }))
      .sort((a, b) => `${a.origin}|${a.dbName}|${a.storeName}`.localeCompare(`${b.origin}|${b.dbName}|${b.storeName}`));
  }, [filteredIdbRecords]);

  // --- SessionStorage Sync Status Banner Check ---
  const filteredSiteOverride = filterSiteKey ? siteOverrides[filterSiteKey] : undefined;
  const isSessionStorageSyncEnabled = filterSiteKey
    ? filteredSiteOverride?.syncSessionStorage ?? spaceSettings?.syncSessionStorage ?? false
    : spaceSettings?.syncSessionStorage ?? false;

  const handleEnableSessionStorageSync = async () => {
    setBusyId('enable-ss-sync');
    try {
      if (filterSiteKey) {
        const existing = siteOverrides[filterSiteKey];
        await sidePanelApi.upsertSiteRule({
          siteKey: filterSiteKey,
          pattern: existing?.pattern || filterSiteKey,
          direction: existing?.direction || 'bidirectional',
          syncCookies: existing?.syncCookies ?? true,
          syncLocalStorage: existing?.syncLocalStorage ?? true,
          syncSessionStorage: true,
          sessionStorageKeyAllowlist: existing?.sessionStorageKeyAllowlist,
          syncIndexedDb: existing?.syncIndexedDb,
          indexedDbTargets: existing?.indexedDbTargets,
          indexedDbMaxTotalBytes: existing?.indexedDbMaxTotalBytes,
          watchedCookieNames: existing?.watchedCookieNames,
          autoRefresh: existing?.autoRefresh ?? spaceSettings?.autoRefresh ?? true,
          updatedAt: Date.now(),
        });
        toast.success(`已为 ${filterSiteKey} 开启 sessionStorage 同步`);
      } else {
        await sidePanelApi.updateSpaceSettings({ syncSessionStorage: true });
        toast.success('已开启当前空间的全局 sessionStorage 默认同步');
      }
      await loadAll();
      await onStatusChanged();
    } catch (err) {
      toast.error(`开启 sessionStorage 同步失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  // --- LS & SS CRUD Handlers ---
  const openCreateModal = (presetOrigin = '') => {
    setEditorIsEdit(false);
    setFormOrigin(presetOrigin);
    setFormKey('');
    setFormValue('');
    setFormError(null);
    setEditorOpen(true);
  };

  const openEditModal = (record: KvStorageRecord) => {
    setEditorIsEdit(true);
    setFormOrigin(record.origin);
    setFormKey(record.key);
    setFormValue(record.value);
    setFormError(null);
    setEditorOpen(true);
  };

  const handleSaveItem = async () => {
    const rawOrigin = formOrigin.trim();
    const key = formKey.trim();
    if (!rawOrigin) {
      setFormError('请输入严格的 Origin（例如 https://app.example.com）');
      return;
    }
    let origin = rawOrigin;
    try {
      const parsedUrl = new URL(rawOrigin);
      if (parsedUrl.pathname !== '/' && parsedUrl.pathname !== '') {
        setFormError(`请填写纯 Origin，不要包含路径（例如 ${parsedUrl.origin}）`);
        return;
      }
      if (parsedUrl.search || parsedUrl.hash) {
        setFormError(`请填写纯 Origin，不要包含查询参数（例如 ${parsedUrl.origin}）`);
        return;
      }
      origin = parsedUrl.origin;
    } catch {
      setFormError('Origin 格式非法，必须以 http:// 或 https:// 开头');
      return;
    }
    if (!key) {
      setFormError('请输入 Key 名称');
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      const saved =
        subTab === 'sessionStorage'
          ? await sidePanelApi.upsertSessionStorageItem(origin, key, formValue, filterTrackId || undefined)
          : await sidePanelApi.upsertLocalStorageItem(origin, key, formValue, filterTrackId || undefined);

      toast.success(
        filterTrackId
          ? `已保存 ${key} 至指定账号轨道`
          : saved.contextAvailable
            ? `已保存并写入页面 ${kvLabel}：${key}`
            : `已保存 ${key}（页面未打开，已缓存待上下文可用后自动写入）`,
      );
      setEditorOpen(false);
      await loadAll();
      await onStatusChanged();
    } catch (err) {
      setFormError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleApplyKvItem = async (record: KvStorageRecord) => {
    setBusyId(`apply:${record.logicalId}`);
    try {
      const updated =
        subTab === 'sessionStorage'
          ? await sidePanelApi.applySessionStorageItem(record.logicalId)
          : await sidePanelApi.applyLocalStorageItem(record.logicalId);
      if (updated?.contextAvailable) {
        toast.success(`已实时应用至 ${record.origin}：${record.key}`);
      } else {
        toast.info(`已排队待应用：当前无打开的 ${record.origin} 标签页，打开后自动写入`);
      }
      await loadAll();
    } catch (err) {
      toast.error(`应用失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleApplyIdbItem = async (record: IndexedDbRecord) => {
    setBusyId(`apply:${record.logicalId}`);
    try {
      const updated = await sidePanelApi.applyIndexedDbRecord(record.logicalId);
      if (updated?.contextAvailable) {
        toast.success(`已实时写入 ${record.dbName}/${record.storeName}`);
      } else {
        toast.info(`已排队待应用：当前无打开的 ${record.origin} 标签页，打开后自动写入`);
      }
      await loadAll();
    } catch (err) {
      toast.error(`应用 IndexedDB 记录失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmDelete = async (scope: DeleteScope) => {
    const ids = deleteTargets.map(r => r.logicalId);
    if (ids.length === 0) return;

    if (subTab === 'sessionStorage') {
      await sidePanelApi.deleteSessionStorageItems(ids, scope);
      toast.success(`已删除 ${ids.length} 条 SessionStorage 记录`);
    } else if (subTab === 'indexedDb') {
      await sidePanelApi.deleteIndexedDbRecords(ids, scope);
      toast.success(`已删除 ${ids.length} 条 IndexedDB 记录`);
    } else {
      await sidePanelApi.deleteLocalStorageItems(ids, scope);
      toast.success(`已删除 ${ids.length} 条 LocalStorage 记录`);
    }

    setSelectedIds(prev => {
      const next = new Set(prev);
      ids.forEach(id => next.delete(id));
      return next;
    });
    await loadAll();
    await onStatusChanged();
  };

  const handleCopyGroupJson = async (group: OriginTrackGroup) => {
    const obj: Record<string, string> = {};
    for (const item of group.items) {
      if (!item.deleted) obj[item.key] = item.value;
    }
    const ok = await copyToClipboard(JSON.stringify(obj, null, 2));
    if (ok) toast.success(`已复制 ${group.origin} 的 ${Object.keys(obj).length} 项 ${kvLabel} JSON`);
    else toast.error('复制失败');
  };

  const handleExportAllJson = () => {
    const payload = filteredKvRecords
      .filter(r => !r.deleted)
      .map(r => ({
        origin: r.origin,
        key: r.key,
        value: r.value,
      }));
    const filename = subTab === 'sessionStorage' ? 'sessionmesh-sessionstorage.json' : 'sessionmesh-localstorage.json';
    downloadJsonFile(filename, payload);
    toast.success(`已导出 ${payload.length} 条 ${kvLabel} JSON`);
  };

  const handleImportJson = async (parsed: unknown) => {
    const entries: Array<{ origin: string; key: string; value: string }> = [];
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const origin = String(r.origin || importOrigin || '').trim();
        const key = String(r.key || '').trim();
        if (!origin || !key) continue;
        entries.push({ origin, key, value: typeof r.value === 'string' ? r.value : JSON.stringify(r.value ?? '') });
      }
    } else if (parsed && typeof parsed === 'object') {
      if (!importOrigin) {
        throw new Error(
          '全局导入对象格式时请使用数组：[{"origin":"https://...","key":"k","value":"v"}]，或在指定 Origin 卡片上点击导入。',
        );
      }
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        entries.push({
          origin: importOrigin,
          key: k,
          value: typeof v === 'string' ? v : JSON.stringify(v ?? ''),
        });
      }
    }

    if (entries.length === 0) {
      throw new Error(`未识别到可导入的 ${kvLabel} 条目`);
    }

    for (const item of entries) {
      if (subTab === 'sessionStorage') {
        await sidePanelApi.upsertSessionStorageItem(item.origin, item.key, item.value, filterTrackId || undefined);
      } else {
        await sidePanelApi.upsertLocalStorageItem(item.origin, item.key, item.value, filterTrackId || undefined);
      }
    }
    toast.success(`已导入 ${entries.length} 条 ${kvLabel} 记录`);
    await loadAll();
    await onStatusChanged();
  };

  const handleCaptureExtendedNow = async (explicitOrigin?: string) => {
    let targetOrigin = explicitOrigin || (await resolveActiveTabOrigin(filterSiteKey));
    if (!targetOrigin) {
      targetOrigin =
        idbRecords.find(r => !r.deleted)?.origin ||
        ssRecords.find(r => !r.deleted)?.origin ||
        lsRecords.find(r => !r.deleted)?.origin ||
        (filterSiteKey ? `https://${filterSiteKey}` : null);
    }
    if (!targetOrigin) {
      toast.warning('请先在浏览器打开目标 HTTP/HTTPS 网页标签页');
      return;
    }

    setBusyId('capture-extended');
    try {
      const res = await sidePanelApi.capturePageExtendedStorageNow(targetOrigin);
      toast.success(
        `已从 ${targetOrigin} 抓取：${res.capturedSession} 项 SessionStorage · ${res.capturedIndexedDb} 条 IndexedDB`,
      );
      await loadAll();
      await onStatusChanged();
    } catch (err) {
      toast.error(`抓取页面扩展存储失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleApplyIdbTargetsFromPicker = async (
    resolvedSiteKey: string,
    targets: IndexedDbTargetRule[],
    origin: string,
  ) => {
    const targetSiteKey = filterSiteKey || resolvedSiteKey;
    const existing = siteOverrides[targetSiteKey];
    const mergedTargets: IndexedDbTargetRule[] = [...(existing?.indexedDbTargets ?? [])];
    for (const item of targets) {
      const idx = mergedTargets.findIndex(t => t.dbName === item.dbName);
      if (idx >= 0) {
        const stores = Array.from(
          new Set([...(mergedTargets[idx].objectStores ?? []), ...(item.objectStores ?? [])]),
        ).filter(Boolean);
        mergedTargets[idx] = { ...mergedTargets[idx], objectStores: stores.length > 0 ? stores : undefined };
      } else {
        mergedTargets.push(item);
      }
    }

    await sidePanelApi.upsertSiteRule({
      siteKey: targetSiteKey,
      pattern: existing?.pattern || targetSiteKey,
      direction: existing?.direction || 'bidirectional',
      syncCookies: existing?.syncCookies ?? true,
      syncLocalStorage: existing?.syncLocalStorage ?? true,
      syncSessionStorage: existing?.syncSessionStorage,
      sessionStorageKeyAllowlist: existing?.sessionStorageKeyAllowlist,
      syncIndexedDb: true,
      indexedDbTargets: mergedTargets,
      indexedDbMaxTotalBytes: existing?.indexedDbMaxTotalBytes ?? DEFAULT_INDEXEDDB_QUOTA_BYTES,
      watchedCookieNames: existing?.watchedCookieNames,
      autoRefresh: existing?.autoRefresh ?? spaceSettings?.autoRefresh ?? true,
      updatedAt: Date.now(),
    });

    try {
      const cap = await sidePanelApi.capturePageExtendedStorageNow(origin);
      toast.success(`已启用 ${targetSiteKey} 的轻量 IndexedDB 同步并抓取 ${cap.capturedIndexedDb} 条记录`);
    } catch {
      toast.success(`已为 ${targetSiteKey} 保存 ${targets.length} 个 IndexedDB 同步目标`);
    }

    await loadAll();
    await onStatusChanged();
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedDeleteItems = useMemo(() => {
    if (subTab === 'indexedDb') {
      return idbRecords
        .filter(r => selectedIds.has(r.logicalId))
        .map(r => ({
          logicalId: r.logicalId,
          displayName: `${r.dbName}/${r.storeName}:${decodeIdbKeyPreview(r.encodedKey)} (${r.origin})`,
        }));
    }
    return activeKvRecords
      .filter(r => selectedIds.has(r.logicalId))
      .map(r => ({
        logicalId: r.logicalId,
        displayName: `${r.key} (${r.origin})`,
      }));
  }, [subTab, idbRecords, activeKvRecords, selectedIds]);

  const activeLsCount = lsRecords.filter(r => showDeleted || !r.deleted).length;
  const activeSsCount = ssRecords.filter(r => showDeleted || !r.deleted).length;
  const activeIdbCount = idbRecords.filter(r => showDeleted || !r.deleted).length;

  return (
    <div className={layout === 'wide' ? 'space-y-4' : 'flex h-full flex-col'}>
      {/* Active Account/Site Filter Banner */}
      {filterSiteKey || filterTrackId ? (
        <div
          className={
            layout === 'wide'
              ? 'flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/35 bg-primary/[0.06] px-4 py-2.5 text-xs'
              : 'shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-primary/30 bg-primary/[0.06] px-3 py-2 text-xs'
          }>
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <GitBranch className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="font-medium text-foreground">
              当前仅显示
              {filterSiteKey ? ` ${filterSiteKey}` : ''}
              {filterTrackLabel
                ? ` · 账号「${filterTrackLabel}」`
                : filterTrackId
                  ? ` · 轨道 ${shortId(filterTrackId, 14)}`
                  : ''}
              的网页存储
            </span>
          </div>
          {onClearFilter ? (
            <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={onClearFilter}>
              <X className="mr-1 h-3 w-3" />
              显示全部
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* 3-Way Sub-Tab Switcher */}
      <div
        className={
          layout === 'wide'
            ? 'flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-2.5'
            : 'shrink-0 border-b border-border bg-card/50 px-3 py-2 space-y-2'
        }>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setSubTab('localStorage')}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              subTab === 'localStorage'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}>
            <Database className="h-3 w-3" />
            LocalStorage ({activeLsCount})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('sessionStorage')}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              subTab === 'sessionStorage'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}>
            <Layers className="h-3 w-3" />
            SessionStorage ({activeSsCount})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('indexedDb')}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              subTab === 'indexedDb'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}>
            <HardDrive className="h-3 w-3" />
            IndexedDB (轻量) ({activeIdbCount})
          </button>
        </div>

        {/* Sub-Tab Action Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-foreground">
              {subTab === 'indexedDb'
                ? `${idbGroups.length} 个库表 · ${filteredIdbRecords.length} 条记录`
                : `${kvGroups.length} 个 Origin · ${filteredKvRecords.length} 条键值`}
            </span>
            <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={showDeleted}
                onChange={e => setShowDeleted(e.target.checked)}
                className="h-3 w-3 rounded accent-primary"
              />
              显示已删除
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {selectedDeleteItems.length > 0 ? (
              <Button
                variant="destructive"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setDeleteTargets(selectedDeleteItems)}>
                <Trash2 className="mr-1 h-3 w-3" />
                删除 ({selectedDeleteItems.length})
              </Button>
            ) : null}

            {subTab === 'indexedDb' ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setIdbPickerOpen(true)}>
                  <Search className="mr-1 h-3 w-3" />
                  扫描当前页 IndexedDB 库表
                </Button>
                <Button
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={busyId === 'capture-extended'}
                  onClick={() => void handleCaptureExtendedNow()}>
                  {busyId === 'capture-extended' ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1 h-3 w-3" />
                  )}
                  立即从页面抓取
                </Button>
              </>
            ) : (
              <>
                {subTab === 'sessionStorage' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    disabled={busyId === 'capture-extended'}
                    onClick={() => void handleCaptureExtendedNow()}
                    title="从当前打开网页立即抓取 SessionStorage">
                    {busyId === 'capture-extended' ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="mr-1 h-3 w-3" />
                    )}
                    抓取当前页
                  </Button>
                ) : null}
                <Button size="sm" className="h-7 px-2 text-[11px]" onClick={() => openCreateModal('')}>
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  新建
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => {
                    setImportOrigin(null);
                    setImportOpen(true);
                  }}>
                  <Upload className="mr-1 h-3 w-3" />
                  导入
                </Button>
                <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={handleExportAllJson}>
                  <Download className="mr-1 h-3 w-3" />
                  导出
                </Button>
              </>
            )}

            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={loadAll} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className={layout === 'wide' ? 'space-y-3' : 'flex-1 overflow-y-auto p-3 space-y-3'}>
        {/* SessionStorage Sync Opt-in Helper Banner */}
        {subTab === 'sessionStorage' && !isSessionStorageSyncEnabled ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/35 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
            <div className="min-w-0 flex-1">
              <span className="font-semibold">
                {filterSiteKey
                  ? `站点 ${filterSiteKey} 尚未开启 sessionStorage 同步`
                  : '空间默认尚未开启 sessionStorage 同步'}
              </span>
              <p className="text-[11px] opacity-90">
                为节省流量与避免无效高频写入，sessionStorage 默认按需开启。开启后将随页面变更或离页时自动同步。
              </p>
            </div>
            <Button
              size="sm"
              className="h-7 px-2.5 text-[11px] shrink-0"
              disabled={busyId === 'enable-ss-sync'}
              onClick={() => void handleEnableSessionStorageSync()}>
              {busyId === 'enable-ss-sync' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              {filterSiteKey ? `为 ${filterSiteKey} 一键开启` : '全局默认开启'}
            </Button>
          </div>
        ) : null}

        {loading && activeKvRecords.length === 0 && idbRecords.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在读取网页存储记录...
          </div>
        ) : subTab === 'indexedDb' ? (
          /* IndexedDB (轻量) Body */
          idbGroups.length === 0 ? (
            <EmptyState
              icon={<HardDrive className="h-5 w-5" />}
              title="暂无轻量 IndexedDB 同步记录"
              description="适合同步 Firebase Auth、LocalForage 等轻量认证状态库（默认 1MB 熔断保护）。可点击上方「扫描当前页 IndexedDB 库表」选择库表或「立即从页面抓取」。"
              action={
                <Button size="sm" className="h-8 px-3 text-xs" onClick={() => setIdbPickerOpen(true)}>
                  <Search className="mr-1.5 h-3.5 w-3.5" />
                  扫描当前页 IndexedDB 库表
                </Button>
              }
            />
          ) : (
            idbGroups.map(group => (
              <section key={group.groupKey} className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="border-b border-border bg-muted/30 px-3 py-2 space-y-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs font-semibold text-foreground break-all">
                          {group.dbName} / {group.storeName}
                        </span>
                        {group.dbVersion ? <StatusBadge tone="neutral">v{group.dbVersion}</StatusBadge> : null}
                        <StatusBadge tone="primary">{formatByteSize(group.totalBytes)}</StatusBadge>
                        {group.contextAvailable ? (
                          <StatusBadge tone="success">
                            <Radio className="h-3 w-3" />
                            页面在线
                          </StatusBadge>
                        ) : (
                          <StatusBadge tone="warning">
                            <Clock className="h-3 w-3" />
                            已缓存
                          </StatusBadge>
                        )}
                      </div>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="font-mono break-all">{group.origin}</span>
                        <span>·</span>
                        <span>主域：{group.siteKey}</span>
                        <span>·</span>
                        <span className="inline-flex items-center gap-0.5 font-mono">
                          <GitBranch className="h-3 w-3" />
                          {shortId(group.trackId, 16)}
                        </span>
                        <span>·</span>
                        <span>{group.items.length} 条</span>
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[11px] shrink-0"
                      disabled={busyId === 'capture-extended'}
                      onClick={() => void handleCaptureExtendedNow(group.origin)}>
                      <Sparkles className="mr-1 h-3 w-3" />
                      抓取刷新
                    </Button>
                  </div>
                </div>

                <div className="divide-y divide-border/70">
                  {group.items.map(item => {
                    const syncMeta = getCookieSyncStatusMeta(item.syncStatus);
                    const keyPreview = decodeIdbKeyPreview(item.encodedKey);
                    const valuePreview = decodeTypedClonePreview(item.encodedValue);

                    return (
                      <div
                        key={item.logicalId}
                        className={`px-3 py-2 text-xs space-y-1.5 ${item.deleted ? 'opacity-65 bg-muted/20' : ''}`}>
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(item.logicalId)}
                            onChange={() => toggleSelect(item.logicalId)}
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded accent-primary"
                          />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center justify-between gap-1.5">
                              <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                                <span
                                  className="font-mono font-semibold text-foreground break-all"
                                  title={`原始键: ${item.encodedKey}`}>
                                  {keyPreview}
                                </span>
                                <StatusBadge tone={syncMeta.tone}>{syncMeta.label}</StatusBadge>
                                <StatusBadge tone="neutral">{formatByteSize(item.byteLength)}</StatusBadge>
                                {item.deleted ? <StatusBadge tone="danger">Tombstone</StatusBadge> : null}
                              </div>
                              <span
                                className="text-[10px] text-muted-foreground shrink-0"
                                title={formatDateTime(item.updatedAt)}>
                                {item.sourceDeviceName || shortId(item.sourceDevice, 10)} ·{' '}
                                {formatRelativeTime(item.updatedAt)}
                              </span>
                            </div>

                            <div className="flex items-start gap-1.5 rounded border border-border/70 bg-muted/35 px-2 py-1">
                              <pre className="min-w-0 flex-1 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/90">
                                {valuePreview || '<空>'}
                              </pre>
                              <button
                                type="button"
                                onClick={async () => {
                                  const ok = await copyToClipboard(valuePreview);
                                  if (ok) toast.success(`已复制 ${keyPreview}`);
                                }}
                                className="shrink-0 text-muted-foreground hover:text-foreground"
                                title="复制解码预览值">
                                <Copy className="h-3.5 w-3.5" />
                              </button>
                            </div>

                            <div className="flex items-center justify-between gap-2 pt-0.5">
                              <span className="text-[10px] font-mono text-muted-foreground truncate">
                                v:{shortId(item.version?.versionId, 16)}
                              </span>
                              <div className="flex items-center gap-1">
                                {!item.deleted ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-1.5 text-[11px]"
                                    disabled={busyId === `apply:${item.logicalId}`}
                                    onClick={() => void handleApplyIdbItem(item)}>
                                    {busyId === `apply:${item.logicalId}` ? (
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
                                  onClick={() =>
                                    setHistoryTarget({
                                      title: `${item.dbName}/${item.storeName}:${keyPreview}`,
                                      siteKey: item.siteKey,
                                      logicalId: item.logicalId,
                                    })
                                  }>
                                  <History className="mr-1 h-3 w-3" />
                                  历史
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600"
                                  onClick={() =>
                                    setDeleteTargets([
                                      {
                                        logicalId: item.logicalId,
                                        displayName: `${item.dbName}/${item.storeName}:${keyPreview} (${item.origin})`,
                                      },
                                    ])
                                  }
                                  title="选择作用域删除">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))
          )
        ) : /* LocalStorage / SessionStorage Shared Body */
        kvGroups.length === 0 ? (
          <EmptyState
            icon={subTab === 'sessionStorage' ? <Layers className="h-5 w-5" /> : <Database className="h-5 w-5" />}
            title={`暂无 ${kvLabel} 同步记录`}
            description={
              subTab === 'sessionStorage'
                ? '启用站点或全局 sessionStorage 同步后，标签页会话键值变更将自动采集；也可点击「抓取当前页」或手动新建条目。'
                : '打开启用同步的网站后，Content Script 会按严格 Origin（协议 + 主机 + 端口）自动采集变更。'
            }
          />
        ) : (
          kvGroups.map(group => (
            <section key={group.groupKey} className="rounded-xl border border-border bg-card overflow-hidden">
              {/* Group Header */}
              <div className="border-b border-border bg-muted/30 px-3 py-2 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs font-semibold text-foreground break-all">{group.origin}</span>
                      {group.contextAvailable ? (
                        <StatusBadge tone="success">
                          <Radio className="h-3 w-3" />
                          页面在线（即时写入）
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="warning">
                          <Clock className="h-3 w-3" />
                          已缓存（待网页上下文打开）
                        </StatusBadge>
                      )}
                    </div>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span>主域：{group.siteKey}</span>
                      <span>·</span>
                      <span className="inline-flex items-center gap-0.5 font-mono">
                        <GitBranch className="h-3 w-3" />
                        {shortId(group.trackId, 16)}
                      </span>
                      <span>·</span>
                      <span>{group.items.length} 项</span>
                    </p>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-1.5 text-[11px]"
                      onClick={() => openCreateModal(group.origin)}
                      title="在此 Origin 下新增键值">
                      <Plus className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-1.5 text-[11px]"
                      onClick={() => handleCopyGroupJson(group)}
                      title="复制此 Origin 的键值 JSON">
                      <FileJson className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-1.5 text-[11px]"
                      onClick={() => {
                        setImportOrigin(group.origin);
                        setImportOpen(true);
                      }}
                      title="导入 JSON 到此 Origin">
                      <Upload className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </div>

              {/* Items */}
              <div className="divide-y divide-border/70">
                {group.items.map(item => {
                  const syncMeta = getCookieSyncStatusMeta(item.syncStatus);
                  return (
                    <div
                      key={item.logicalId}
                      className={`px-3 py-2 text-xs space-y-1.5 ${item.deleted ? 'opacity-65 bg-muted/20' : ''}`}>
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(item.logicalId)}
                          onChange={() => toggleSelect(item.logicalId)}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded accent-primary"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center justify-between gap-1.5">
                            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                              <span className="font-mono font-semibold text-foreground break-all">{item.key}</span>
                              <StatusBadge tone={syncMeta.tone}>{syncMeta.label}</StatusBadge>
                              {item.deleted ? <StatusBadge tone="danger">Tombstone</StatusBadge> : null}
                            </div>
                            <span
                              className="text-[10px] text-muted-foreground shrink-0"
                              title={formatDateTime(item.updatedAt)}>
                              {item.sourceDeviceName || shortId(item.sourceDevice, 10)} ·{' '}
                              {formatRelativeTime(item.updatedAt)}
                            </span>
                          </div>

                          <div className="flex items-start gap-1.5 rounded border border-border/70 bg-muted/35 px-2 py-1">
                            <pre className="min-w-0 flex-1 max-h-20 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/90">
                              {item.value || '<空字符串>'}
                            </pre>
                            <button
                              type="button"
                              onClick={async () => {
                                const ok = await copyToClipboard(item.value);
                                if (ok) toast.success(`已复制 ${item.key}`);
                              }}
                              className="shrink-0 text-muted-foreground hover:text-foreground"
                              title="复制值">
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          <div className="flex items-center justify-between gap-2 pt-0.5">
                            <span className="text-[10px] font-mono text-muted-foreground truncate">
                              v:{shortId(item.version?.versionId, 16)}
                            </span>
                            <div className="flex items-center gap-1">
                              {!item.deleted ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 px-1.5 text-[11px]"
                                  disabled={busyId === `apply:${item.logicalId}`}
                                  onClick={() => void handleApplyKvItem(item)}>
                                  {busyId === `apply:${item.logicalId}` ? (
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
                                onClick={() => openEditModal(item)}>
                                <Edit3 className="mr-1 h-3 w-3" />
                                编辑
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 px-1.5 text-[11px]"
                                onClick={() =>
                                  setHistoryTarget({
                                    title: item.key,
                                    siteKey: item.siteKey,
                                    logicalId: item.logicalId,
                                  })
                                }>
                                <History className="mr-1 h-3 w-3" />
                                历史
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600"
                                onClick={() =>
                                  setDeleteTargets([
                                    { logicalId: item.logicalId, displayName: `${item.key} (${item.origin})` },
                                  ])
                                }
                                title="选择作用域删除">
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>

      {/* Add / Edit Modal */}
      <Modal
        open={editorOpen}
        onClose={() => {
          if (!saving) setEditorOpen(false);
        }}
        title={editorIsEdit ? `编辑 ${kvLabel}：${formKey}` : `新增 ${kvLabel} 键值`}
        description="按严格 Origin（协议 + 域名 + 端口）隔离存储与同步。"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setEditorOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button size="sm" onClick={handleSaveItem} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              保存并同步
            </Button>
          </>
        }>
        <div className="space-y-3 text-xs">
          <div className="space-y-1">
            <Label htmlFor="ls-origin" className="text-xs">
              Origin *
            </Label>
            <Input
              id="ls-origin"
              value={formOrigin}
              disabled={editorIsEdit}
              onChange={e => setFormOrigin(e.target.value)}
              placeholder="例如 https://app.example.com"
              className="h-8 text-xs font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ls-key" className="text-xs">
              Key *
            </Label>
            <Input
              id="ls-key"
              value={formKey}
              disabled={editorIsEdit}
              onChange={e => setFormKey(e.target.value)}
              placeholder="例如 auth_token"
              className="h-8 text-xs font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ls-value" className="text-xs">
              Value
            </Label>
            <textarea
              id="ls-value"
              rows={6}
              value={formValue}
              onChange={e => setFormValue(e.target.value)}
              placeholder="支持纯文本或序列化 JSON 字符串..."
              className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {formError ? <p className="text-xs text-rose-600 dark:text-rose-400">{formError}</p> : null}
        </div>
      </Modal>

      <ThreeScopeDeleteModal
        open={deleteTargets.length > 0}
        onClose={() => setDeleteTargets([])}
        itemTypeLabel={
          subTab === 'indexedDb'
            ? 'IndexedDB 条目'
            : subTab === 'sessionStorage'
              ? 'SessionStorage 条目'
              : 'LocalStorage 条目'
        }
        itemNames={deleteTargets.map(r => r.displayName)}
        onConfirm={handleConfirmDelete}
      />

      <VersionHistoryDrawer
        open={!!historyTarget}
        onClose={() => setHistoryTarget(null)}
        title={historyTarget?.title || ''}
        siteKey={historyTarget?.siteKey}
        objectId={historyTarget?.logicalId}
        onRestored={async () => {
          await loadAll();
          await onStatusChanged();
        }}
      />

      <JsonImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={importOrigin ? `导入 ${kvLabel} (${importOrigin})` : `导入 ${kvLabel} JSON`}
        description={
          importOrigin
            ? `支持对象格式 {"key": "value"} 或条目数组，将导入至 ${importOrigin}。`
            : '支持条目数组格式：[{"origin": "https://example.com", "key": "token", "value": "..."}]。'
        }
        placeholder={
          importOrigin
            ? '{"token": "abc123", "theme": "dark"}'
            : '[{"origin": "https://example.com", "key": "token", "value": "abc123"}]'
        }
        onImport={handleImportJson}
      />

      <IndexedDbPickerModal
        open={idbPickerOpen}
        onClose={() => setIdbPickerOpen(false)}
        initialSiteKey={filterSiteKey || undefined}
        existingTargets={filterSiteKey ? siteOverrides[filterSiteKey]?.indexedDbTargets : undefined}
        confirmLabel="启用同步并抓取"
        onApplyTargets={handleApplyIdbTargetsFromPicker}
      />
    </div>
  );
};
