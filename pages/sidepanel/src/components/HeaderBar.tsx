import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import { useBannerPrefs } from '@console/lib/bannerPrefs';
import { formatRelativeTime, getDeviceStatusMeta } from '@console/lib/format';
import { useTheme } from '@sessionmesh/shared';
import type { SyncStatusSummary, SyncTimingMode } from '@sessionmesh/shared';
import { Button, Input, Label, Switch, ThemeDropdown } from '@sessionmesh/ui';
import {
  Bell,
  BellOff,
  Laptop,
  Layers,
  Lock,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  X,
} from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Modal } from './common/Modal';

export interface HeaderBarProps {
  status: SyncStatusSummary | null;
  syncTimingMode?: SyncTimingMode;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onRefreshAll: () => Promise<void> | void;
  syncing: boolean;
  onSyncNow: () => Promise<void>;
  onOpenOptions?: () => void;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({
  status,
  syncTimingMode,
  searchQuery,
  onSearchChange,
  onRefreshAll,
  syncing,
  onSyncNow,
  onOpenOptions,
}) => {
  const { setTheme } = useTheme();
  const {
    prefs: bannerPrefs,
    dismissedCount,
    hasSuppressedHints,
    setShowSecurityWarnings,
    setShowDegradedWarnings,
    restoreAllBanners,
  } = useBannerPrefs();
  const [switchingSpaceId, setSwitchingSpaceId] = useState<string | null>(null);
  const [passwordModalSpace, setPasswordModalSpace] = useState<{ spaceId: string; name: string } | null>(null);
  const [spacePassword, setSpacePassword] = useState('');
  const [togglingPause, setTogglingPause] = useState(false);
  const [bannerModalOpen, setBannerModalOpen] = useState(false);

  const statusMeta = getDeviceStatusMeta(status?.status, syncTimingMode);
  const isPaused = status?.status === 'PAUSED';

  const handleOpenSettings = () => {
    if (onOpenOptions) {
      onOpenOptions();
      return;
    }
    if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open('/options/index.html', '_blank');
    }
  };

  const handleSpaceChange = async (targetSpaceId: string) => {
    if (!targetSpaceId || targetSpaceId === status?.activeSpaceId) return;
    setSwitchingSpaceId(targetSpaceId);
    try {
      await sidePanelApi.switchSpace(targetSpaceId);
      toast.success('已切换同步空间');
      await onRefreshAll();
    } catch (err) {
      const msg = extractErrorMessage(err);
      if (/password|decrypt|lock|密钥|密码|解锁/i.test(msg)) {
        const spaceInfo = status?.spaces?.find(s => s.spaceId === targetSpaceId);
        setPasswordModalSpace({ spaceId: targetSpaceId, name: spaceInfo?.name || targetSpaceId });
        setSpacePassword('');
      } else {
        toast.error(`切换空间失败：${msg}`);
      }
    } finally {
      setSwitchingSpaceId(null);
    }
  };

  const handleConfirmSpacePassword = async () => {
    if (!passwordModalSpace || !spacePassword) return;
    setSwitchingSpaceId(passwordModalSpace.spaceId);
    try {
      await sidePanelApi.switchSpace(passwordModalSpace.spaceId, spacePassword);
      toast.success(`已解锁并切换至空间「${passwordModalSpace.name}」`);
      setPasswordModalSpace(null);
      setSpacePassword('');
      await onRefreshAll();
    } catch (err) {
      toast.error(`解锁切换失败：${extractErrorMessage(err)}`);
    } finally {
      setSwitchingSpaceId(null);
    }
  };

  const handleTogglePause = async () => {
    setTogglingPause(true);
    try {
      await sidePanelApi.setGlobalPaused(!isPaused);
      toast.success(isPaused ? '已恢复全局自动同步' : '已暂停全局自动同步');
      await onRefreshAll();
    } catch (err) {
      toast.error(`操作失败：${extractErrorMessage(err)}`);
    } finally {
      setTogglingPause(false);
    }
  };

  const handleLock = async () => {
    try {
      await sidePanelApi.lockSession();
      toast.success('会话密钥已锁定');
      await onRefreshAll();
    } catch (err) {
      toast.error(`锁定失败：${extractErrorMessage(err)}`);
    }
  };

