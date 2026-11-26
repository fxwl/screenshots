import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import { useBannerPrefs } from '@console/lib/bannerPrefs';
import {
  copyToClipboard,
  formatDateTime,
  formatRelativeTime,
  getAuthorityModeLabel,
  getDeviceStateMeta,
  shortId,
} from '@console/lib/format';
import type { Device, PerDeviceSyncPolicy, SpaceAuthorityMode, SpaceSettings } from '@sessionmesh/shared';
import { Button, Input, Label } from '@sessionmesh/ui';
import {
  Check,
  Copy,
  Crown,
  Edit2,
  Laptop,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Sliders,
  Trash2,
  X,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from './common/Badge';
import { EmptyState } from './common/EmptyState';
import { Modal } from './common/Modal';
import { DevicePolicyModal } from './DevicePolicyModal';

export interface DevicesTabProps {
  currentDeviceId?: string;
  globalSearch: string;
  onStatusChanged: () => Promise<void> | void;
  refreshSignal: number;
  layout?: 'compact' | 'wide';
}

export const DevicesTab: React.FC<DevicesTabProps> = ({
  currentDeviceId,
  globalSearch,
  onStatusChanged,
  refreshSignal,
  layout = 'compact',
}) => {
  const [devices, setDevices] = useState<Device[]>([]);
  const [settings, setSettings] = useState<SpaceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Device | null>(null);
  const [policyModalDevice, setPolicyModalDevice] = useState<Device | null>(null);

  // Authority policy draft controls
  const [authorityMode, setAuthorityMode] = useState<SpaceAuthorityMode>('ask');
  const [primaryDeviceId, setPrimaryDeviceId] = useState<string>('');
  const [savingAuthority, setSavingAuthority] = useState(false);

  const { isBannerVisible, dismissBanner } = useBannerPrefs();

  const loadDevices = useCallback(async () => {
    setLoading(true);
    try {
      const [list, summaryRes] = await Promise.all([
        sidePanelApi.getDevices(),
        sidePanelApi.getStatusSummaryWithSettings().catch(() => null),
      ]);
      const safeDevices = list || [];
      setDevices(safeDevices);
      const nextSettings = summaryRes?.settings ?? null;
      setSettings(nextSettings);

      const nextMode: SpaceAuthorityMode = nextSettings?.authorityMode ?? 'ask';
      const fallbackPrimary =
        nextSettings?.primaryDeviceId ||
        currentDeviceId ||
        safeDevices.find(d => d.state === 'active')?.deviceId ||
        safeDevices[0]?.deviceId ||
        '';
      setAuthorityMode(nextMode);
      setPrimaryDeviceId(fallbackPrimary);
    } catch (err) {
      toast.error(`加载设备列表失败：${extractErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, [currentDeviceId]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices, refreshSignal]);

  const selectablePrimaryDevices = useMemo(
    () => devices.filter(d => d.state !== 'removed' && d.state !== 'revoked'),
    [devices],
  );

  const deviceNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of devices) {
      map.set(d.deviceId, d.name);
    }
    return map;
  }, [devices]);

  const authorityDirty =
    authorityMode !== (settings?.authorityMode ?? 'ask') ||
    (authorityMode === 'primary_device' && primaryDeviceId !== (settings?.primaryDeviceId ?? ''));

  const handleSaveAuthorityPolicy = async () => {
    if (authorityMode === 'primary_device' && !primaryDeviceId) {
      toast.warning('请先选择一台设备作为空间主基准设备');
      return;
    }
    setSavingAuthority(true);
    try {
      const updated = await sidePanelApi.setSpaceAuthorityPolicy(
        authorityMode,
        authorityMode === 'primary_device' ? primaryDeviceId : undefined,
      );
      setSettings(updated);
      const primaryName = primaryDeviceId ? deviceNameMap.get(primaryDeviceId) || shortId(primaryDeviceId, 10) : '';
      toast.success(
        authorityMode === 'primary_device'
          ? `已保存基准策略：统一以「${primaryName}」为主基准设备`
          : `已保存基准策略：${getAuthorityModeLabel(authorityMode)}`,
      );
      await loadDevices();
      await onStatusChanged();
    } catch (err) {
      toast.error(`保存基准策略失败：${extractErrorMessage(err)}`);
    } finally {
      setSavingAuthority(false);
    }
  };

  const handleQuickSetPrimary = async (dev: Device) => {
    setBusyKey(`primary:${dev.deviceId}`);
    try {
      const updated = await sidePanelApi.setSpaceAuthorityPolicy('primary_device', dev.deviceId);
      setSettings(updated);
      setAuthorityMode('primary_device');
      setPrimaryDeviceId(dev.deviceId);
      toast.success(`已将「${dev.name}」设为空间主基准设备`);
      await loadDevices();
      await onStatusChanged();
    } catch (err) {
      toast.error(`设置主基准设备失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleSaveDevicePolicy = async (policy: PerDeviceSyncPolicy) => {
    await sidePanelApi.upsertDevicePolicy(policy);
    const devName = deviceNameMap.get(policy.deviceId) || shortId(policy.deviceId, 10);
    toast.success(`已保存「${devName}」的独立同步策略`);
    await loadDevices();
    await onStatusChanged();
  };

  const handleRemoveDevicePolicy = async (deviceId: string) => {
    await sidePanelApi.removeDevicePolicy(deviceId);
    const devName = deviceNameMap.get(deviceId) || shortId(deviceId, 10);
    toast.success(`已将「${devName}」恢复为跟随空间默认策略`);
    await loadDevices();
    await onStatusChanged();
  };

  const handleSaveRename = async (deviceId: string) => {
    const trimmed = editingName.trim();
    if (!trimmed) {
      toast.warning('设备名称不能为空');
      return;
    }
    setBusyKey(`rename:${deviceId}`);
    try {
      await sidePanelApi.renameDevice(deviceId, trimmed);
      toast.success('设备名称已更新');
      setEditingId(null);
      await loadDevices();
      await onStatusChanged();
    } catch (err) {
      toast.error(`重命名失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleSetState = async (device: Device, state: 'active' | 'paused' | 'removed' | 'revoked') => {
    setBusyKey(`state:${device.deviceId}`);
    try {
      await sidePanelApi.setDeviceState(device.deviceId, state);
      const label =
        state === 'active'
          ? '已恢复活跃同步'
          : state === 'paused'
            ? '已暂停该设备'
            : state === 'removed'
              ? '已逻辑移除该设备'
              : '已吊销该设备';
      toast.success(`${device.name}：${label}`);
      setRemoveTarget(null);
      await loadDevices();
      await onStatusChanged();
    } catch (err) {
      toast.error(`修改设备状态失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const query = globalSearch.trim().toLowerCase();
  const filteredDevices = devices
    .filter(d => {
      if (!query) return true;
      return (
        d.name.toLowerCase().includes(query) ||
        d.deviceId.toLowerCase().includes(query) ||
        d.browser.toLowerCase().includes(query) ||
        d.platform.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      if (a.deviceId === currentDeviceId) return -1;
      if (b.deviceId === currentDeviceId) return 1;
      return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
    });

  const renderPolicyBadges = (policy?: PerDeviceSyncPolicy) => {
    if (!policy) return null;
    const badges: React.ReactNode[] = [];

    if (policy.mode === 'independent_tracks') {
      badges.push(
        <StatusBadge key="mode-indep" tone="info">
          独立轨道模式
        </StatusBadge>,
      );
    } else if (policy.mode === 'follow_device') {
      const targetName = policy.followDeviceId
        ? deviceNameMap.get(policy.followDeviceId) || shortId(policy.followDeviceId, 10)
        : '未指定';
      badges.push(
        <StatusBadge key="mode-follow" tone="primary">
          跟随设备：{targetName}
        </StatusBadge>,
      );
    }

    if (policy.direction === 'pull_only') {
      badges.push(
        <StatusBadge key="dir-pull" tone="warning">
          只读跟随 pull_only
        </StatusBadge>,
      );
    } else if (policy.direction === 'push_only') {
      badges.push(
        <StatusBadge key="dir-push" tone="info">
          仅上传 push_only
        </StatusBadge>,
      );
    } else if (policy.direction === 'disabled') {
      badges.push(
        <StatusBadge key="dir-disabled" tone="danger">
          停用同步 disabled
        </StatusBadge>,
      );
    } else if (policy.direction === 'bidirectional') {
      badges.push(
        <StatusBadge key="dir-bi" tone="success">
          强制双向同步
        </StatusBadge>,
      );
    }

    const excludedCount = policy.excludedSiteKeys?.length ?? 0;
    if (excludedCount > 0) {
      badges.push(
        <StatusBadge key="excluded" tone="neutral" className="cursor-help">
          <span title={policy.excludedSiteKeys?.join(', ')}>排除 {excludedCount} 站</span>
        </StatusBadge>,
      );
    }

    if (badges.length === 0) return null;
    return (
      <div className="flex flex-wrap items-center gap-1 pt-0.5">
        <span className="text-[10px] font-medium text-muted-foreground">独立策略：</span>
        {badges}
      </div>
    );
  };

  return (
    <div className={layout === 'wide' ? 'space-y-4' : 'flex h-full flex-col overflow-y-auto p-3 space-y-3'}>
      {/* Unified Space Authority Policy Card */}
      <section className="rounded-xl border border-primary/30 bg-card p-3 text-xs space-y-2.5 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 min-w-0">
            <Crown className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div className="min-w-0">
              <h3 className="font-semibold text-foreground">多设备同步基准策略（以哪台设备为准）</h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
                配置多台设备同时存在登录态或发生并发冲突时的默认裁决基准；单个设备还可在下方配置独立覆盖策略。
              </p>
            </div>
          </div>
          {authorityDirty ? <StatusBadge tone="warning">未保存</StatusBadge> : null}
        </div>

        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="space-authority-mode" className="text-[11px] text-muted-foreground">
              空间统一基准模式
            </Label>
            <select
              id="space-authority-mode"
              aria-label="空间统一基准模式"
              value={authorityMode}
              onChange={e => {
                const next = e.target.value as SpaceAuthorityMode;
                setAuthorityMode(next);
                if (next === 'primary_device' && !primaryDeviceId) {
                  setPrimaryDeviceId(
                    currentDeviceId || selectablePrimaryDevices[0]?.deviceId || devices[0]?.deviceId || '',
                  );
                }
              }}
              className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground">
              <option value="ask">手动询问确认 (ask)</option>
              <option value="primary_device">统一指定主基准设备 (primary_device)</option>
              <option value="latest_wins">以最新更新为准 (latest_wins)</option>
            </select>
          </div>

          {authorityMode === 'primary_device' ? (
            <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-2.5">
              <Label htmlFor="space-primary-device" className="text-[11px] font-medium text-foreground">
                指定空间主基准设备
              </Label>
              <select
                id="space-primary-device"
                aria-label="指定空间主基准设备"
                value={primaryDeviceId}
                onChange={e => setPrimaryDeviceId(e.target.value)}
                className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground">
                {selectablePrimaryDevices.length === 0 ? (
                  <option value="">暂无可选活跃设备</option>
                ) : (
                  selectablePrimaryDevices.map(dev => (
                    <option key={dev.deviceId} value={dev.deviceId}>
                      {dev.name}
                      {dev.deviceId === currentDeviceId ? ' (当前本机)' : ''} · {dev.browser}/{dev.platform}
                    </option>
                  ))
                )}
              </select>
              <p className="text-[10px] text-muted-foreground">
                其余未配置独立策略的设备遇到重名站点或并发冲突时，将自动采用主基准设备的登录态，免去反复弹窗确认。
              </p>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2 pt-0.5">
            <span className="text-[11px] text-muted-foreground truncate">
              当前生效：
              <strong className="text-foreground">{getAuthorityModeLabel(settings?.authorityMode)}</strong>
              {settings?.authorityMode === 'primary_device' && settings.primaryDeviceId
                ? ` (${deviceNameMap.get(settings.primaryDeviceId) || shortId(settings.primaryDeviceId, 10)})`
                : ''}
            </span>
            <Button
              type="button"
              size="sm"
              className="h-7 px-2.5 text-[11px] shrink-0"
              disabled={savingAuthority || (authorityMode === 'primary_device' && !primaryDeviceId)}
              onClick={handleSaveAuthorityPolicy}>
              {savingAuthority ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
              保存基准策略
            </Button>
          </div>
        </div>
      </section>

      {/* Dismissible Spec Chapter 10.3 Security Boundary Notice */}
      {isBannerVisible('devices_webdav_security_notice', 'security') ? (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.08] p-3 text-xs space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-1.5 font-semibold text-amber-900 dark:text-amber-300">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <span>安全边界说明：逻辑移除设备 ≠ 吊销 WebDAV 服务端访问权限</span>
            </div>
            <div className="flex items-center gap-1 shrink-0 text-amber-900 dark:text-amber-200">
              <button
                type="button"
                onClick={() => void dismissBanner('devices_webdav_security_notice')}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-amber-500/20">
                不再提示
              </button>
              <button
                type="button"
                onClick={() => void dismissBanner('devices_webdav_security_notice')}
                className="rounded p-0.5 hover:bg-amber-500/20"
                aria-label="关闭安全边界提示">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-amber-900/90 dark:text-amber-200/90">
            <strong>逻辑暂停 / 移除设备</strong>仅在 SessionMesh
            空间中将该设备标记为停止同步（其余设备将忽略其新事件，且不再等待其 Tombstone 确认）。但若多台设备
            <strong>共享同一 WebDAV 账户密码</strong>，被移除设备在底层仍持有该 WebDAV
            路径的读写凭据。如设备丢失或不再受信任，请务必同时：① 在 WebDAV 服务端吊销其应用专用密码或更改密码；②
            在设置页执行「空间加密密钥轮换」。
          </p>
        </div>
      ) : null}

      {/* Header Row */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          当前空间已注册 {devices.length} 台设备（活跃 {devices.filter(d => d.state === 'active').length} 台）
        </span>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={loadDevices} disabled={loading}>
          <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      {/* Devices List */}
      {loading && devices.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          正在加载设备注册记录...
        </div>
      ) : filteredDevices.length === 0 ? (
        <EmptyState
          icon={<Laptop className="h-5 w-5" />}
          title="暂无匹配的已注册设备"
          description="在其他电脑安装 SessionMesh 并使用同一 WebDAV 与空间密码加入后，设备会自动出现在此列表。"
        />
      ) : (
        <div className="space-y-2.5">
          {filteredDevices.map(dev => {
            const isSelf = dev.deviceId === currentDeviceId;
            const isEditing = editingId === dev.deviceId;
            const isPrimary =
              settings?.authorityMode === 'primary_device' && settings?.primaryDeviceId === dev.deviceId;
            const devPolicy = settings?.devicePolicies?.[dev.deviceId];
            const isBusy =
              busyKey === `state:${dev.deviceId}` ||
              busyKey === `rename:${dev.deviceId}` ||
              busyKey === `primary:${dev.deviceId}`;
            const stateMeta = getDeviceStateMeta(dev.state);

            return (
              <div
                key={dev.deviceId}
                className={`rounded-xl border p-3 text-xs space-y-2.5 ${
                  isPrimary
                    ? 'border-amber-500/50 bg-amber-500/[0.03]'
                    : isSelf
                      ? 'border-primary/45 bg-primary/[0.03]'
                      : 'border-border bg-card'
                }`}>
                {/* Name & State Row */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <Input
                          value={editingName}
                          onChange={e => setEditingName(e.target.value)}
                          className="h-7 text-xs"
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleSaveRename(dev.deviceId);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                        />
                        <Button
                          size="icon"
                          variant="default"
                          className="h-7 w-7 shrink-0"
                          disabled={isBusy}
                          onClick={() => handleSaveRename(dev.deviceId)}>
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 shrink-0"
                          onClick={() => setEditingId(null)}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Laptop className="h-3.5 w-3.5 text-primary shrink-0" />
                        <span className="font-semibold text-foreground">{dev.name}</span>
                        {isSelf ? <StatusBadge tone="primary">当前本机</StatusBadge> : null}
                        {isPrimary ? <StatusBadge tone="warning">🌟 主基准设备</StatusBadge> : null}
                        <StatusBadge tone={stateMeta.tone}>{stateMeta.label}</StatusBadge>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(dev.deviceId);
                            setEditingName(dev.name);
                          }}
                          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          title="重命名设备">
                          <Edit2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}

                    {/* Device ID */}
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span className="font-mono truncate">ID: {dev.deviceId}</span>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await copyToClipboard(dev.deviceId);
                          if (ok) toast.success('已复制设备 ID');
                        }}
                        className="shrink-0 hover:text-foreground"
                        title="复制设备 ID">
                        <Copy className="h-3 w-3" />
                      </button>
                    </div>

                    {/* Active Per-Device Policy Badges */}
                    {renderPolicyBadges(devPolicy)}
                  </div>
                </div>

                {/* Metadata Grid */}
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg border border-border/70 bg-muted/25 p-2 text-[11px]">
                  <div>
                    <span className="text-muted-foreground">浏览器 / 平台：</span>
                    <span className="text-foreground">
                      {dev.browser} {dev.browserVersion} · {dev.platform}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">扩展版本：</span>
                    <span className="font-mono text-foreground">v{dev.extensionVersion}</span>
                  </div>
                  <div title={formatDateTime(dev.lastSeenAt)}>
                    <span className="text-muted-foreground">最近在线：</span>
                    <span className="text-foreground">{formatRelativeTime(dev.lastSeenAt)}</span>
                  </div>
                  <div title={formatDateTime(dev.lastSyncAt)}>
                    <span className="text-muted-foreground">最近同步：</span>
                    <span className="text-foreground">{formatRelativeTime(dev.lastSyncAt)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">事件序号 / 修订：</span>
                    <span className="font-mono text-foreground">
                      seq #{dev.sequence} · L{dev.localRevision}/R{dev.remoteRevision}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">待处理 / 失败：</span>
                    <span className="font-mono">
                      <span className={dev.pendingEvents > 0 ? 'text-amber-600 dark:text-amber-400 font-semibold' : ''}>
                        {dev.pendingEvents}
                      </span>
                      {' / '}
                      <span className={dev.failedEvents > 0 ? 'text-rose-600 dark:text-rose-400 font-semibold' : ''}>
                        {dev.failedEvents}
                      </span>
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1 border-t border-border/60">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      disabled={isBusy}
                      onClick={() => setPolicyModalDevice(dev)}>
                      <Sliders className="mr-1 h-3 w-3 text-primary" />
                      独立策略配置
                    </Button>

                    {!isPrimary && dev.state !== 'removed' && dev.state !== 'revoked' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        disabled={isBusy}
                        onClick={() => handleQuickSetPrimary(dev)}>
                        {busyKey === `primary:${dev.deviceId}` ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <Crown className="mr-1 h-3 w-3 text-amber-500" />
                        )}
                        设为主基准设备
                      </Button>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {dev.state === 'active' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        disabled={isBusy}
                        onClick={() => handleSetState(dev, 'paused')}>
                        <Pause className="mr-1 h-3 w-3" />
                        暂停同步
                      </Button>
                    ) : dev.state === 'paused' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        disabled={isBusy}
                        onClick={() => handleSetState(dev, 'active')}>
                        <Play className="mr-1 h-3 w-3 text-emerald-600" />
                        恢复同步
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        disabled={isBusy}
                        onClick={() => handleSetState(dev, 'active')}>
                        <RotateCcw className="mr-1 h-3 w-3" />
                        重新激活
                      </Button>
                    )}

                    {dev.state !== 'removed' && dev.state !== 'revoked' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[11px] text-rose-600 hover:bg-rose-500/10 hover:text-rose-600"
                        disabled={isBusy}
                        onClick={() => setRemoveTarget(dev)}>
                        <Trash2 className="mr-1 h-3 w-3" />
                        逻辑移除
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Per-Device Independent Policy Modal */}
      <DevicePolicyModal
        open={!!policyModalDevice}
        device={policyModalDevice}
        allDevices={devices}
        existingPolicy={policyModalDevice ? settings?.devicePolicies?.[policyModalDevice.deviceId] : undefined}
        onClose={() => setPolicyModalDevice(null)}
        onSave={handleSaveDevicePolicy}
        onReset={handleRemoveDevicePolicy}
      />

      {/* Confirm Logical Remove Modal */}
      <Modal
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        title={`逻辑移除设备：${removeTarget?.name || ''}`}
        description="移除后该设备将被标记为已移除状态，其他设备不再接收其同步事件。"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setRemoveTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!removeTarget || busyKey === `state:${removeTarget?.deviceId}`}
              onClick={() => removeTarget && handleSetState(removeTarget, 'removed')}>
              确认逻辑移除
            </Button>
          </>
        }>
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            即将逻辑移除设备 <strong className="text-foreground">{removeTarget?.name}</strong> (
            <code className="font-mono">{removeTarget?.deviceId}</code>)。
          </p>
          <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-2.5 text-[11px] text-amber-800 dark:text-amber-300">
            请知悉：逻辑移除不会吊销该设备在 WebDAV 服务端已保存的账号/应用密码。如该设备不再可信，请前往 WebDAV
            服务商控制台吊销对应密码，并在设置页轮换空间加密密钥。
          </div>
        </div>
      </Modal>
    </div>
  );
};
