import type {
  Device,
  PayloadEncoding,
  PerDeviceSyncPolicy,
  SafetyUndoPoint,
  SpaceAuthorityMode,
  SpaceSettings,
  SyncDirection,
  SyncScopeMode,
  SyncStatusSummary,
  SyncTimingMode,
} from '@sessionmesh/core';
import { unwrapCommand, useTheme } from '@sessionmesh/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@sessionmesh/ui';
import {
  Bell,
  Crown,
  Globe,
  History,
  Laptop,
  Loader2,
  Lock,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { extractErrorMessage, formatDateTime, formatRelativeTime, useUiBannerPrefs } from '../utils/helpers';

const INITIAL_SPACE_SETTINGS: SpaceSettings = {
  autoSync: true,
  direction: 'bidirectional',
  syncCookies: true,
  syncLocalStorage: true,
  checkOnNavigate: true,
  backgroundCheck: true,
  pollingIntervalSec: 60,
  autoRefresh: false,
  refreshProtection: true,
  payloadEncoding: 'json',
  compression: true,
  lowFrequencyMode: false,
  filterAnalyticsNoiseCookies: true,
  sessionLockEnabled: false,
  keepSessionCookiesAlive: false,
  syncScopeMode: 'managed_only',
  syncTimingMode: 'on_page_leave',
  authorityMode: 'ask',
  devicePolicies: {},
};

interface DevicePolicyDraft {
  mode: PerDeviceSyncPolicy['mode'];
  followDeviceId: string;
  direction: SyncDirection;
  excludedSitesText: string;
}

function buildDevicePolicyDraft(policy?: PerDeviceSyncPolicy): DevicePolicyDraft {
  return {
    mode: policy?.mode ?? 'inherit',
    followDeviceId: policy?.followDeviceId ?? '',
    direction: policy?.direction ?? 'inherit',
    excludedSitesText: (policy?.excludedSiteKeys ?? []).join(', '),
  };
}

interface PolicyAdvancedTabProps {
  status: SyncStatusSummary;
  onRefreshStatus: () => Promise<void>;
  onOpenWizard: () => void;
}

export function PolicyAdvancedTab({ status, onRefreshStatus, onOpenWizard }: PolicyAdvancedTabProps) {
  const { theme, setTheme } = useTheme();
  const {
    prefs: bannerPrefs,
    dismissedCount,
    setShowSecurityWarnings,
    setShowDegradedWarnings,
    restoreAllBanners,
  } = useUiBannerPrefs();

  const [settings, setSettings] = useState<SpaceSettings>(INITIAL_SPACE_SETTINGS);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [pollingInput, setPollingInput] = useState('60');

  // Pillar 3: Devices, Authority Policy & Per-Device Policies
  const [devices, setDevices] = useState<Device[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [draftAuthorityMode, setDraftAuthorityMode] = useState<SpaceAuthorityMode>('ask');
  const [draftPrimaryDeviceId, setDraftPrimaryDeviceId] = useState<string>('');
  const [savingAuthority, setSavingAuthority] = useState(false);
  const [deviceDrafts, setDeviceDrafts] = useState<Record<string, DevicePolicyDraft>>({});
  const [savingDeviceId, setSavingDeviceId] = useState<string | null>(null);
  const [removingDeviceId, setRemovingDeviceId] = useState<string | null>(null);

  // Local Safety Undo points
  const [undoPoints, setUndoPoints] = useState<SafetyUndoPoint[]>([]);
  const [loadingUndo, setLoadingUndo] = useState(false);
  const [applyingUndoId, setApplyingUndoId] = useState<string | null>(null);
  const [lockingNow, setLockingNow] = useState(false);

  const syncDraftsFromLoaded = useCallback(
    (loadedSettings: SpaceSettings, loadedDevices: Device[]) => {
      const nextAuthority: SpaceAuthorityMode = loadedSettings.authorityMode ?? 'ask';
      setDraftAuthorityMode(nextAuthority);
      setDraftPrimaryDeviceId(
        loadedSettings.primaryDeviceId || status.device?.deviceId || loadedDevices[0]?.deviceId || '',
      );
      const policies = loadedSettings.devicePolicies ?? {};
      const nextDrafts: Record<string, DevicePolicyDraft> = {};
      for (const dev of loadedDevices) {
        nextDrafts[dev.deviceId] = buildDevicePolicyDraft(policies[dev.deviceId]);
      }
      setDeviceDrafts(nextDrafts);
    },
    [status.device?.deviceId],
  );

  const loadSettingsAndUndo = useCallback(async () => {
    if (!status.configured || status.locked) return;
    setLoadingUndo(true);
    setLoadingDevices(true);
    try {
      const [summaryPayload, points, deviceList] = await Promise.all([
        unwrapCommand<{ settings?: SpaceSettings }>({ type: 'GET_STATUS_SUMMARY' }).catch(() => null),
        unwrapCommand<SafetyUndoPoint[]>({ type: 'GET_UNDO_POINTS' }).catch(() => []),
        unwrapCommand<Device[]>({ type: 'GET_DEVICES' }).catch(() => []),
      ]);
      const safeDevices = Array.isArray(deviceList) ? deviceList : status.device ? [status.device] : [];
      setDevices(safeDevices);
      const nextSettings = summaryPayload?.settings ?? INITIAL_SPACE_SETTINGS;
      if (summaryPayload?.settings) {
        setSettings(summaryPayload.settings);
        setPollingInput(String(summaryPayload.settings.pollingIntervalSec ?? 60));
      }
      syncDraftsFromLoaded(nextSettings, safeDevices);
      setUndoPoints(Array.isArray(points) ? points : []);
    } finally {
      setLoadingUndo(false);
      setLoadingDevices(false);
    }
  }, [status.configured, status.locked, status.device, syncDraftsFromLoaded]);

  useEffect(() => {
    void loadSettingsAndUndo();
  }, [loadSettingsAndUndo, status.activeSpaceId, status.undoPointsCount]);

  const patchSetting = async <K extends keyof SpaceSettings>(key: K, value: SpaceSettings[K], label: string) => {
    setSavingKey(String(key));
    const prev = settings;
    setSettings(curr => ({ ...curr, [key]: value }));
    try {
      const updated = await unwrapCommand<SpaceSettings>({
        type: 'UPDATE_SPACE_SETTINGS',
        settings: { [key]: value },
      });
      if (updated) {
        setSettings(updated);
        setPollingInput(String(updated.pollingIntervalSec ?? 60));
      }
      toast.success(`已更新：${label}`);
      await onRefreshStatus();
    } catch (err) {
      setSettings(prev);
      toast.error(`保存设置失败：${extractErrorMessage(err)}`);
    } finally {
      setSavingKey(null);
    }
  };

  const handleSaveAuthorityPolicy = async () => {
    if (draftAuthorityMode === 'primary_device' && !draftPrimaryDeviceId) {
      toast.warning('请选择一台注册设备作为空间主基准设备');
      return;
    }
    setSavingAuthority(true);
    try {
      const updated = await unwrapCommand<SpaceSettings>({
        type: 'SET_SPACE_AUTHORITY_POLICY',
        authorityMode: draftAuthorityMode,
        primaryDeviceId: draftAuthorityMode === 'primary_device' ? draftPrimaryDeviceId : undefined,
      });
      if (updated) {
        setSettings(updated);
        syncDraftsFromLoaded(updated, devices);
      }
      const modeLabel =
        draftAuthorityMode === 'primary_device'
          ? '统一以指定基准设备为准'
          : draftAuthorityMode === 'latest_wins'
            ? '自动以最新更新为准'
            : '手动询问确认';
      toast.success(`已更新空间基准策略：${modeLabel}`);
      await onRefreshStatus();
    } catch (err) {
      toast.error(`保存空间基准策略失败：${extractErrorMessage(err)}`);
    } finally {
      setSavingAuthority(false);
    }
  };

  const updateDeviceDraft = (deviceId: string, patch: Partial<DevicePolicyDraft>) => {
    setDeviceDrafts(prev => {
      const current = prev[deviceId] ?? buildDevicePolicyDraft(settings.devicePolicies?.[deviceId]);
      return {
        ...prev,
        [deviceId]: { ...current, ...patch },
      };
    });
  };

  const handleSaveDevicePolicy = async (device: Device) => {
    const draft = deviceDrafts[device.deviceId] ?? buildDevicePolicyDraft(settings.devicePolicies?.[device.deviceId]);
    if (draft.mode === 'follow_device' && !draft.followDeviceId) {
      toast.warning('请选择该设备需要跟随的目标设备');
      return;
    }
    const excludedList = Array.from(
      new Set(
        draft.excludedSitesText
          .split(/[,，;\n\s]+/)
          .map(raw => {
            const s = raw.trim().toLowerCase();
            if (!s) return '';
            if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
              try {
                return new URL(s).hostname.toLowerCase();
              } catch {
                return '';
              }
            }
            return s.replace(/^\*\./, '').replace(/^\.+/, '').split('/')[0]?.split(':')[0] || '';
          })
          .filter(Boolean),
      ),
    );
    const policy: PerDeviceSyncPolicy = {
      deviceId: device.deviceId,
      mode: draft.mode,
      followDeviceId: draft.mode === 'follow_device' ? draft.followDeviceId : undefined,
      direction: draft.direction,
      excludedSiteKeys: excludedList.length > 0 ? excludedList : undefined,
      updatedAt: Date.now(),
    };
    setSavingDeviceId(device.deviceId);
    try {
      await unwrapCommand({
        type: 'UPSERT_DEVICE_POLICY',
        policy,
      });
      toast.success(`已保存设备「${device.name}」的独立同步策略`);
      await loadSettingsAndUndo();
      await onRefreshStatus();
    } catch (err) {
      toast.error(`保存设备策略失败：${extractErrorMessage(err)}`);
    } finally {
      setSavingDeviceId(null);
    }
  };

  const handleRemoveDevicePolicy = async (device: Device) => {
    setRemovingDeviceId(device.deviceId);
    try {
      await unwrapCommand({
        type: 'REMOVE_DEVICE_POLICY',
        deviceId: device.deviceId,
      });
      toast.success(`已恢复设备「${device.name}」使用空间默认继承策略`);
      await loadSettingsAndUndo();
      await onRefreshStatus();
    } catch (err) {
      toast.error(`恢复默认策略失败：${extractErrorMessage(err)}`);
    } finally {
      setRemovingDeviceId(null);
    }
  };

  const handleSavePolling = async () => {
    const parsed = Math.max(15, Math.min(3600, Number.parseInt(pollingInput, 10) || 60));
    setPollingInput(String(parsed));
    await patchSetting('pollingIntervalSec', parsed, `后台检查间隔 ${parsed} 秒`);
  };

  const handleApplyUndo = async (point: SafetyUndoPoint) => {
    setApplyingUndoId(point.undoId);
    try {
      await unwrapCommand({ type: 'APPLY_UNDO_POINT', undoId: point.undoId });
      toast.success(`已为 ${point.siteKey} 撤销覆盖并恢复本地原登录态`);
      await loadSettingsAndUndo();
      await onRefreshStatus();
    } catch (err) {
      toast.error(`撤销恢复失败：${extractErrorMessage(err)}`);
    } finally {
      setApplyingUndoId(null);
    }
  };

  const handleLockNow = async () => {
    setLockingNow(true);
    try {
      await unwrapCommand({ type: 'LOCK_SESSION' });
      toast.success('已锁定同步引擎，需重新输入端到端主密码解锁');
      await onRefreshStatus();
    } catch (err) {
      toast.error(`锁定失败：${extractErrorMessage(err)}`);
    } finally {
      setLockingNow(false);
    }
  };

  const effectiveSyncScopeMode: SyncScopeMode = settings.syncScopeMode ?? 'managed_only';
  const effectiveDevices = devices.length > 0 ? devices : status.device ? [status.device] : [];

  return (
    <div className="space-y-5">
      {/* Pillar 3 & Pillar 1: Unified Authority Device, Per-Device Policies & Managed Scope */}
      <Card className="border-primary/35">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Crown className="h-5 w-5 text-amber-500" />
                主基准设备与单设备独立策略管理
              </CardTitle>
              <CardDescription>
                统一控制网站纳管模式、空间主基准设备（冲突自动以主设备为准）以及单台设备的独立角色/只读跟随/专属排除策略。
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loadingDevices || status.locked}
              onClick={loadSettingsAndUndo}>
              {loadingDevices ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              刷新设备与策略
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* 3. Managed Sites Scope Mode Switcher */}
          <div className="space-y-2.5 rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Globe className="h-4 w-4 text-primary" />
                网站纳管模式切换
              </div>
              <Badge variant={effectiveSyncScopeMode === 'managed_only' ? 'success' : 'secondary'}>
                {effectiveSyncScopeMode === 'managed_only' ? '仅同步已纳入管理的网站' : '全站自动纳管'}
              </Badge>
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <button
                type="button"
                disabled={savingKey === 'syncScopeMode' || status.locked}
                onClick={() =>
                  void patchSetting('syncScopeMode', 'managed_only', '仅同步已纳入管理的网站 (managed_only)')
                }
                className={`rounded-xl border p-3 text-left transition-all ${
                  effectiveSyncScopeMode === 'managed_only'
                    ? 'border-primary bg-primary/8 ring-1 ring-primary/40'
                    : 'border-border bg-background hover:border-primary/40'
                }`}>
                <div className="flex items-center justify-between gap-2 text-xs font-semibold text-foreground">
                  <span>仅同步已纳入管理的网站 (managed_only)</span>
                  <Badge variant="success" className="text-[10px]">
                    推荐
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  仅同步用户主动添加或云端已建轨的站点，不采集无关日常网页。
                </p>
              </button>

              <button
                type="button"
                disabled={savingKey === 'syncScopeMode' || status.locked}
                onClick={() => void patchSetting('syncScopeMode', 'all_sites', '全站自动纳管 (all_sites)')}
                className={`rounded-xl border p-3 text-left transition-all ${
                  effectiveSyncScopeMode === 'all_sites'
                    ? 'border-primary bg-primary/8 ring-1 ring-primary/40'
                    : 'border-border bg-background hover:border-primary/40'
                }`}>
                <div className="text-xs font-semibold text-foreground">全站自动纳管 (all_sites)</div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  自动纳管并同步浏览器中除黑名单外的所有站点 Cookie 与 LocalStorage。
                </p>
              </button>
            </div>
          </div>

          {/* 1. Space Unified Authority Policy */}
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-foreground">
                  空间统一基准策略（多设备冲突与重叠时以谁为准）
                </div>
                <p className="text-xs text-muted-foreground">
                  对空间内所有采用「跟随空间默认」的设备生效，减少重复确认弹窗。
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={savingAuthority || status.locked}
                onClick={handleSaveAuthorityPolicy}>
                {savingAuthority ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                )}
                保存基准策略
              </Button>
            </div>

            <div className="grid gap-2.5 md:grid-cols-3">
              <div
                className={`flex items-start gap-2.5 rounded-xl border p-3 text-xs transition-colors ${
                  draftAuthorityMode === 'ask'
                    ? 'border-primary bg-primary/8 ring-1 ring-primary/35'
                    : 'border-border bg-background hover:border-primary/40'
                }`}>
                <input
                  id="space-authority-ask"
                  type="radio"
                  name="space-authority-mode"
                  value="ask"
                  checked={draftAuthorityMode === 'ask'}
                  onChange={() => setDraftAuthorityMode('ask')}
                  className="mt-0.5 cursor-pointer accent-primary"
                />
                <label htmlFor="space-authority-ask" className="block flex-1 cursor-pointer space-y-1">
                  <span className="block font-semibold text-foreground">手动询问确认 (ask)</span>
                  <span className="block text-[11px] text-muted-foreground">
                    双端重叠或多轨道时暂不自动覆盖，交由用户逐项确认。
                  </span>
                </label>
              </div>

              <div
                className={`flex items-start gap-2.5 rounded-xl border p-3 text-xs transition-colors ${
                  draftAuthorityMode === 'primary_device'
                    ? 'border-primary bg-primary/8 ring-1 ring-primary/35'
                    : 'border-border bg-background hover:border-primary/40'
                }`}>
                <input
                  id="space-authority-primary"
                  type="radio"
                  name="space-authority-mode"
                  value="primary_device"
                  checked={draftAuthorityMode === 'primary_device'}
                  onChange={() => {
                    setDraftAuthorityMode('primary_device');
                    if (!draftPrimaryDeviceId && effectiveDevices[0]) {
                      setDraftPrimaryDeviceId(status.device?.deviceId || effectiveDevices[0].deviceId);
                    }
                  }}
                  className="mt-0.5 cursor-pointer accent-primary"
                />
                <label htmlFor="space-authority-primary" className="block flex-1 cursor-pointer space-y-1">
                  <span className="block font-semibold text-foreground">统一以指定基准设备为准 (primary_device)</span>
                  <span className="block text-[11px] text-muted-foreground">
                    指定一台主力电脑为主基准，其他跟随设备冲突时自动以该设备为准。
                  </span>
                </label>
              </div>

              <div
                className={`flex items-start gap-2.5 rounded-xl border p-3 text-xs transition-colors ${
                  draftAuthorityMode === 'latest_wins'
                    ? 'border-primary bg-primary/8 ring-1 ring-primary/35'
                    : 'border-border bg-background hover:border-primary/40'
                }`}>
                <input
                  id="space-authority-latest"
                  type="radio"
                  name="space-authority-mode"
                  value="latest_wins"
                  checked={draftAuthorityMode === 'latest_wins'}
                  onChange={() => setDraftAuthorityMode('latest_wins')}
                  className="mt-0.5 cursor-pointer accent-primary"
                />
                <label htmlFor="space-authority-latest" className="block flex-1 cursor-pointer space-y-1">
                  <span className="block font-semibold text-foreground">自动以最新更新为准 (latest_wins)</span>
                  <span className="block text-[11px] text-muted-foreground">
                    遇到多轨道或重叠站点时自动采用云端最近更新的轨道版本。
                  </span>
                </label>
              </div>
            </div>

            {draftAuthorityMode === 'primary_device' ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3">
                <Label className="text-xs font-semibold text-amber-900 dark:text-amber-200 shrink-0">
                  指定空间主基准设备：
                </Label>
                <Select
                  value={draftPrimaryDeviceId}
                  disabled={status.locked || effectiveDevices.length === 0}
                  onValueChange={setDraftPrimaryDeviceId}>
                  <SelectTrigger className="h-9 flex-1 min-w-[220px] bg-background text-xs">
                    <SelectValue placeholder="请选择一台已注册设备" />
                  </SelectTrigger>
                  <SelectContent>
                    {effectiveDevices.map(dev => (
                      <SelectItem key={dev.deviceId} value={dev.deviceId}>
                        {dev.name}
                        {dev.deviceId === status.device?.deviceId ? '（本机）' : ''} · {dev.browser} / {dev.platform}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          {/* 2. Per-Device Independent Policy Overrides */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Laptop className="h-4 w-4 text-primary" />
                  独立设备单独配置（{effectiveDevices.length} 台设备）
                </div>
                <p className="text-xs text-muted-foreground">
                  可为任意单台设备设置独立角色（如独立账号轨道、指定跟随某台设备）、同步方向（如只读跟随{' '}
                  <code>pull_only</code>）以及设备专属排除站点。
                </p>
              </div>
            </div>

            {effectiveDevices.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
                暂无已注册设备记录。
              </div>
            ) : (
              <div className="space-y-3">
                {effectiveDevices.map(device => {
                  const isCurrent = device.deviceId === status.device?.deviceId;
                  const isPrimary =
                    settings.authorityMode === 'primary_device' && settings.primaryDeviceId === device.deviceId;
                  const existingPolicy = settings.devicePolicies?.[device.deviceId];
                  const draft = deviceDrafts[device.deviceId] ?? buildDevicePolicyDraft(existingPolicy);
                  const otherDevices = effectiveDevices.filter(d => d.deviceId !== device.deviceId);
                  const isSavingThis = savingDeviceId === device.deviceId;
                  const isRemovingThis = removingDeviceId === device.deviceId;

                  return (
                    <div key={device.deviceId} className="rounded-xl border border-border bg-background p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">{device.name}</span>
                          {isCurrent ? (
                            <Badge variant="default" className="text-[10px]">
                              本机
                            </Badge>
                          ) : null}
                          {isPrimary ? (
                            <Badge variant="warning" className="text-[10px]">
                              <Crown className="mr-1 h-3 w-3" />
                              主基准设备
                            </Badge>
                          ) : null}
                          {existingPolicy ? (
                            <Badge variant="info" className="text-[10px]">
                              已配置独立策略
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">
                              跟随空间默认
                            </Badge>
                          )}
                          <span className="text-[11px] text-muted-foreground">
                            {device.browser} · {device.platform} · 最近活跃 {formatRelativeTime(device.lastSeenAt)}
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          {existingPolicy ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={isRemovingThis || isSavingThis || status.locked}
                              onClick={() => void handleRemoveDevicePolicy(device)}
                              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive">
                              {isRemovingThis ? (
                                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                              ) : (
                                <RotateCcw className="mr-1 h-3 w-3" />
                              )}
                              恢复默认继承
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={isSavingThis || isRemovingThis || status.locked}
                            onClick={() => void handleSaveDevicePolicy(device)}
                            className="h-7 px-2.5 text-xs">
                            {isSavingThis ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <Save className="mr-1 h-3 w-3" />
                            )}
                            保存设备策略
                          </Button>
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-12">
                        <div className="space-y-1 md:col-span-4">
                          <Label className="text-[11px] text-muted-foreground">角色模式</Label>
                          <Select
                            value={draft.mode}
                            disabled={status.locked}
                            onValueChange={val =>
                              updateDeviceDraft(device.deviceId, {
                                mode: val as PerDeviceSyncPolicy['mode'],
                                followDeviceId:
                                  val === 'follow_device'
                                    ? draft.followDeviceId || otherDevices[0]?.deviceId || ''
                                    : '',
                              })
                            }>
                            <SelectTrigger className="h-9 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="inherit">跟随空间默认 (inherit)</SelectItem>
                              <SelectItem value="independent_tracks">
                                独立维护自身账号轨道 (independent_tracks)
                              </SelectItem>
                              <SelectItem value="follow_device">指定跟随特定设备 (follow_device)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1 md:col-span-4">
                          <Label className="text-[11px] text-muted-foreground">同步方向限制</Label>
                          <Select
                            value={draft.direction}
                            disabled={status.locked}
                            onValueChange={val =>
                              updateDeviceDraft(device.deviceId, { direction: val as SyncDirection })
                            }>
                            <SelectTrigger className="h-9 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="inherit">继承默认 (inherit)</SelectItem>
                              <SelectItem value="bidirectional">双向同步 (bidirectional)</SelectItem>
                              <SelectItem value="pull_only">仅拉取（只读跟随，不上传本机改动 pull_only）</SelectItem>
                              <SelectItem value="push_only">仅上传 (push_only)</SelectItem>
                              <SelectItem value="disabled">停用此设备同步 (disabled)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1 md:col-span-4">
                          <Label className="text-[11px] text-muted-foreground">
                            设备专属排除网站（逗号分隔 siteKey）
                          </Label>
                          <Input
                            value={draft.excludedSitesText}
                            disabled={status.locked}
                            onChange={e => updateDeviceDraft(device.deviceId, { excludedSitesText: e.target.value })}
                            placeholder="例如 mail.google.com, work.example.com"
                            className="h-9 text-xs"
                          />
                        </div>

                        {draft.mode === 'follow_device' ? (
                          <div className="space-y-1 md:col-span-12">
                            <Label className="text-[11px] text-muted-foreground">选择要跟随的目标设备</Label>
                            <Select
                              value={draft.followDeviceId}
                              disabled={status.locked || otherDevices.length === 0}
                              onValueChange={val => updateDeviceDraft(device.deviceId, { followDeviceId: val })}>
                              <SelectTrigger className="h-9 text-xs max-w-md">
                                <SelectValue
                                  placeholder={otherDevices.length === 0 ? '空间内暂无其他可选设备' : '选择目标设备'}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {otherDevices.map(target => (
                                  <SelectItem key={target.deviceId} value={target.deviceId}>
                                    {target.name} ({target.browser} / {target.platform})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Core Sync Policy */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings2 className="h-5 w-5 text-primary" />
            全局同步策略与性能控制
          </CardTitle>
          <CardDescription>
            所有写入 WebDAV 的文件始终强制使用 SMES v2 (AES-256-GCM) 端到端加密，无法关闭加密。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="divide-y divide-border rounded-xl border border-border">
            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  全局自动同步（Auto Sync）
                  {status.status === 'PAUSED' ? (
                    <Badge variant="secondary" className="text-[10px]">
                      本机已临时暂停
                    </Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">关闭后仅在点击手动同步时上传或拉取</p>
              </div>
              <Switch
                checked={settings.autoSync && status.status !== 'PAUSED'}
                disabled={savingKey === 'autoSync' || status.locked}
                onCheckedChange={async v => {
                  if (v && status.status === 'PAUSED') {
                    await unwrapCommand({ type: 'SET_GLOBAL_PAUSED', paused: false }).catch(() => undefined);
                  }
                  await patchSetting('autoSync', v, v ? '开启全局自动同步' : '暂停全局自动同步');
                }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  自动上传时机
                  <Badge variant="info" className="text-[10px]">
                    防频繁请求 / 防互刷
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  「关闭/离开页面时」会在浏览期间静默合并本地变更，关闭标签页或跳离网站时一次性上传，大幅减少网盘请求并避免双端互刷
                </p>
              </div>
              <Select
                value={settings.syncTimingMode ?? 'on_page_leave'}
                disabled={!settings.autoSync || savingKey === 'syncTimingMode' || status.locked}
                onValueChange={v => patchSetting('syncTimingMode', v as SyncTimingMode, '自动上传时机')}>
                <SelectTrigger className="w-60 h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="on_page_leave">关闭 / 离开页面时上传（推荐）</SelectItem>
                  <SelectItem value="realtime">网页变动实时上传</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">默认同步方向</div>
                <p className="text-xs text-muted-foreground">未单独设置覆盖规则的网站均遵循此方向</p>
              </div>
              <Select
                value={settings.direction}
                disabled={savingKey === 'direction' || status.locked}
                onValueChange={v => patchSetting('direction', v as SyncDirection, '默认同步方向')}>
                <SelectTrigger className="w-44 h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bidirectional">双向同步</SelectItem>
                  <SelectItem value="push_only">仅上传（本机 -&gt; 云端）</SelectItem>
                  <SelectItem value="pull_only">仅拉取（云端 -&gt; 本机）</SelectItem>
                  <SelectItem value="disabled">全局禁用</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">同步 Cookies</div>
                <p className="text-xs text-muted-foreground">
                  支持完整属性（HttpOnly / Secure / SameSite / PartitionKey / HostOnly）与回读校验
                </p>
              </div>
              <Switch
                checked={settings.syncCookies}
                disabled={savingKey === 'syncCookies' || status.locked}
                onCheckedChange={v => patchSetting('syncCookies', v, 'Cookie 同步开关')}
              />
            </div>

            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">同步 LocalStorage</div>
                <p className="text-xs text-muted-foreground">
                  严格按 Origin 隔离同步，未打开站点自动缓存待上下文就绪后写入
                </p>
              </div>
              <Switch
                checked={settings.syncLocalStorage}
                disabled={savingKey === 'syncLocalStorage' || status.locked}
                onCheckedChange={v => patchSetting('syncLocalStorage', v, 'LocalStorage 同步开关')}
              />
            </div>

            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">过滤分析类噪声 Cookie</div>
                <p className="text-xs text-muted-foreground">
                  自动忽略 <code>_ga</code>、<code>_gid</code>、<code>_fbp</code>、<code>Hm_lvt_*</code> 等高频追踪
                  Cookie，大幅降低流量与冲突
                </p>
              </div>
              <Switch
                checked={settings.filterAnalyticsNoiseCookies}
                disabled={savingKey === 'filterAnalyticsNoiseCookies' || status.locked}
                onCheckedChange={v => patchSetting('filterAnalyticsNoiseCookies', v, '分析噪声 Cookie 过滤')}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">后台定时轮询间隔（秒）</div>
                <p className="text-xs text-muted-foreground">
                  基于 <code>chrome.alarms</code> 唤醒，先比对 <code>devices/</code> ETag，无变化零额外下载（建议 60~300
                  秒）
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={15}
                  max={3600}
                  value={pollingInput}
                  onChange={e => setPollingInput(e.target.value)}
                  className="h-9 w-24 text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={savingKey === 'pollingIntervalSec' || status.locked}
                  onClick={handleSavePolling}>
                  保存
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  坚果云低频省流模式
                  <Badge variant="info" className="text-[10px]">
                    防 429 限流
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  拉长防抖合并窗口并降低后台探测频率，显著减少 WebDAV 请求次数
                </p>
              </div>
              <Switch
                checked={settings.lowFrequencyMode}
                disabled={savingKey === 'lowFrequencyMode' || status.locked}
                onCheckedChange={v => patchSetting('lowFrequencyMode', v, '坚果云低频省流模式')}
              />
            </div>

            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">打开网站时按需检查同步</div>
                <p className="text-xs text-muted-foreground">访问已绑定站点时立即检查云端是否有更新版本</p>
              </div>
              <Switch
                checked={settings.checkOnNavigate}
                disabled={savingKey === 'checkOnNavigate' || status.locked}
                onCheckedChange={v => patchSetting('checkOnNavigate', v, '访问时按需检查')}
              />
            </div>

            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">手动同步后自动刷新网页</div>
                <p className="text-xs text-muted-foreground">
                  默认关闭，后台拉取静默写入 Cookie/LS 绝不打断正在浏览的网页；开启后仅在手动同步或切换轨道且 Cookie
                  变化时生效（配合表单与浏览保护）
                </p>
              </div>
              <div className="flex items-center gap-4">
                <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Label htmlFor="policy-refresh-protection" className="text-xs font-normal text-muted-foreground">
                    表单保护
                  </Label>
                  <Switch
                    id="policy-refresh-protection"
                    checked={settings.refreshProtection}
                    disabled={!settings.autoRefresh || savingKey === 'refreshProtection' || status.locked}
                    onCheckedChange={v => patchSetting('refreshProtection', v, '未保存表单保护')}
                  />
                </div>
                <Switch
                  checked={settings.autoRefresh}
                  disabled={savingKey === 'autoRefresh' || status.locked}
                  onCheckedChange={v => patchSetting('autoRefresh', v, '网页自动刷新')}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">内部载荷编码与 Gzip 压缩（均强制 AES-256-GCM 加密）</div>
                <p className="text-xs text-muted-foreground">编码与压缩完全独立于加密层，切换不影响端到端加密安全性</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Label htmlFor="policy-gzip-compression" className="text-xs font-normal text-muted-foreground">
                    Gzip
                  </Label>
                  <Switch
                    id="policy-gzip-compression"
                    checked={settings.compression}
                    disabled={savingKey === 'compression' || status.locked}
                    onCheckedChange={v => patchSetting('compression', v, 'Gzip 压缩')}
                  />
                </div>
                <Select
                  value={settings.payloadEncoding}
                  disabled={savingKey === 'payloadEncoding' || status.locked}
                  onValueChange={v => patchSetting('payloadEncoding', v as PayloadEncoding, '载荷编码格式')}>
                  <SelectTrigger className="w-32 h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="json">JSON</SelectItem>
                    <SelectItem value="protobuf">Protobuf</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Security & Session Lock */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-5 w-5 text-emerald-600" />
            密钥安全与主密码锁
          </CardTitle>
          <CardDescription>
            磁盘绝不落盘用户明文密码；空间 DEK 由本机不可导出（non-extractable）WebCrypto 密钥保护。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-4">
            <div>
              <div className="text-sm font-medium">浏览器重启主密码锁（高安全模式）</div>
              <p className="text-xs text-muted-foreground">
                开启后每次关闭并重启浏览器都需要重新输入端到端主密码，防止他人使用你的电脑解锁同步
              </p>
            </div>
            <Switch
              checked={settings.sessionLockEnabled}
              disabled={savingKey === 'sessionLockEnabled' || status.locked}
              onCheckedChange={v => patchSetting('sessionLockEnabled', v, '浏览器重启主密码锁')}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 px-4 py-3">
            <span className="text-xs text-muted-foreground">需要临时离开电脑时，可立即锁定当前同步会话。</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={lockingNow || status.locked}
              onClick={handleLockNow}>
              {lockingNow ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Lock className="mr-1.5 h-3.5 w-3.5" />
              )}
              立即锁定会话
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Local Safety Undo Points */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-5 w-5 text-primary" />
                本地安全还原点（覆盖前自动后悔药）
              </CardTitle>
              <CardDescription>
                在执行「用云端覆盖本机」「切换轨道」「批量决策」前自动保存最近 20 份本地快照，支持一键无损撤销。
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loadingUndo || status.locked}
              onClick={loadSettingsAndUndo}>
              {loadingUndo ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              刷新还原点
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {undoPoints.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
              暂无本地安全还原点。当发生远端覆盖或轨道切换操作时，系统会自动在此为您备份原登录态。
            </div>
          ) : (
            <div className="divide-y divide-border rounded-xl border border-border">
              {undoPoints.map(point => (
                <div key={point.undoId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-sm text-foreground">{point.siteKey}</span>
                      <Badge variant="outline">{point.cookies.length} 条 Cookie</Badge>
                      <Badge variant="secondary">
                        {Object.keys(point.localStorageByOrigin || {}).length} 个 Origin LS
                      </Badge>
                    </div>
                    <div className="text-muted-foreground">
                      原因：{point.reason} · 创建于 {formatRelativeTime(point.createdAt)}（
                      {formatDateTime(point.createdAt)}）
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={applyingUndoId === point.undoId || status.locked}
                    onClick={() => handleApplyUndo(point)}>
                    {applyingUndoId === point.undoId ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    撤销覆盖恢复
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pillar 4: Warning & Notification Banner Display Preferences */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-5 w-5 text-primary" />
            警告与通知显示设置
          </CardTitle>
          <CardDescription>
            控制所有控制中心、弹窗与侧边栏中的风险警告、WebDAV 降级提示及已关闭横幅的显示行为（即时同步生效）。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="divide-y divide-border rounded-xl border border-border">
            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">显示安全与权限风险提示</div>
                <p className="text-xs text-muted-foreground">
                  显示凭据同步安全须知、密码复用提醒与共享 WebDAV 凭据权限提示
                </p>
              </div>
              <Switch
                checked={bannerPrefs.showSecurityWarnings}
                onCheckedChange={v => {
                  void setShowSecurityWarnings(v);
                  toast.success(v ? '已开启安全与权限风险提示' : '已关闭安全与权限风险提示');
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">显示 WebDAV 兼容降级提示</div>
                <p className="text-xs text-muted-foreground">
                  当 WebDAV 服务器运行在单写者追加兼容模式或触发滚动令牌阻尼保护时显示提醒横幅
                </p>
              </div>
              <Switch
                checked={bannerPrefs.showDegradedWarnings}
                onCheckedChange={v => {
                  void setShowDegradedWarnings(v);
                  toast.success(v ? '已开启 WebDAV 兼容降级提示' : '已关闭 WebDAV 兼容降级提示');
                }}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 px-4 py-3">
            <span className="text-xs text-muted-foreground">
              {dismissedCount > 0
                ? `您已手动关闭 ${dismissedCount} 条不再提示的警告横幅。`
                : '当前没有被手动关闭的警告横幅。'}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                await restoreAllBanners();
                toast.success('已恢复所有已关闭的提示横幅');
              }}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              恢复所有已关闭的提示横幅
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Appearance & Onboarding Wizard */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette className="h-5 w-5 text-primary" />
            外观主题与配置向导
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={theme === 'light' ? 'default' : 'outline'}
              onClick={() => setTheme('light')}>
              <Sun className="mr-1.5 h-4 w-4" />
              浅色模式
            </Button>
            <Button
              type="button"
              size="sm"
              variant={theme === 'dark' ? 'default' : 'outline'}
              onClick={() => setTheme('dark')}>
              <Moon className="mr-1.5 h-4 w-4" />
              深色模式
            </Button>
            <Button
              type="button"
              size="sm"
              variant={theme === 'system' ? 'default' : 'outline'}
              onClick={() => setTheme('system')}>
              <Monitor className="mr-1.5 h-4 w-4" />
              跟随系统
            </Button>
          </div>

          <Button type="button" variant="secondary" size="sm" onClick={onOpenWizard}>
            <Sparkles className="mr-1.5 h-4 w-4" />
            重新打开 4 步配置向导
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