  return (
    <header className="shrink-0 border-b border-border bg-card/80 backdrop-blur-sm px-3 py-2.5 space-y-2">
      {/* Top Row: Brand/Space + Quick Controls */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <img
            src={
              typeof chrome !== 'undefined' && chrome.runtime?.getURL
                ? chrome.runtime.getURL('options/logo.png')
                : '/logo.svg'
            }
            alt="SessionMesh"
            className="h-7 w-7 shrink-0 rounded-lg object-contain shadow-sm"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <Layers className="h-3.5 w-3.5 shrink-0 text-primary" />
              {status?.spaces && status.spaces.length > 1 ? (
                <select
                  aria-label="切换同步空间"
                  value={status.activeSpaceId || ''}
                  disabled={!!switchingSpaceId}
                  onChange={e => handleSpaceChange(e.target.value)}
                  className="max-w-[165px] truncate rounded border border-input bg-background px-1.5 py-0.5 text-xs font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
                  {status.spaces.map(sp => (
                    <option key={sp.spaceId} value={sp.spaceId}>
                      {sp.name || sp.spaceId}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="truncate text-xs font-semibold text-foreground">
                  {status?.activeSpaceName || (status?.configured ? status.activeSpaceId : 'SessionMesh 未配置')}
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
              <span className="inline-flex items-center gap-1 truncate max-w-[125px]" title={status?.device?.name}>
                <Laptop className="h-3 w-3 shrink-0" />
                <span className="truncate">{status?.device?.name || '本机设备'}</span>
              </span>
              <span className="text-border">·</span>
              <span className="inline-flex items-center gap-1 shrink-0">
                <span className={`h-1.5 w-1.5 rounded-full ${statusMeta.dotClass}`} />
                <span>{statusMeta.label}</span>
              </span>
              {status?.lastSyncAt ? (
                <>
                  <span className="text-border hidden sm:inline">·</span>
                  <span className="hidden sm:inline truncate">{formatRelativeTime(status.lastSyncAt)}</span>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {status?.configured && !status.locked ? (
            <>
              <Button
                variant="default"
                size="sm"
                className="h-7 px-2 text-xs gap-1"
                disabled={syncing || isPaused}
                onClick={onSyncNow}
                title="立即执行全局双向同步">
                <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                <span className="hidden min-[400px]:inline">{syncing ? '同步中' : '立即同步'}</span>
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={togglingPause}
                onClick={handleTogglePause}
                title={isPaused ? '恢复自动同步' : '暂停自动同步'}>
                {isPaused ? <Play className="h-3.5 w-3.5 text-emerald-600" /> : <Pause className="h-3.5 w-3.5" />}
              </Button>
              <Button variant="outline" size="icon" className="h-7 w-7" onClick={handleLock} title="锁定当前加密会话">
                <Lock className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : null}
          <Button
            variant="outline"
            size="icon"
            className="relative h-7 w-7"
            onClick={() => setBannerModalOpen(true)}
            title={hasSuppressedHints ? '部分安全/降级提示已隐藏（点击管理或恢复）' : '警告与提示横幅显示设置'}>
            {hasSuppressedHints ? (
              <BellOff className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <Bell className="h-3.5 w-3.5" />
            )}
            {hasSuppressedHints ? (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-500" />
            ) : null}
          </Button>
          <div className="[&_button]:h-7 [&_button]:w-7">
            <ThemeDropdown setTheme={setTheme} />
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={handleOpenSettings}
            title="打开 SessionMesh 设置与引导">
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Global Search Bar (hidden when unconfigured, locked, or awaiting re-unlock) */}
      {status?.configured && !status.locked && status.status !== 'DECRYPT_ERROR' ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="搜索站点、Cookie、Origin、设备、规则或日志..."
            className="h-8 pl-8 pr-7 text-xs bg-background"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="清除搜索">
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Space Switch Password Prompt Modal */}
      <Modal
        open={!!passwordModalSpace}
        onClose={() => setPasswordModalSpace(null)}
        title={`解锁同步空间：${passwordModalSpace?.name || ''}`}
        description="该同步空间已加密，请输入端到端加密密码以完成切换。"
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setPasswordModalSpace(null)}>
              取消
            </Button>
            <Button size="sm" disabled={!spacePassword || !!switchingSpaceId} onClick={handleConfirmSpacePassword}>
              确认切换
            </Button>
          </>
        }>
        <div className="space-y-2">
          <Label htmlFor="switch-space-password" className="text-xs">
            空间端到端加密密码
          </Label>
          <Input
            id="switch-space-password"
            type="password"
            value={spacePassword}
            onChange={e => setSpacePassword(e.target.value)}
            placeholder="输入该空间的加密密码"
            onKeyDown={e => {
              if (e.key === 'Enter') handleConfirmSpacePassword();
            }}
          />
        </div>
      </Modal>

      {/* Banner & Warning Preferences Modal */}
      <Modal
        open={bannerModalOpen}
        onClose={() => setBannerModalOpen(false)}
        title="警告与提示横幅显示设置"
        description="控制侧边栏、弹窗与设置页共享的安全边界、降级兼容及操作提示横幅。"
        maxWidthClass="max-w-sm"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!hasSuppressedHints}
              onClick={async () => {
                await restoreAllBanners();
                toast.success('已恢复显示所有警告与提示横幅');
              }}>
              <RotateCcw className="mr-1 h-3 w-3" />
              恢复全部已关闭提示
            </Button>
            <Button type="button" size="sm" className="h-7 px-3 text-xs" onClick={() => setBannerModalOpen(false)}>
              完成
            </Button>
          </div>
        }>
        <div className="space-y-3 text-xs">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-2.5">
            <div className="min-w-0">
              <Label htmlFor="header-pref-security" className="text-xs font-medium cursor-pointer">
                显示安全与权限风险提示
              </Label>
              <p className="mt-0.5 text-[11px] text-muted-foreground">如设备移除与共享 WebDAV 凭据边界说明等提示。</p>
            </div>
            <Switch
              id="header-pref-security"
              checked={bannerPrefs.showSecurityWarnings}
              onCheckedChange={checked => void setShowSecurityWarnings(checked)}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-2.5">
            <div className="min-w-0">
              <Label htmlFor="header-pref-degraded" className="text-xs font-medium cursor-pointer">
                显示兼容降级与阻尼提示
              </Label>
              <p className="mt-0.5 text-[11px] text-muted-foreground">如 WebDAV 追加降级模式、滚动令牌阻尼保护提示。</p>
            </div>
            <Switch
              id="header-pref-degraded"
              checked={bannerPrefs.showDegradedWarnings}
              onCheckedChange={checked => void setShowDegradedWarnings(checked)}
            />
          </div>

          <p className="text-[11px] text-muted-foreground">
            当前已单独关闭 <strong>{dismissedCount}</strong> 条提示横幅（设置与 Options/Popup 自动实时同步）。
          </p>
        </div>
      </Modal>
    </header>
  );
};
