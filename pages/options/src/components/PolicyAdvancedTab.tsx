import type {
  CookieExpiryWarningSettings,
  PayloadEncoding,
  SpaceSettings,
  SyncDirection,
  SyncScopeMode,
  SyncStatusSummary,
  SyncTimingMode,
  ToolbarBadgeDisplayMode,
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
import {
  Bell,
  Clock,
  ExternalLink,
  Globe,
  Keyboard,
  Loader2,
  Lock,
  Palette,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { extractErrorMessage, useUiBannerPrefs, useUxOnboardingPrefs } from '../utils/helpers';

const DEFAULT_EXPIRY_WARNING: CookieExpiryWarningSettings = {
  enabled: true,
  warningLeadHours: 24,
  criticalLeadHours: 2,
  includeInactiveTracks: true,
};

const INITIAL_SPACE_SETTINGS: SpaceSettings = {
  autoSync: true,
  direction: 'bidirectional',
  syncCookies: true,
  syncLocalStorage: true,
  syncSessionStorage: false,
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
  badgeDisplayMode: 'multi_or_tagged',
  expiryWarning: DEFAULT_EXPIRY_WARNING,
};

const COMMAND_METADATA: Record<string, { title: string; description: string }> = {
  'rotate-account-next': {
    title: '轮换下一个账号',
    description: '按顺序切换到当前网站的下一个多账号轨道',
  },
  'rotate-account-prev': {
    title: '轮换上一个账号',
    description: '按顺序切换到当前网站的上一个多账号轨道',
  },
  'sync-current-site': {
    title: '立即同步当前网站',
    description: '对当前标签页所属网站立即执行双向同步',
  },
  'copy-current-curl': {
    title: '复制当前页 curl Cookie',
    description: '将当前页面匹配的有效 Cookie 导出为 curl 命令并复制',
  },
};

const BADGE_DISPLAY_OPTIONS: Array<{
  mode: ToolbarBadgeDisplayMode;
  title: string;
  badge?: string;
  description: string;
}> = [
  {
    mode: 'multi_or_tagged',
    title: '多账号或已设颜色/简称时显示',
    badge: '默认推荐',
    description: '站点拥有 2 个及以上账号，或已自定义账号颜色/简称时在工具栏图标展示账号角标。',
  },
  {
    mode: 'always',
    title: '始终显示当前账号角标',
    description: '所有已纳管站点均在工具栏图标展示当前激活账号的色标与简称。',
  },
  {
    mode: 'status_only',
    title: '仅显示同步状态与异常角标',
    description: '不在工具栏显示账号编号或颜色，仅在同步中、待决策或异常时显示状态徽标。',
  },
];

interface BrowserCommandEntry {
  name: string;
  description?: string;
  shortcut?: string;
}

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
  const { prefs: uxPrefs, updatePrefs: updateUxPrefs, resetGuideProgress } = useUxOnboardingPrefs();

  const [settings, setSettings] = useState<SpaceSettings>(INITIAL_SPACE_SETTINGS);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [pollingInput, setPollingInput] = useState('60');
  const [lockingNow, setLockingNow] = useState(false);
  const [commands, setCommands] = useState<BrowserCommandEntry[]>([]);
  const [loadingCommands, setLoadingCommands] = useState(false);

  const loadBrowserCommands = useCallback(async () => {
    if (typeof chrome === 'undefined' || !chrome.commands?.getAll) {
      setCommands([]);
      return;
    }
    setLoadingCommands(true);
    try {
      const list = await new Promise<chrome.commands.Command[]>(resolve => {
        try {
          const getAllCommands = chrome.commands.getAll as unknown as (
            callback: (commands: chrome.commands.Command[]) => void,
          ) => Promise<chrome.commands.Command[]> | void;
          const maybePromise = getAllCommands(result => {
            resolve(Array.isArray(result) ? result : []);
          });
          if (maybePromise && typeof maybePromise.then === 'function') {
            void maybePromise.then(res => resolve(Array.isArray(res) ? res : [])).catch(() => resolve([]));
          }
        } catch {
          resolve([]);
        }
      });
      const filtered = list
        .filter(item => item.name && item.name !== '_execute_action' && item.name !== '_execute_browser_action')
        .map(item => ({
          name: item.name || '',
          description: item.description,
          shortcut: item.shortcut,
        }));
      setCommands(filtered);
    } finally {
      setLoadingCommands(false);
    }
  }, []);

  useEffect(() => {
    void loadBrowserCommands();
  }, [loadBrowserCommands]);

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
  const effectiveBadgeMode: ToolbarBadgeDisplayMode = settings.badgeDisplayMode ?? 'multi_or_tagged';
  const effectiveExpiryWarning: CookieExpiryWarningSettings = {
    enabled: settings.expiryWarning?.enabled ?? DEFAULT_EXPIRY_WARNING.enabled,
    warningLeadHours: settings.expiryWarning?.warningLeadHours ?? DEFAULT_EXPIRY_WARNING.warningLeadHours,
    criticalLeadHours: settings.expiryWarning?.criticalLeadHours ?? DEFAULT_EXPIRY_WARNING.criticalLeadHours,
    includeInactiveTracks:
      settings.expiryWarning?.includeInactiveTracks ?? DEFAULT_EXPIRY_WARNING.includeInactiveTracks,
  };

  const updateExpiryWarning = async (patch: Partial<CookieExpiryWarningSettings>, label: string) => {
    const next: CookieExpiryWarningSettings = {
      ...effectiveExpiryWarning,
      ...patch,
    };
    if (next.criticalLeadHours > next.warningLeadHours) {
      if (patch.warningLeadHours !== undefined) {
        next.criticalLeadHours = next.warningLeadHours;
      } else {
        next.warningLeadHours = next.criticalLeadHours;
      }
    }
    await patchSetting('expiryWarning', next, label);
  };

  const openBrowserShortcutsPage = () => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const shortcutsUrl = ua.includes('Edg/')
      ? 'edge://extensions/shortcuts'
      : ua.includes('Firefox/')
        ? 'about:addons'
        : 'chrome://extensions/shortcuts';

    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({ url: shortcutsUrl }, () => {
        if (chrome.runtime.lastError) {
          toast.info(`请在浏览器地址栏打开 ${shortcutsUrl} 修改快捷键`);
        }
      });
    } else {
      toast.info(`请在浏览器地址栏打开 ${shortcutsUrl} 修改快捷键`);
    }
  };

  const orderedCommands: BrowserCommandEntry[] = [
    ...Object.keys(COMMAND_METADATA).map(id => {
      const found = commands.find(item => item.name === id);
      return found ?? { name: id, shortcut: '' };
    }),
    ...commands.filter(item => !(item.name in COMMAND_METADATA)),
  ];

  return (
    <div className="space-y-5">
      {/* Managed Sites Scope Mode Switcher */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Globe className="h-5 w-5 text-primary" />
                网站同步范围模式
              </CardTitle>
              <CardDescription>
                控制新访问网站是否自动开启同步；多设备冲突裁决与单设备独立策略可前往「设备与跨端配对」设置。
              </CardDescription>
            </div>
            <Badge variant={effectiveSyncScopeMode === 'managed_only' ? 'success' : 'secondary'}>
              {effectiveSyncScopeMode === 'managed_only' ? '仅同步我选中的网站' : '全站自动同步'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              disabled={savingKey === 'syncScopeMode' || status.locked}
              onClick={() => void patchSetting('syncScopeMode', 'managed_only', '仅同步我选中的网站')}
              className={`rounded-xl border p-3.5 text-left transition-all ${
                effectiveSyncScopeMode === 'managed_only'
                  ? 'border-primary bg-primary/[0.06] ring-1 ring-primary/40'
                  : 'border-border bg-background hover:border-primary/40'
              }`}>
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-foreground">
                <span>仅同步我选中的网站（按需开启）</span>
                <Badge variant="success" className="text-[10px]">
                  推荐
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                只同步你主动开启或云端已添加的网站，日常随意浏览的网页绝不采集上传。
              </p>
            </button>

            <button
              type="button"
              disabled={savingKey === 'syncScopeMode' || status.locked}
              onClick={() => void patchSetting('syncScopeMode', 'all_sites', '全站自动同步')}
              className={`rounded-xl border p-3.5 text-left transition-all ${
                effectiveSyncScopeMode === 'all_sites'
                  ? 'border-primary bg-primary/[0.06] ring-1 ring-primary/40'
                  : 'border-border bg-background hover:border-primary/40'
              }`}>
              <div className="text-xs font-semibold text-foreground">全站自动同步（排除列表除外）</div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                自动同步浏览器中除排除黑名单外的所有网站登录状态，免去逐个网站手动开启。
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
            所有写入远端或本地同步目录的文件始终强制使用 SMES v2 (AES-256-GCM) 端到端加密，无法关闭加密。
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
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  同步 SessionStorage（默认全局开关）
                  <Badge variant="outline" className="text-[10px]">
                    按站点可覆盖
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  开启后默认同步标签页会话存储。可在「规则与环境同步 →
                  单站覆盖规则」中为具体站点单独覆盖或设置键名白名单；出于安全与容量控制，
                  <code>IndexedDB</code> 始终仅在单站覆盖规则中按库/表精确配置启用。
                </p>
              </div>
              <Switch
                checked={Boolean(settings.syncSessionStorage)}
                disabled={savingKey === 'syncSessionStorage' || status.locked}
                onCheckedChange={v => patchSetting('syncSessionStorage', v, 'SessionStorage 全局默认开关')}
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

      {/* Toolbar Badge & Account Color Display Mode */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Palette className="h-5 w-5 text-primary" />
                工具栏角标与账号色标显示模式
              </CardTitle>
              <CardDescription>
                自定义扩展工具栏图标上的账号徽标展示方式（账号颜色与 4 字简称可在「多账号管理」中设置）。
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-[11px]">
              {effectiveBadgeMode === 'multi_or_tagged'
                ? '智能显示'
                : effectiveBadgeMode === 'always'
                  ? '始终显示'
                  : '仅状态角标'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-3">
            {BADGE_DISPLAY_OPTIONS.map(opt => {
              const active = effectiveBadgeMode === opt.mode;
              return (
                <button
                  key={opt.mode}
                  type="button"
                  disabled={savingKey === 'badgeDisplayMode' || status.locked}
                  onClick={() => void patchSetting('badgeDisplayMode', opt.mode, `角标显示模式：${opt.title}`)}
                  className={`rounded-xl border p-3.5 text-left transition-all ${
                    active
                      ? 'border-primary bg-primary/[0.06] ring-1 ring-primary/40'
                      : 'border-border bg-background hover:border-primary/40'
                  }`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground">{opt.title}</span>
                    {opt.badge ? (
                      <Badge variant="success" className="shrink-0 px-1.5 py-0 text-[10px]">
                        {opt.badge}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed">{opt.description}</p>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Cookie Expiry Warning Policy */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                Cookie 登录态过期预警
              </CardTitle>
              <CardDescription>
                自动评估认证 Cookie 与重点关注（加星标）Cookie
                的剩余有效期，并在即将过期时在弹窗、侧边栏与角标提前提醒。
              </CardDescription>
            </div>
            <Badge variant={effectiveExpiryWarning.enabled ? 'success' : 'secondary'}>
              {effectiveExpiryWarning.enabled ? '预警已启用' : '已关闭'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="divide-y divide-border rounded-xl border border-border">
            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">启用 Cookie 过期预警</div>
                <p className="text-xs text-muted-foreground">
                  按设定的预警与危急阈值扫描登录态凭据，提前提醒续期或重新登录
                </p>
              </div>
              <Switch
                checked={effectiveExpiryWarning.enabled}
                disabled={savingKey === 'expiryWarning' || status.locked}
                onCheckedChange={v =>
                  void updateExpiryWarning({ enabled: v }, v ? '开启 Cookie 过期预警' : '关闭 Cookie 过期预警')
                }
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">提前预警阈值（Warning）</div>
                <p className="text-xs text-muted-foreground">距离过期小于此时长时标记为「即将过期」温和提醒</p>
              </div>
              <Select
                value={String(effectiveExpiryWarning.warningLeadHours)}
                disabled={!effectiveExpiryWarning.enabled || savingKey === 'expiryWarning' || status.locked}
                onValueChange={v =>
                  void updateExpiryWarning({ warningLeadHours: Number.parseInt(v, 10) || 24 }, `过期预警阈值 ${v} 小时`)
                }>
                <SelectTrigger className="w-44 h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="6">提前 6 小时 (6h)</SelectItem>
                  <SelectItem value="12">提前 12 小时 (12h)</SelectItem>
                  <SelectItem value="24">提前 24 小时 (24h · 推荐)</SelectItem>
                  <SelectItem value="72">提前 3 天 (72h)</SelectItem>
                  <SelectItem value="168">提前 7 天 (168h)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">危急告警阈值（Critical）</div>
                <p className="text-xs text-muted-foreground">距离过期小于此时长时升级为危急告警，提示立即续期</p>
              </div>
              <Select
                value={String(effectiveExpiryWarning.criticalLeadHours)}
                disabled={!effectiveExpiryWarning.enabled || savingKey === 'expiryWarning' || status.locked}
                onValueChange={v =>
                  void updateExpiryWarning({ criticalLeadHours: Number.parseInt(v, 10) || 2 }, `危急预警阈值 ${v} 小时`)
                }>
                <SelectTrigger className="w-44 h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">最后 1 小时 (1h)</SelectItem>
                  <SelectItem value="2">最后 2 小时 (2h · 推荐)</SelectItem>
                  <SelectItem value="6">最后 6 小时 (6h)</SelectItem>
                  <SelectItem value="12">最后 12 小时 (12h)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">同时监控非当前激活的备用账号</div>
                <p className="text-xs text-muted-foreground">
                  即使多账号站点中的备用账号当前未处于激活态，后台仍监测其登录态有效期
                </p>
              </div>
              <Switch
                checked={effectiveExpiryWarning.includeInactiveTracks}
                disabled={!effectiveExpiryWarning.enabled || savingKey === 'expiryWarning' || status.locked}
                onCheckedChange={v =>
                  void updateExpiryWarning({ includeInactiveTracks: v }, '监控非激活备用账号过期状态')
                }
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Global Keyboard Shortcuts (chrome.commands) */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Keyboard className="h-5 w-5 text-primary" />
                全局快捷键（chrome.commands）
              </CardTitle>
              <CardDescription>
                无需打开弹窗即可在任意网页快速轮换多账号、同步当前站点或复制 curl 请求 Cookie。
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loadingCommands}
                onClick={() => void loadBrowserCommands()}>
                {loadingCommands ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                刷新快捷键
              </Button>
              <Button type="button" size="sm" onClick={openBrowserShortcutsPage}>
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                前往浏览器快捷键设置修改
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-border rounded-xl border border-border">
            {orderedCommands.map(cmd => {
              const meta = COMMAND_METADATA[cmd.name];
              return (
                <div key={cmd.name} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <span>{meta?.title || cmd.description || cmd.name}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {cmd.name}
                      </code>
                    </div>
                    <p className="text-xs text-muted-foreground">{meta?.description || cmd.description || ''}</p>
                  </div>
                  <Badge variant={cmd.shortcut ? 'secondary' : 'outline'} className="font-mono text-xs">
                    {cmd.shortcut || '未绑定'}
                  </Badge>
                </div>
              );
            })}
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

      {/* UI Simplicity, Onboarding Guides & Notification Banner Preferences */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-5 w-5 text-primary" />
            界面简洁度、新手引导与提示设置
          </CardTitle>
          <CardDescription>
            控制 Popup 简洁/开发者视图、新手引导卡片以及控制台风险提示横幅（修改后跨窗口实时生效）。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="divide-y divide-border rounded-xl border border-border">
            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">Popup 常驻显示开发者工具视图</div>
                <p className="text-xs text-muted-foreground">
                  默认关闭（简洁模式，仅展示开启同步与切号核心操作）；开启后常驻显示单站上传/拉取、cURL/Playwright
                  调试导出与跨环境注入入口
                </p>
              </div>
              <Switch
                checked={uxPrefs.popupDeveloperMode}
                onCheckedChange={v => {
                  void updateUxPrefs({ popupDeveloperMode: v });
                  toast.success(v ? '已开启 Popup 开发者完整视图' : '已切换为 Popup 简洁视图');
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">配置向导默认开启专家模式</div>
                <p className="text-xs text-muted-foreground">
                  开启后在首次配置向导中默认展开空间 ID、Region、寻址签名及全部底层同步策略开关
                </p>
              </div>
              <Switch
                checked={uxPrefs.onboardingExpertMode}
                onCheckedChange={v => {
                  void updateUxPrefs({ onboardingExpertMode: v });
                  toast.success(v ? '向导已默认启用专家模式' : '向导已恢复极简模式');
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium">显示安全与权限风险提示</div>
                <p className="text-xs text-muted-foreground">
                  显示凭据同步安全须知、密码复用提醒与共享存储凭据权限提示
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
                <div className="text-sm font-medium">显示存储兼容降级提示</div>
                <p className="text-xs text-muted-foreground">
                  当存储后端运行在单写者追加兼容模式或触发滚动令牌阻尼保护时显示提醒横幅
                </p>
              </div>
              <Switch
                checked={bannerPrefs.showDegradedWarnings}
                onCheckedChange={v => {
                  void setShowDegradedWarnings(v);
                  toast.success(v ? '已开启存储兼容降级提示' : '已关闭存储兼容降级提示');
                }}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 px-4 py-3">
            <span className="text-xs text-muted-foreground">
              {dismissedCount > 0
                ? `您已手动关闭 ${dismissedCount} 条提示横幅。也可随时重看新手上手清单与弹窗引导。`
                : '可随时重新打开控制中心的新手 3 分钟上手清单与 Popup 快速引导气泡。'}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  await resetGuideProgress();
                  toast.success('已恢复新手上手清单与 Popup 快速引导气泡');
                }}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                恢复新手清单与引导
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  await restoreAllBanners();
                  toast.success('已恢复所有已关闭的提示横幅');
                }}>
                恢复已关闭提示横幅
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
