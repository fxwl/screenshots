import { extractErrorMessage } from '@console/lib/api';
import { parseManualSiteKeysInput } from '@console/lib/format';
import type { Device, PerDeviceSyncPolicy, SyncDirection } from '@sessionmesh/shared';
import { Button, Input, Label } from '@sessionmesh/ui';
import { Ban, Loader2, Plus, RotateCcw, Save, Sliders, X } from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from './common/Badge';
import { Modal } from './common/Modal';

export interface DevicePolicyModalProps {
  open: boolean;
  device: Device | null;
  allDevices: Device[];
  existingPolicy?: PerDeviceSyncPolicy;
  onClose: () => void;
  onSave: (policy: PerDeviceSyncPolicy) => Promise<void>;
  onReset: (deviceId: string) => Promise<void>;
}

export const DevicePolicyModal: React.FC<DevicePolicyModalProps> = ({
  open,
  device,
  allDevices,
  existingPolicy,
  onClose,
  onSave,
  onReset,
}) => {
  const [mode, setMode] = useState<PerDeviceSyncPolicy['mode']>('inherit');
  const [followDeviceId, setFollowDeviceId] = useState<string>('');
  const [direction, setDirection] = useState<SyncDirection>('inherit');
  const [excludedSiteKeys, setExcludedSiteKeys] = useState<string[]>([]);
  const [siteInput, setSiteInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const peerDevices = useMemo(
    () => allDevices.filter(d => d.deviceId !== device?.deviceId && d.state !== 'removed' && d.state !== 'revoked'),
    [allDevices, device?.deviceId],
  );

  const knownBoundSites = useMemo(() => {
    if (!device?.siteBindings) return [];
    return Object.entries(device.siteBindings)
      .filter(([, binding]) => binding.state !== 'UNMANAGED' && binding.state !== 'BLACKLISTED')
      .map(([siteKey]) => siteKey)
      .filter(sk => !excludedSiteKeys.includes(sk))
      .sort()
      .slice(0, 12);
  }, [device?.siteBindings, excludedSiteKeys]);

  useEffect(() => {
    if (!open || !device) return;
    setMode(existingPolicy?.mode ?? 'inherit');
    setFollowDeviceId(existingPolicy?.followDeviceId || peerDevices[0]?.deviceId || '');
    setDirection(existingPolicy?.direction ?? 'inherit');
    setExcludedSiteKeys(existingPolicy?.excludedSiteKeys ? [...existingPolicy.excludedSiteKeys] : []);
    setSiteInput('');
    setError(null);
    setSaving(false);
    setResetting(false);
  }, [open, device, existingPolicy, peerDevices]);

  const handleAddExcludedSite = (rawOverride?: string) => {
    const raw = rawOverride !== undefined ? rawOverride : siteInput;
    const parsed = parseManualSiteKeysInput(raw);
    if (parsed.length === 0) {
      toast.warning('请输入有效站点主域，例如 example.com');
      return;
    }
    setExcludedSiteKeys(prev => Array.from(new Set([...prev, ...parsed])));
    if (rawOverride === undefined) {
      setSiteInput('');
    }
  };

  const handleRemoveExcludedSite = (siteKey: string) => {
    setExcludedSiteKeys(prev => prev.filter(s => s !== siteKey));
  };

  const handleSave = async () => {
    if (!device) return;
    if (mode === 'follow_device' && !followDeviceId) {
      setError('选择「指定跟随特定设备」时，请先选择要跟随的目标设备。');
      return;
    }

    const pendingTyped = siteInput.trim() ? parseManualSiteKeysInput(siteInput) : [];
    const finalExcluded = Array.from(new Set([...excludedSiteKeys, ...pendingTyped]));

    const policy: PerDeviceSyncPolicy = {
      deviceId: device.deviceId,
      mode,
      followDeviceId: mode === 'follow_device' ? followDeviceId : undefined,
      direction,
      excludedSiteKeys: finalExcluded.length > 0 ? finalExcluded : undefined,
      updatedAt: Date.now(),
    };

    setSaving(true);
    setError(null);
    try {
      await onSave(policy);
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!device) return;
    setResetting(true);
    setError(null);
    try {
      await onReset(device.deviceId);
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setResetting(false);
    }
  };

  const busy = saving || resetting;

  return (
    <Modal
      open={open && !!device}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={
        <span className="inline-flex items-center gap-1.5">
          <Sliders className="h-4 w-4 text-primary" />
          设备独立策略配置：{device?.name || ''}
        </span>
      }
      description="单独覆盖该设备的同步角色、方向限制与排除网站；未配置时自动继承空间统一基准策略。"
      maxWidthClass="max-w-lg"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            disabled={busy || !existingPolicy}
            onClick={handleReset}
            title={existingPolicy ? '清除该设备的独立覆盖配置，恢复跟随空间默认策略' : '当前已为默认继承状态'}>
            {resetting ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
            )}
            恢复默认继承
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button type="button" size="sm" onClick={handleSave} disabled={busy}>
              {saving ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-3.5 w-3.5" />
              )}
              保存此设备专属配置
            </Button>
          </div>
        </div>
      }>
      <div className="space-y-4 text-xs">
        {/* 1. Sync Role Mode */}
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-foreground">1. 同步角色模式</Label>
          <div className="space-y-1.5">
            {(
              [
                {
                  value: 'inherit',
                  title: '跟随空间默认 (inherit)',
                  desc: '遵循空间顶部配置的统一同步基准策略（手动询问 / 主基准设备 / 最新优先）。',
                },
                {
                  value: 'independent_tracks',
                  title: '独立维护自身账号轨道 (independent_tracks)',
                  desc: '遇到双端已有数据或多轨道时，自动保留本设备独立轨道，不覆盖也不跟随其他设备。',
                },
                {
                  value: 'follow_device',
                  title: '指定跟随特定设备 (follow_device)',
                  desc: '优先自动采用并跟随某台指定设备的站点轨道（适合笔记本跟随主力台式机）。',
                },
              ] as const
            ).map(option => {
              const radioId = `device-policy-mode-${option.value}`;
              return (
                <div
                  key={option.value}
                  className={`flex items-start gap-2 rounded-lg border p-2.5 transition-colors ${
                    mode === option.value
                      ? 'border-primary bg-primary/[0.06]'
                      : 'border-border bg-card hover:bg-muted/30'
                  }`}>
                  <input
                    id={radioId}
                    type="radio"
                    name="device-policy-mode"
                    value={option.value}
                    checked={mode === option.value}
                    onChange={() => {
                      setMode(option.value);
                      if (option.value === 'follow_device' && !followDeviceId && peerDevices.length > 0) {
                        setFollowDeviceId(peerDevices[0].deviceId);
                      }
                    }}
                    className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-primary"
                  />
                  <label htmlFor={radioId} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block font-medium text-foreground">{option.title}</span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                      {option.desc}
                    </span>
                  </label>
                </div>
              );
            })}
          </div>

          {mode === 'follow_device' ? (
            <div className="mt-2 rounded-lg border border-border bg-muted/30 p-2.5 space-y-1.5">
              <Label htmlFor="device-policy-follow-target" className="text-[11px] font-medium">
                选择要跟随的目标设备
              </Label>
              {peerDevices.length === 0 ? (
                <p className="text-[11px] text-amber-700 dark:text-amber-300">
                  当前空间暂无其他可用活跃设备，请先在其他设备加入同一空间后再指定跟随。
                </p>
              ) : (
                <select
                  id="device-policy-follow-target"
                  aria-label="选择要跟随的目标设备"
                  value={followDeviceId}
                  onChange={e => setFollowDeviceId(e.target.value)}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground">
                  {peerDevices.map(peer => (
                    <option key={peer.deviceId} value={peer.deviceId}>
                      {peer.name} ({peer.browser} · {peer.platform})
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : null}
        </div>

        {/* 2. Sync Direction Restriction */}
        <div className="space-y-1.5">
          <Label htmlFor="device-policy-direction" className="text-xs font-semibold text-foreground">
            2. 同步方向限制
          </Label>
          <select
            id="device-policy-direction"
            aria-label="该设备的同步方向限制"
            value={direction}
            onChange={e => setDirection(e.target.value as SyncDirection)}
            className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground">
            <option value="inherit">继承全局 (inherit)</option>
            <option value="bidirectional">双向同步 (bidirectional)</option>
            <option value="pull_only">仅拉取（只读跟随，不上传本机改动 pull_only）</option>
            <option value="push_only">仅上传（仅上报本机改动，不拉取覆盖 push_only）</option>
            <option value="disabled">停用同步 (disabled)</option>
          </select>
          {direction === 'pull_only' ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-300">
              只读跟随模式：本设备只接收并应用云端更新，任何本机退出/切换账号都不会上传影响其他设备。
            </p>
          ) : null}
        </div>

        {/* 3. Per-Device Excluded Site Keys */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="device-policy-exclude-input" className="text-xs font-semibold text-foreground">
              3. 该设备专属排除网站 ({excludedSiteKeys.length})
            </Label>
            <span className="text-[10px] text-muted-foreground">仅跳过该设备上的这些站点</span>
          </div>

          <div className="flex items-center gap-1.5">
            <Input
              id="device-policy-exclude-input"
              value={siteInput}
              onChange={e => setSiteInput(e.target.value)}
              placeholder="输入 siteKey，如 github.com, bilibili.com"
              className="h-8 flex-1 text-xs font-mono"
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddExcludedSite();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2.5 text-xs shrink-0"
              disabled={!siteInput.trim()}
              onClick={() => handleAddExcludedSite()}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              排除
            </Button>
          </div>

          {excludedSiteKeys.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 rounded-lg border border-border bg-muted/20 p-2">
              {excludedSiteKeys.map(sk => (
                <span
                  key={sk}
                  className="inline-flex items-center gap-1 rounded-full border border-rose-500/35 bg-rose-500/10 px-2 py-0.5 font-mono text-[11px] text-rose-700 dark:text-rose-300">
                  <Ban className="h-2.5 w-2.5" />
                  {sk}
                  <button
                    type="button"
                    onClick={() => handleRemoveExcludedSite(sk)}
                    className="rounded-full p-0.5 hover:bg-rose-500/20"
                    aria-label={`取消排除 ${sk}`}>
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">暂无该设备专属排除网站。</p>
          )}

          {knownBoundSites.length > 0 ? (
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground">快捷从该设备已绑定站点中排除：</p>
              <div className="flex flex-wrap gap-1">
                {knownBoundSites.map(sk => (
                  <button
                    key={sk}
                    type="button"
                    onClick={() => handleAddExcludedSite(sk)}
                    className="inline-flex items-center gap-0.5 rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary/50 hover:text-foreground">
                    <Plus className="h-2.5 w-2.5" />
                    {sk}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {existingPolicy ? (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <StatusBadge tone="info">已配置独立策略</StatusBadge>
            <span>如需回归全局统一行为，可点击左下角「恢复默认继承」。</span>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-2 text-[11px] text-rose-700 dark:text-rose-300">
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
};
