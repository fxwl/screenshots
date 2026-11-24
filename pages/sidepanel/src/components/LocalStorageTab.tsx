import { extractErrorMessage, sidePanelApi } from '@src/lib/api';
import {
  copyToClipboard,
  downloadJsonFile,
  formatDateTime,
  formatRelativeTime,
  getCookieSyncStatusMeta,
  shortId,
} from '@src/lib/format';
import type { DeleteScope, LocalStorageRecord } from '@sessionmesh/shared';
import { Button, Input, Label } from '@sessionmesh/ui';
import {
  Clock,
  Copy,
  Database,
  Download,
  Edit3,
  FileJson,
  GitBranch,
  History,
  Loader2,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Trash2,
  Upload,
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

export interface LocalStorageTabProps {
  globalSearch: string;
  onStatusChanged: () => Promise<void> | void;
  refreshSignal: number;
}

interface OriginTrackGroup {
  groupKey: string;
  origin: string;
  siteKey: string;
  trackId: string;
  contextAvailable: boolean;
  items: LocalStorageRecord[];
}

export const LocalStorageTab: React.FC<LocalStorageTabProps> = ({ globalSearch, onStatusChanged, refreshSignal }) => {
  const [records, setRecords] = useState<LocalStorageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);

  // Add / Edit modal
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorIsEdit, setEditorIsEdit] = useState(false);
  const [formOrigin, setFormOrigin] = useState('');
  const [formKey, setFormKey] = useState('');
  const [formValue, setFormValue] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Delete / History / Import
  const [deleteTargets, setDeleteTargets] = useState<LocalStorageRecord[]>([]);
  const [historyTarget, setHistoryTarget] = useState<LocalStorageRecord | null>(null);
  const [importOrigin, setImportOrigin] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const list = await sidePanelApi.getLocalStorageRecords();
      setRecords(list || []);
      setSelectedIds(prev => {
        const valid = new Set((list || []).map(r => r.logicalId));
        return new Set([...prev].filter(id => valid.has(id)));
      });
    } catch (err) {
      toast.error(`加载 LocalStorage 失败：${extractErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecords();
  }, [loadRecords, refreshSignal]);

  const query = globalSearch.trim().toLowerCase();

  const filteredRecords = useMemo(() => {
    return records.filter(r => {
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
  }, [records, showDeleted, query]);

  const groups = useMemo<OriginTrackGroup[]>(() => {
    const map = new Map<string, OriginTrackGroup>();
    for (const item of filteredRecords) {
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
  }, [filteredRecords]);

  const openCreateModal = (presetOrigin = '') => {
    setEditorIsEdit(false);
    setFormOrigin(presetOrigin);
    setFormKey('');
    setFormValue('');
    setFormError(null);
    setEditorOpen(true);
  };

  const openEditModal = (record: LocalStorageRecord) => {
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
      const saved = await sidePanelApi.upsertLocalStorageItem(origin, key, formValue);
      toast.success(
        saved.contextAvailable
          ? `已保存并写入页面 LocalStorage：${key}`
          : `已保存 ${key}（页面未打开，已缓存待上下文可用后自动写入）`,
      );
      setEditorOpen(false);
      await loadRecords();
      await onStatusChanged();
    } catch (err) {
      setFormError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleApplyItem = async (record: LocalStorageRecord) => {
    setBusyId(`apply:${record.logicalId}`);
    try {
      const updated = await sidePanelApi.applyLocalStorageItem(record.logicalId);
      if (updated?.contextAvailable) {
        toast.success(`已实时应用至 ${record.origin}：${record.key}`);
      } else {
        toast.info(`已排队待应用：当前无打开的 ${record.origin} 标签页，打开后自动写入`);
      }
      await loadRecords();
    } catch (err) {
      toast.error(`应用失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmDelete = async (scope: DeleteScope) => {
    const ids = deleteTargets.map(r => r.logicalId);
    if (ids.length === 0) return;
    await sidePanelApi.deleteLocalStorageItems(ids, scope);
    toast.success(`已删除 ${ids.length} 条 LocalStorage 记录`);
    setSelectedIds(prev => {
      const next = new Set(prev);
      ids.forEach(id => next.delete(id));
      return next;
    });
    await loadRecords();
    await onStatusChanged();
  };

  const handleCopyGroupJson = async (group: OriginTrackGroup) => {
    const obj: Record<string, string> = {};
    for (const item of group.items) {
      if (!item.deleted) obj[item.key] = item.value;
    }
    const ok = await copyToClipboard(JSON.stringify(obj, null, 2));
    if (ok) toast.success(`已复制 ${group.origin} 的 ${Object.keys(obj).length} 项 JSON`);
    else toast.error('复制失败');
  };

  const handleExportAllJson = () => {
    const payload = filteredRecords
      .filter(r => !r.deleted)
      .map(r => ({
        origin: r.origin,
        key: r.key,
        value: r.value,
      }));
    downloadJsonFile('sessionmesh-localstorage.json', payload);
    toast.success(`已导出 ${payload.length} 条 LocalStorage JSON`);
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
      throw new Error('未识别到可导入的 LocalStorage 条目');
    }

    for (const item of entries) {
      await sidePanelApi.upsertLocalStorageItem(item.origin, item.key, item.value);
    }
    toast.success(`已导入 ${entries.length} 条 LocalStorage 记录`);
    await loadRecords();
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

  const selectedRecords = records.filter(r => selectedIds.has(r.logicalId));

  return (
    <div className="flex h-full flex-col">
      {/* Top Toolbar */}
      <div className="shrink-0 border-b border-border bg-card/50 px-3 py-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-foreground">
            {groups.length} 个 Origin · {filteredRecords.length} 条键值
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

        <div className="flex items-center gap-1">
          {selectedIds.size > 0 ? (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setDeleteTargets(selectedRecords)}>
              <Trash2 className="mr-1 h-3 w-3" />
              删除 ({selectedIds.size})
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
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={loadRecords} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Grouped Origin + Track List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading && records.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在读取 LocalStorage 记录...
          </div>
        ) : groups.length === 0 ? (
          <EmptyState
            icon={<Database className="h-5 w-5" />}
            title="暂无 LocalStorage 同步记录"
            description="打开启用同步的网站后，Content Script 会按严格 Origin（协议 + 主机 + 端口）自动采集变更。"
          />
        ) : (
          groups.map(group => (
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
                                  onClick={() => handleApplyItem(item)}>
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
                                onClick={() => setHistoryTarget(item)}>
                                <History className="mr-1 h-3 w-3" />
                                历史
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600"
                                onClick={() => setDeleteTargets([item])}
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
        title={editorIsEdit ? `编辑 LocalStorage：${formKey}` : '新增 LocalStorage 键值'}
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
        itemTypeLabel="LocalStorage 条目"
        itemNames={deleteTargets.map(r => `${r.key} (${r.origin})`)}
        onConfirm={handleConfirmDelete}
      />

      <VersionHistoryDrawer
        open={!!historyTarget}
        onClose={() => setHistoryTarget(null)}
        title={historyTarget?.key || ''}
        siteKey={historyTarget?.siteKey}
        objectId={historyTarget?.logicalId}
        onRestored={async () => {
          await loadRecords();
          await onStatusChanged();
        }}
      />

      <JsonImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={importOrigin ? `导入 LocalStorage (${importOrigin})` : '导入 LocalStorage JSON'}
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
    </div>
  );
};
