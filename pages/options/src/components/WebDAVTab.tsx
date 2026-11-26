import type {
  CapabilityReport,
  IntegrityReport,
  SanitizedStorageProviderConfig,
  SyncStatusSummary,
  WebDAVConfig,
  WebDAVResourceStat,
} from '@sessionmesh/core';
import { unwrapCommand } from '@sessionmesh/shared';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@sessionmesh/ui';
import {
  AlertTriangle,
  Archive,
  ArrowUp,
  Camera,
  CheckCircle2,
  ChevronRight,
  Clock,
  Database,
  File,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  extractErrorMessage,
  formatBytes,
  formatDateTime,
  formatRelativeTime,
  getConsistencyMeta,
  getStorageProviderMeta,
  loadUiNonSensitiveMeta,
  saveUiNonSensitiveMeta,
  useUiBannerPrefs,
} from '../utils/helpers';
import {
  isDirectoryPickerSupported,
  pickAndStoreLocalDirectory,
  queryLocalDirectoryPermission,
  requestLocalDirectoryPermission,
  type DirectoryPermissionState,
} from '../utils/localDirHandles';
import { CapabilityReportView } from './CapabilityReportView';
import { LocalBackupCard } from './LocalBackupCard';
import {
  buildStorageConfigFromDraft,
  createDefaultStorageDraft,
  draftFromStorageConfig,
  StorageProviderForm,
  toNonSensitiveMetaPatch,
  validateStorageDraft,
  type StorageFormDraft,
} from './StorageProviderForm';

interface WebDAVTabProps {
  status: SyncStatusSummary;
  onRefreshStatus: () => Promise<void>;
}

function normalizeUrlCompare(raw?: string): string {
  return (raw || '').trim().replace(/\/+$/, '').toLowerCase();
}

