import type {
  PayloadEncoding,
  SpaceSettings,
  SyncDirection,
  SyncScopeMode,
  SyncStatusSummary,
  SyncTimingMode,
} from '@sessionmesh/core';
import { unwrapCommand } from '@sessionmesh/shared';
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
import { Bell, Globe, Loader2, Lock, RotateCcw, Settings2, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { extractErrorMessage, useUiBannerPrefs } from '../utils/helpers';

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

interface PolicyAdvancedTabProps {
  status: SyncStatusSummary;
  onRefreshStatus: () => Promise<void>;
}

export function PolicyAdvancedTab({ status, onRefreshStatus }: PolicyAdvancedTabProps) {
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
  const [lockingNow, setLockingNow] = useState(false);

  const loadSettings = useCallback(async () => {
    if (!status.configured || status.locked) return;
    try {
      const summaryPayload = await unwrapCommand<{ settings?: SpaceSettings }>({
        type: 'GET_STATUS_SUMMARY',
      }).catch(() => null);
      if (summaryPayload?.settings) {
        setSettings(summaryPayload.settings);
        setPollingInput(String(summaryPayload.settings.pollingIntervalSec ?? 60));
      }
    } catch {
      // ignore transient errors
    }
  }, [status.configured, status.locked]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings, status.activeSpaceId]);

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

  const handleSavePolling = async () => {
    const parsed = Math.max(15, Math.min(3600, Number.parseInt(pollingInput, 10) || 60));
    setPollingInput(String(parsed));
    await patchSetting('pollingIntervalSec', parsed, `后台检查间隔 ${parsed} 秒`);
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

  return (
    <div className="space-y-5">
      {/* Managed Sites Scope Mode Switcher */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Globe className="h-5 w-5 text-primary" />
                网站纳管模式
              </CardTitle>
              <CardDescription>
                控制新访问网站是否自动加入同步；多设备基准与单设备独立策略请前往「设备与同步空间」配置。
              </CardDescription>
            </div>
            <Badge variant={effectiveSyncScopeMode === 'managed_only' ? 'success' : 'secondary'}>
              {effectiveSyncScopeMode === 'managed_only' ? '仅同步已纳管网站' : '全站自动纳管'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              disabled={savingKey === 'syncScopeMode' || status.locked}
              onClick={() =>
                void patchSetting('syncScopeMode', 'managed_only', '仅同步已纳入管理的网站 (managed_only)')
              }
              className={`rounded-xl border p-3.5 text-left transition-all ${
                effectiveSyncScopeMode === 'managed_only'
                  ? 'border-primary bg-primary/[0.06] ring-1 ring-primary/40'
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
              className={`rounded-xl border p-3.5 text-left transition-all ${
                effectiveSyncScopeMode === 'all_sites'
                  ? 'border-primary bg-primary/[0.06] ring-1 ring-primary/40'
                  : 'border-border bg-background hover:border-primary/40'
              }`}>
              <div className="text-xs font-semibold text-foreground">全站自动纳管 (all_sites)</div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                自动纳管并同步浏览器中除黑名单外的所有站点 Cookie 与 LocalStorage。
              </p>
            </button>
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

      {/* Warning & Notification Banner Display Preferences */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-5 w-5 text-primary" />
            警告与通知显示设置
          </CardTitle>
          <CardDescription>
            控制综合管理控制台、弹窗与侧边栏中的风险警告、WebDAV 降级提示及已关闭横幅的显示行为（即时同步生效）。
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
    </div>
  );
}