function doesCapabilityReportMatchBackend(
  report: CapabilityReport | null | undefined,
  cfg:
    | { provider: string; url?: string; endpoint?: string; bucket?: string; apiBaseUrl?: string; gistId?: string }
    | null
    | undefined,
  fallbackProvider?: string,
  fallbackEndpoint?: string,
): boolean {
  if (!report) return false;
  const rUrl = normalizeUrlCompare(report.url);
  if (!rUrl) return false;
  if (cfg) {
    if (cfg.provider === 'webdav') {
      const target = normalizeUrlCompare(cfg.url);
      return Boolean(target && rUrl.startsWith(target));
    }
    if (cfg.provider === 's3') {
      const epHost = normalizeUrlCompare(cfg.endpoint).replace(/^https?:\/\//, '');
      const bucket = (cfg.bucket || '').trim().toLowerCase();
      return Boolean(epHost && rUrl.includes(epHost) && (!bucket || rUrl.includes(bucket)));
    }
    if (cfg.provider === 'github_gist') {
      const api = normalizeUrlCompare(cfg.apiBaseUrl || 'https://api.github.com');
      const gid = (cfg.gistId || '').trim().toLowerCase();
      return Boolean(rUrl.startsWith(api) && rUrl.includes('/gists') && (!gid || rUrl.includes(gid)));
    }
    if (cfg.provider === 'local_directory') {
      return rUrl.startsWith('local://');
    }
  }
  const ep = normalizeUrlCompare(fallbackEndpoint);
  if (!ep) return false;
  if (fallbackProvider === 's3') {
    const hostPart = ep.split(' ')[0].replace(/^https?:\/\//, '');
    return Boolean(hostPart && rUrl.includes(hostPart));
  }
  return rUrl.startsWith(ep) || ep.startsWith(rUrl);
}

export function WebDAVTab({ status, onRefreshStatus }: WebDAVTabProps) {
  const { isBannerVisible, dismissBanner } = useUiBannerPrefs();
  // Cached non-sensitive meta & storage config drawer
  const [lastReport, setLastReport] = useState<CapabilityReport | null>(null);
  const [testPanelOpen, setTestPanelOpen] = useState(false);
  const [storageDraft, setStorageDraft] = useState<StorageFormDraft>(() =>
    createDefaultStorageDraft(status.storageProvider ?? 'webdav'),
  );
  const [testingConn, setTestingConn] = useState(false);
  const [savingStorage, setSavingStorage] = useState(false);
  const [localDirPermState, setLocalDirPermState] = useState<DirectoryPermissionState | 'missing' | null>(null);
  const [restoringDirPerm, setRestoringDirPerm] = useState(false);

  // Remote Directory Browser
  const [currentSubPath, setCurrentSubPath] = useState('');
  const [dirEntries, setDirEntries] = useState<WebDAVResourceStat[]>([]);
  const [loadingDir, setLoadingDir] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  // Maintenance operations
  const [checkingIntegrity, setCheckingIntegrity] = useState(false);
  const [integrityReport, setIntegrityReport] = useState<IntegrityReport | null>(null);
  const [rebuildingIndex, setRebuildingIndex] = useState(false);
  const [creatingSnapshot, setCreatingSnapshot] = useState(false);
  const [runningGc, setRunningGc] = useState(false);
  const [lastGcResult, setLastGcResult] = useState<{ removedEventFiles: number; reclaimedTombstones: number } | null>(
    null,
  );

  // Cloud Backups
  const [backups, setBackups] = useState<WebDAVResourceStat[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [restoringBackup, setRestoringBackup] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadUiNonSensitiveMeta(),
      unwrapCommand<{
        storage?: SanitizedStorageProviderConfig | null;
        webdav?: Omit<WebDAVConfig, 'password' | 'bearerToken'> | null;
      }>({ type: 'GET_STATUS_SUMMARY' }).catch(() => null),
    ]).then(([meta, summary]) => {
      if (!active) return;
      const cfgFromSummary: SanitizedStorageProviderConfig | null =
        summary?.storage ?? (summary?.webdav ? { provider: 'webdav', ...summary.webdav } : null);
      if (
        meta.lastCapabilityReport &&
        doesCapabilityReportMatchBackend(
          meta.lastCapabilityReport,
          cfgFromSummary,
          status.storageProvider,
          status.storageEndpoint,
        )
      ) {
        setLastReport(meta.lastCapabilityReport);
      } else {
        setLastReport(null);
      }
      setStorageDraft(draftFromStorageConfig(cfgFromSummary, meta));
    });
    return () => {
      active = false;
    };
  }, [status.activeSpaceId, status.storageProvider, status.storageEndpoint]);

  const localDirAttention = (status.attentionItems ?? []).find(item => item.kind === 'local_dir_permission_needed');
  const activeHandleKey =
    localDirAttention?.handleKey ||
    (storageDraft.provider === 'local_directory' ? storageDraft.localDirHandleKey : '') ||
    '';

  useEffect(() => {
    if (status.storageProvider !== 'local_directory' || !activeHandleKey || !isDirectoryPickerSupported()) {
      setLocalDirPermState(null);
      return;
    }
    let active = true;
    void queryLocalDirectoryPermission(activeHandleKey, 'readwrite').then(state => {
      if (active) setLocalDirPermState(state);
    });
    return () => {
      active = false;
    };
  }, [status.storageProvider, activeHandleKey]);

  const loadDirectory = useCallback(async (subPath: string) => {
    setLoadingDir(true);
    setDirError(null);
    try {
      const list = await unwrapCommand<WebDAVResourceStat[]>({
        type: 'WEBDAV_LIST_DIR',
        subPath: subPath || undefined,
      });
      setDirEntries(Array.isArray(list) ? list : []);
      setCurrentSubPath(subPath);
    } catch (err) {
      setDirError(extractErrorMessage(err));
    } finally {
      setLoadingDir(false);
    }
  }, []);

  const loadBackups = useCallback(async () => {
    setLoadingBackups(true);
    try {
      const list = await unwrapCommand<WebDAVResourceStat[]>({ type: 'WEBDAV_LIST_BACKUPS' });
      setBackups(Array.isArray(list) ? list : []);
    } catch (err) {
      toast.error(`加载远端备份列表失败：${extractErrorMessage(err)}`);
    } finally {
      setLoadingBackups(false);
    }
  }, []);

  useEffect(() => {
    if (!status.locked && status.configured) {
      void loadDirectory('');
      void loadBackups();
    }
  }, [status.locked, status.configured, status.activeSpaceId, loadDirectory, loadBackups]);

  const handleRestoreLocalDirPermission = async () => {
    if (!isDirectoryPickerSupported()) {
      toast.error('当前浏览器不支持 File System Access API (showDirectoryPicker)');
      return;
    }
    setRestoringDirPerm(true);
    try {
      let targetHandleKey = activeHandleKey;
      let granted = false;

      if (targetHandleKey) {
        const perm = await requestLocalDirectoryPermission(targetHandleKey, 'readwrite');
        setLocalDirPermState(perm);
        if (perm === 'granted') {
          granted = true;
        }
      }

      if (!granted) {
        const picked = await pickAndStoreLocalDirectory(targetHandleKey || undefined);
        targetHandleKey = picked.handleKey;
        setLocalDirPermState(picked.permissionState);
        if (picked.permissionState === 'granted') {
          granted = true;
          if (!activeHandleKey || picked.directoryLabel !== storageDraft.localDirLabel) {
            const nextDraft: StorageFormDraft = {
              ...storageDraft,
              provider: 'local_directory',
              localDirHandleKey: picked.handleKey,
              localDirLabel: picked.directoryLabel,
            };
            setStorageDraft(nextDraft);
            await unwrapCommand({
              type: 'UPDATE_SPACE_STORAGE_CONFIG',
              storage: buildStorageConfigFromDraft(nextDraft),
            }).catch(() => undefined);
          }
        }
      }

      if (granted) {
        await unwrapCommand({
          type: 'NOTIFY_LOCAL_DIR_PERMISSION_GRANTED',
          handleKey: targetHandleKey || undefined,
        });
        toast.success('已恢复本地同步文件夹读写授权，同步引擎已恢复');
        await onRefreshStatus();
        void loadDirectory('');
        void loadBackups();
      } else {
        toast.warning('未能获取目录读写权限，请在浏览器授权弹窗中点击允许');
      }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (!isAbort) {
        toast.error(`恢复本地文件夹授权失败：${extractErrorMessage(err)}`);
      }
    } finally {
      setRestoringDirPerm(false);
    }
  };

  const handleRunRetest = async () => {
    const errMsg = validateStorageDraft(storageDraft);
    if (errMsg) {
      toast.warning(errMsg);
      return;
    }
    setTestingConn(true);
    try {
      const cfg = buildStorageConfigFromDraft(storageDraft);
      const report = await unwrapCommand<CapabilityReport>({
        type: 'TEST_STORAGE_CONNECTION',
        storage: cfg,
      });
      setLastReport(report);
      let nextDraft = storageDraft;
      if (
        report.overallOk &&
        report.resolvedGistId &&
        storageDraft.provider === 'github_gist' &&
        !storageDraft.gistId.trim()
      ) {
        nextDraft = { ...storageDraft, gistId: report.resolvedGistId };
        setStorageDraft(nextDraft);
      }
      await saveUiNonSensitiveMeta({
        ...toNonSensitiveMetaPatch(nextDraft),
        lastCapabilityReport: report,
      });
      toast.success(
        report.overallOk ? `${report.checks.length} 项存储能力检测通过` : '部分检测项未通过，请展开清单查看详情',
      );
    } catch (err) {
      toast.error(`检测失败：${extractErrorMessage(err)}`);
    } finally {
      setTestingConn(false);
    }
  };

  const handleSaveStorageConfig = async () => {
    const errMsg = validateStorageDraft(storageDraft);
    if (errMsg) {
      toast.warning(errMsg);
      return;
    }
    setSavingStorage(true);
    try {
      const cfg = buildStorageConfigFromDraft(storageDraft);
      await unwrapCommand({
        type: 'UPDATE_SPACE_STORAGE_CONFIG',
        storage: cfg,
      });
      const reportStillMatches = doesCapabilityReportMatchBackend(lastReport, cfg);
      if (!reportStillMatches) {
        setLastReport(null);
      }
      await saveUiNonSensitiveMeta({
        ...toNonSensitiveMetaPatch(storageDraft),
        lastCapabilityReport: reportStillMatches ? lastReport ?? undefined : undefined,
      });
      toast.success(`已更新空间存储后端为 ${getStorageProviderMeta(cfg.provider).shortLabel}`);
      setTestPanelOpen(false);
      await onRefreshStatus();
      void loadDirectory('');
      void loadBackups();
    } catch (err) {
      toast.error(`更新存储后端失败：${extractErrorMessage(err)}`);
    } finally {
      setSavingStorage(false);
    }
  };

  const handleCheckIntegrity = async () => {
    setCheckingIntegrity(true);
    try {
      const rep = await unwrapCommand<IntegrityReport>({ type: 'WEBDAV_CHECK_INTEGRITY' });
      setIntegrityReport(rep);
      if (rep.ok) {
        toast.success('远端加密数据完整性校验通过');
      } else {
        toast.warning(`发现 ${rep.corruptedPaths.length} 个损坏文件或 ${rep.missingSeqGaps.length} 处序列缺口`);
      }
    } catch (err) {
      toast.error(`完整性检查失败：${extractErrorMessage(err)}`);
    } finally {
      setCheckingIntegrity(false);
    }
  };

  const handleRebuildIndex = async () => {
    setRebuildingIndex(true);
    try {
      await unwrapCommand({ type: 'WEBDAV_REBUILD_INDEX' });
      toast.success('已从远端全量事件与快照重建本地索引');
      await onRefreshStatus();
    } catch (err) {
      toast.error(`重建索引失败：${extractErrorMessage(err)}`);
    } finally {
      setRebuildingIndex(false);
    }
  };

  const handleCreateSnapshot = async () => {
    setCreatingSnapshot(true);
    try {
      const res = await unwrapCommand<{ snapshotId: string }>({ type: 'WEBDAV_CREATE_SNAPSHOT' });
      toast.success(`已生成加密快照：${res?.snapshotId || '成功'}`);
      void loadDirectory(currentSubPath);
    } catch (err) {
      toast.error(`生成快照失败：${extractErrorMessage(err)}`);
    } finally {
      setCreatingSnapshot(false);
    }
  };

  const handleGarbageCollect = async () => {
    setRunningGc(true);
    try {
      const res = await unwrapCommand<{ removedEventFiles: number; reclaimedTombstones: number }>({
        type: 'WEBDAV_GARBAGE_COLLECT',
      });
      setLastGcResult(res);
      toast.success(
        `安全清理完成：移除 ${res?.removedEventFiles ?? 0} 个旧事件文件，回收 ${res?.reclaimedTombstones ?? 0} 条墓碑`,
      );
      void loadDirectory(currentSubPath);
    } catch (err) {
      toast.error(`历史清理失败：${extractErrorMessage(err)}`);
    } finally {
      setRunningGc(false);
    }
  };

  const handleCreateBackup = async () => {
    setCreatingBackup(true);
    try {
      const res = await unwrapCommand<{ backupId: string }>({ type: 'WEBDAV_CREATE_BACKUP' });
      toast.success(`已创建加密备份：${res?.backupId || '成功'}`);
      await loadBackups();
    } catch (err) {
      toast.error(`创建备份失败：${extractErrorMessage(err)}`);
    } finally {
      setCreatingBackup(false);
    }
  };

  const handleRestoreBackup = async () => {
    if (!restoreTarget) return;
    setRestoringBackup(true);
    try {
      await unwrapCommand({ type: 'WEBDAV_RESTORE_BACKUP', backupId: restoreTarget });
      toast.success(`已从备份 ${restoreTarget} 恢复空间数据`);
      setRestoreTarget(null);
      await onRefreshStatus();
    } catch (err) {
      toast.error(`恢复备份失败：${extractErrorMessage(err)}`);
    } finally {
      setRestoringBackup(false);
    }
  };

  const navigateUp = () => {
    const parts = currentSubPath.split('/').filter(Boolean);
    parts.pop();
    void loadDirectory(parts.join('/'));
  };

  const enterDirectory = (entry: WebDAVResourceStat) => {
    const next = currentSubPath ? `${currentSubPath.replace(/\/$/, '')}/${entry.name}` : entry.name;
    void loadDirectory(next);
  };

  const consistency = getConsistencyMeta(status.consistencyLevel ?? lastReport?.consistencyLevel);
  const providerMeta = getStorageProviderMeta(status.storageProvider);
  const breadcrumbs = currentSubPath.split('/').filter(Boolean);
  const showLocalDirRecoveryBanner =
    Boolean(localDirAttention) ||
    (status.storageProvider === 'local_directory' && localDirPermState !== null && localDirPermState !== 'granted');

  const displayEndpoint =
    status.storageEndpoint ||
    status.webdavUrl ||
    (storageDraft.provider === 'webdav' ? storageDraft.webdavUrl : '') ||
    '未记录';

  return (
    <div className="space-y-5">
      {/* 1-Click Local Directory Permission Recovery Banner */}
      {showLocalDirRecoveryBanner ? (
        <Alert className="border-amber-500/60 bg-amber-500/12">
          <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <AlertTitle className="text-sm font-semibold">
                {localDirAttention?.title || '本地同步文件夹需要重新授予读写权限'}
              </AlertTitle>
              <AlertDescription className="text-xs leading-relaxed">
                {localDirAttention?.detail ||
                  '浏览器重启后出于安全策略需要重新确认一次本地目录的读写授权（OneDrive / iCloud / 本地同步目录）。'}
              </AlertDescription>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={restoringDirPerm}
              onClick={() => void handleRestoreLocalDirPermission()}
              className="shrink-0">
              {restoringDirPerm ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
              )}
              恢复本地文件夹读写授权
            </Button>
          </div>
        </Alert>
      ) : null}

      {/* Connection Overview */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <Server className="h-5 w-5 text-primary" />
                存储后端总览与能力状态
                <Badge variant="info" className="text-[11px]">
                  {providerMeta.shortLabel}
                </Badge>
              </CardTitle>
              <CardDescription>
                所有写入远端或本地同步目录的对象均采用不透明空间哈希与设备 UUID，绝不暴露域名或 Cookie 名称。
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setTestPanelOpen(prev => !prev)}>
                <ShieldCheck className="mr-1.5 h-4 w-4" />
                {testPanelOpen ? '收起配置与检测' : '切换后端 / 重新测试'}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-border bg-muted/25 p-3">
              <div className="text-xs text-muted-foreground">连接状态</div>
              <div className="mt-1.5 flex items-center gap-2">
                <Badge variant={status.webdavConnected ? 'success' : 'destructive'}>
                  {status.webdavConnected ? '已连接' : '未连接'}
                </Badge>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-muted/25 p-3">
              <div className="text-xs text-muted-foreground">并发一致性模式</div>
              <div className="mt-1.5">
                <Badge variant={consistency.variant}>{consistency.shortLabel}</Badge>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-muted/25 p-3">
              <div className="text-xs text-muted-foreground">最近响应延迟</div>
              <div className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                {status.lastLatencyMs !== undefined
                  ? `${status.lastLatencyMs} ms`
                  : lastReport
                    ? `${lastReport.totalLatencyMs} ms`
                    : '-'}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-muted/25 p-3">
              <div className="text-xs text-muted-foreground">最近同步时间</div>
              <div className="mt-1 text-sm font-semibold">{formatRelativeTime(status.lastSyncAt)}</div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background px-3.5 py-2.5 text-xs flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted-foreground">
              当前存储后端：<strong className="text-foreground">{providerMeta.label}</strong>
            </span>
            <span className="text-muted-foreground">
              端点路径：<code className="text-foreground break-all">{displayEndpoint}</code>
            </span>
          </div>

          {(status.consistencyLevel ?? lastReport?.consistencyLevel) === 'append_only_degraded' &&
          isBannerVisible('webdav_tab_degraded_warn', 'degraded') ? (
            <Alert className="border-amber-500/40 bg-amber-500/10 pr-24">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <AlertTitle className="text-sm font-semibold">单写者追加兼容模式提示</AlertTitle>
              <AlertDescription className="text-xs leading-relaxed">{consistency.description}</AlertDescription>
              <div className="absolute right-3 top-3 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void dismissBanner('webdav_tab_degraded_warn')}
                  className="rounded px-1.5 py-0.5 text-[11px] text-amber-900/80 hover:bg-amber-500/20 dark:text-amber-200">
                  不再提示
                </button>
                <button
                  type="button"
                  aria-label="关闭降级提示"
                  onClick={() => void dismissBanner('webdav_tab_degraded_warn')}
                  className="rounded p-1 text-amber-900/80 hover:bg-amber-500/20 dark:text-amber-200">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </Alert>
          ) : null}

          {testPanelOpen ? (
            <div className="rounded-xl border border-primary/25 bg-primary/[0.02] p-4 space-y-4">
              <StorageProviderForm
                draft={storageDraft}
                onChange={setStorageDraft}
                notifyPermissionOnGrant={true}
                onLocalDirPermissionGranted={onRefreshStatus}
                secretHint="出于安全原因，已有密钥/Token 不会明文回显；重新测试或保存更新前请重新填入对应密钥（本地文件夹无需密钥）。"
              />
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button type="button" variant="outline" size="sm" disabled={testingConn} onClick={handleRunRetest}>
                  {testingConn ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="mr-1.5 h-4 w-4" />
                  )}
                  测试当前后端连接
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={savingStorage || status.locked}
                  onClick={handleSaveStorageConfig}>
                  {savingStorage ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-1.5 h-4 w-4" />
                  )}
                  保存并更新当前空间后端
                </Button>
              </div>
            </div>
          ) : null}

          {lastReport ? <CapabilityReportView report={lastReport} /> : null}
        </CardContent>
      </Card>

      {/* Universal Local Encrypted Single-File Backup & Restore (.smesh-backup) */}
      <LocalBackupCard status={status} onRefreshStatus={onRefreshStatus} />

      {/* Maintenance Actions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wrench className="h-5 w-5 text-primary" />
            数据维护、快照与安全垃圾回收
          </CardTitle>
          <CardDescription>
            定期生成快照可加快新设备加入速度；安全清理（GC）仅回收已被所有活跃设备检查点确认的历史文件。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Button
              type="button"
              variant="outline"
              disabled={checkingIntegrity || status.locked}
              onClick={handleCheckIntegrity}
              className="h-auto flex-col items-start gap-1 p-3.5 text-left">
              <div className="flex items-center gap-2 font-semibold text-sm">
                {checkingIntegrity ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                )}
                数据完整性检查
              </div>
              <span className="text-[11px] font-normal text-muted-foreground">校验密文 AEAD、元数据与事件序列</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              disabled={rebuildingIndex || status.locked}
              onClick={handleRebuildIndex}
              className="h-auto flex-col items-start gap-1 p-3.5 text-left">
              <div className="flex items-center gap-2 font-semibold text-sm">
                {rebuildingIndex ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Database className="h-4 w-4 text-sky-600" />
                )}
                重建本地索引
              </div>
              <span className="text-[11px] font-normal text-muted-foreground">从远端快照与事件全量重算本地状态</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              disabled={creatingSnapshot || status.locked}
              onClick={handleCreateSnapshot}
              className="h-auto flex-col items-start gap-1 p-3.5 text-left">
              <div className="flex items-center gap-2 font-semibold text-sm">
                {creatingSnapshot ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4 text-primary" />
                )}
                生成加密快照
              </div>
              <span className="text-[11px] font-normal text-muted-foreground">固化当前全量状态加速新设备同步</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              disabled={runningGc || status.locked}
              onClick={handleGarbageCollect}
              className="h-auto flex-col items-start gap-1 p-3.5 text-left">
              <div className="flex items-center gap-2 font-semibold text-sm">
                {runningGc ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 text-amber-600" />
                )}
                安全清理历史 (GC)
              </div>
              <span className="text-[11px] font-normal text-muted-foreground">安全回收已确认旧事件与过期墓碑</span>
            </Button>
          </div>

          {lastGcResult ? (
            <Alert className="border-emerald-500/35 bg-emerald-500/5 pr-10">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <AlertTitle className="text-sm">最近一次安全 GC 结果</AlertTitle>
              <AlertDescription className="text-xs">
                已安全移除 {lastGcResult.removedEventFiles} 个历史事件文件，回收 {lastGcResult.reclaimedTombstones}{' '}
                条可回收墓碑记录。
              </AlertDescription>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => setLastGcResult(null)}
                className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:bg-background/60 hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </Alert>
          ) : null}

          {integrityReport ? (
            <div
              className={`rounded-xl border p-4 space-y-2 ${
                integrityReport.ok ? 'border-emerald-500/35 bg-emerald-500/5' : 'border-destructive/40 bg-destructive/5'
              }`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold text-sm">
                  <Badge variant={integrityReport.ok ? 'success' : 'destructive'}>
                    {integrityReport.ok ? '完整性校验通过' : '发现异常'}
                  </Badge>
                  <span>检测时间：{formatDateTime(integrityReport.checkedAt)}</span>
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>元数据：{integrityReport.spaceMetadataOk ? '正常' : '异常'}</span>
                  <span>设备文件：{integrityReport.deviceFilesCount}</span>
                  <span>事件文件：{integrityReport.eventFilesCount}</span>
                  <span>快照文件：{integrityReport.snapshotFilesCount}</span>
                </div>
              </div>
              {integrityReport.corruptedPaths.length > 0 ? (
                <div className="text-xs text-destructive">损坏路径：{integrityReport.corruptedPaths.join(', ')}</div>
              ) : null}
              {integrityReport.missingSeqGaps.length > 0 ? (
                <div className="text-xs text-amber-700 dark:text-amber-300">
                  序列缺口：{integrityReport.missingSeqGaps.join(', ')}
                </div>
              ) : null}
              {integrityReport.details.length > 0 ? (
                <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                  {integrityReport.details.map((line, idx) => (
                    <li key={idx}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Remote Directory Browser */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <FolderOpen className="h-5 w-5 text-primary" />
                远端存储目录浏览器
              </CardTitle>
              <CardDescription>只读浏览当前加密空间在后端存储下的目录结构、文件大小与 ETag。</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {currentSubPath ? (
                <Button type="button" variant="outline" size="sm" onClick={navigateUp} disabled={loadingDir}>
                  <ArrowUp className="mr-1 h-3.5 w-3.5" />
                  上一级
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => loadDirectory(currentSubPath)}
                disabled={loadingDir || status.locked}>
                {loadingDir ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                刷新目录
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Breadcrumbs */}
          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted/50 px-3 py-1.5 text-xs">
            <button
              type="button"
              onClick={() => loadDirectory('')}
              className="font-medium text-primary hover:underline">
              空间根目录
            </button>
            {breadcrumbs.map((seg, idx) => {
              const target = breadcrumbs.slice(0, idx + 1).join('/');
              return (
                <span key={target} className="inline-flex items-center gap-1">
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  <button
                    type="button"
                    onClick={() => loadDirectory(target)}
                    className="font-mono hover:text-primary hover:underline">
                    {seg}
                  </button>
                </span>
              );
            })}
          </div>

          {dirError ? (
            <Alert variant="destructive" className="pr-10">
              <AlertDescription className="text-xs">{dirError}</AlertDescription>
              <button
                type="button"
                aria-label="关闭错误提示"
                onClick={() => setDirError(null)}
                className="absolute right-3 top-3 rounded p-1 text-destructive/80 hover:bg-destructive/10 hover:text-destructive">
                <X className="h-3.5 w-3.5" />
              </button>
            </Alert>
          ) : null}

          <div className="overflow-hidden rounded-lg border border-border">
            {loadingDir ? (
              <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                正在读取远端目录...
              </div>
            ) : dirEntries.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">当前目录为空</div>
            ) : (
              <div className="max-h-72 overflow-y-auto divide-y divide-border/70">
                {dirEntries.map(entry => (
                  <div
                    key={entry.path || entry.href || entry.name}
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs hover:bg-muted/35">
                    <div className="flex min-w-0 items-center gap-2">
                      {entry.isCollection ? (
                        <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                      ) : (
                        <File className="h-4 w-4 shrink-0 text-sky-500" />
                      )}
                      {entry.isCollection ? (
                        <button
                          type="button"
                          onClick={() => enterDirectory(entry)}
                          className="truncate font-mono font-medium text-primary hover:underline">
                          {entry.name}/
                        </button>
                      ) : (
                        <span className="truncate font-mono text-foreground">{entry.name}</span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-4 text-[11px] text-muted-foreground">
                      <span>{entry.isCollection ? '目录' : formatBytes(entry.size)}</span>
                      <span className="hidden sm:inline font-mono max-w-[140px] truncate" title={entry.etag}>
                        {entry.etag ? `ETag: ${entry.etag}` : ''}
                      </span>
                      <span className="hidden md:inline">{formatDateTime(entry.lastModified)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Encrypted Backup & Restore */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Archive className="h-5 w-5 text-primary" />
                云端 / 存储后端加密备份与一键恢复
              </CardTitle>
              <CardDescription>
                备份文件保存在远端或同步目录 <code>backups/</code> 下，同样使用空间端到端密钥认证加密。
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loadingBackups || status.locked}
                onClick={loadBackups}>
                {loadingBackups ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                刷新列表
              </Button>
              <Button type="button" size="sm" disabled={creatingBackup || status.locked} onClick={handleCreateBackup}>
                {creatingBackup ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <HardDrive className="mr-1.5 h-3.5 w-3.5" />
                )}
                立即创建加密备份
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {backups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
              暂无远端加密备份。点击右上角「立即创建加密备份」生成首份全量备份。
            </div>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border">
              {backups.map(b => {
                const backupId = b.name.replace(/\.enc$/i, '');
                return (
                  <div
                    key={b.path || b.name}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
                    <div className="space-y-0.5 min-w-0">
                      <div className="font-mono font-semibold text-foreground truncate">{b.name}</div>
                      <div className="text-muted-foreground">
                        大小：{formatBytes(b.size)} · 修改时间：{formatDateTime(b.lastModified)}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={status.locked}
                      onClick={() => setRestoreTarget(backupId)}
                      className="h-8 text-xs">
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                      从此备份恢复
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Restore Backup Confirmation Modal */}
      <Dialog open={!!restoreTarget} onOpenChange={open => !open && setRestoreTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认恢复加密备份？</DialogTitle>
            <DialogDescription>
              即将从远端备份 <code className="font-mono text-foreground">{restoreTarget}</code> 恢复当前同步空间的
              Cookies、LocalStorage、轨道与规则状态。恢复操作将生成新的因果版本以同步至其他设备。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={restoringBackup} onClick={() => setRestoreTarget(null)}>
              取消
            </Button>
            <Button type="button" disabled={restoringBackup} onClick={handleRestoreBackup}>
              {restoringBackup ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              确认恢复
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
