import { extractErrorMessage, sidePanelApi } from '@src/lib/api';
import type { RulesAndBlacklistData } from '@src/lib/api';
import { useBannerPrefs } from '@src/lib/bannerPrefs';
import {
  copyToClipboard,
  downloadJsonFile,
  formatRelativeTime,
  getDirectionLabel,
  getMatchTypeLabel,
} from '@src/lib/format';
import type { BlacklistEntry, SiteRuleOverride, SyncDirection, SyncRuleUpdatePayload } from '@sessionmesh/shared';
import { Button, Input, Label, Switch } from '@sessionmesh/ui';
import {
  Ban,
  Bell,
  Copy,
  Download,
  Globe,
  Laptop,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Shield,
  Sliders,
  Trash2,
  Upload,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from './common/Badge';
import { EmptyState } from './common/EmptyState';
import { JsonImportModal } from './common/JsonImportModal';

export interface RulesTabProps {
  globalSearch: string;
  onStatusChanged: () => Promise<void> | void;
  refreshSignal: number;
}

type RulesSubView = 'blacklist' | 'overrides' | 'sso';

export const RulesTab: React.FC<RulesTabProps> = ({ globalSearch, onStatusChanged, refreshSignal }) => {
  const [data, setData] = useState<RulesAndBlacklistData>({
    spaceBlacklist: [],
    deviceBlacklist: [],
    siteOverrides: {},
    ssoGroups: [],
  });
  const [loading, setLoading] = useState(true);
  const [subView, setSubView] = useState<RulesSubView>('blacklist');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // Add Blacklist Form
  const [blScope, setBlScope] = useState<'space' | 'device'>('space');
  const [blMatchType, setBlMatchType] = useState<BlacklistEntry['matchType']>('subdomain');
  const [blPattern, setBlPattern] = useState('');
  const [blReason, setBlReason] = useState('');

  // Add Site Override Form
  const [ovSiteKey, setOvSiteKey] = useState('');
  const [ovDirection, setOvDirection] = useState<SyncDirection>('bidirectional');
  const [ovSyncCookies, setOvSyncCookies] = useState(true);
  const [ovSyncLs, setOvSyncLs] = useState(true);
  const [ovAutoRefresh, setOvAutoRefresh] = useState(false);

  // Add SSO Group Form
  const [ssoName, setSsoName] = useState('');
  const [ssoPrimary, setSsoPrimary] = useState('');
  const [ssoDomains, setSsoDomains] = useState('');

  const {
    prefs: bannerPrefs,
    dismissedCount,
    hasSuppressedHints,
    setShowSecurityWarnings,
    setShowDegradedWarnings,
    restoreAllBanners,
  } = useBannerPrefs();

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await sidePanelApi.getRulesAndBlacklist();
      setData({
        spaceBlacklist: res?.spaceBlacklist || [],
        deviceBlacklist: res?.deviceBlacklist || [],
        siteOverrides: res?.siteOverrides || {},
        ssoGroups: res?.ssoGroups || [],
      });
    } catch (err) {
      toast.error(`加载规则失败：${extractErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules();
  }, [loadRules, refreshSignal]);

  const query = globalSearch.trim().toLowerCase();

  const handleAddBlacklist = async (e: React.FormEvent) => {
    e.preventDefault();
    const pattern = blPattern.trim();
    if (!pattern) {
      toast.warning('请输入要拉黑的域名、通配符或 Origin');
      return;
    }
    setBusyKey('add-bl');
    try {
      await sidePanelApi.addBlacklistEntry({
        pattern,
        matchType: blMatchType,
        scope: blScope,
        reason: blReason.trim() || undefined,
        presetCategory: 'custom',
      });
      toast.success(`已添加至${blScope === 'space' ? '空间级' : '本机级'}黑名单：${pattern}`);
      setBlPattern('');
      setBlReason('');
      await loadRules();
      await onStatusChanged();
    } catch (err) {
      toast.error(`添加失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemoveBlacklist = async (entry: BlacklistEntry) => {
    setBusyKey(`rm-bl:${entry.id}`);
    try {
      await sidePanelApi.removeBlacklistEntry(entry.id, entry.scope);
      toast.success(`已移出黑名单：${entry.pattern}`);
      await loadRules();
      await onStatusChanged();
    } catch (err) {
      toast.error(`移除失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleUpsertOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    const siteKey = ovSiteKey.trim().toLowerCase();
    if (!siteKey) {
      toast.warning('请输入站点域名 (siteKey)');
      return;
    }
    setBusyKey('add-ov');
    try {
      const rule: SiteRuleOverride = {
        siteKey,
        pattern: siteKey,
        direction: ovDirection,
        syncCookies: ovSyncCookies,
        syncLocalStorage: ovSyncLs,
        autoRefresh: ovAutoRefresh,
        updatedAt: Date.now(),
      };
      await sidePanelApi.upsertSiteRule(rule);
      toast.success(`已保存站点策略：${siteKey} (${getDirectionLabel(ovDirection)})`);
      setOvSiteKey('');
      await loadRules();
      await onStatusChanged();
    } catch (err) {
      toast.error(`保存站点规则失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleQuickDirectionChange = async (rule: SiteRuleOverride, direction: SyncDirection) => {
    setBusyKey(`ov:${rule.siteKey}`);
    try {
      await sidePanelApi.upsertSiteRule({ ...rule, direction, updatedAt: Date.now() });
      toast.success(`${rule.siteKey} 已更新为「${getDirectionLabel(direction)}」`);
      await loadRules();
    } catch (err) {
      toast.error(`更新失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemoveOverride = async (siteKey: string) => {
    setBusyKey(`rm-ov:${siteKey}`);
    try {
      await sidePanelApi.removeSiteRule(siteKey);
      toast.success(`已恢复 ${siteKey} 使用空间默认规则`);
      await loadRules();
    } catch (err) {
      toast.error(`删除失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleAddSsoGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = ssoName.trim();
    const primarySiteKey = ssoPrimary.trim().toLowerCase();
    const domains = ssoDomains
      .split(/[,，\s]+/)
      .map(d => d.trim().toLowerCase())
      .filter(Boolean);
    if (!name || !primarySiteKey || domains.length === 0) {
      toast.warning('请完整填写组名称、主站域名及关联域名列表');
      return;
    }
    setBusyKey('add-sso');
    try {
      await sidePanelApi.upsertSsoGroup({
        groupId: `sso_${Date.now()}`,
        name,
        primarySiteKey,
        domains: Array.from(new Set([primarySiteKey, ...domains])),
      });
      toast.success(`已添加跨主域 SSO 关联组：${name}`);
      setSsoName('');
      setSsoPrimary('');
      setSsoDomains('');
      await loadRules();
    } catch (err) {
      toast.error(`添加失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemoveSsoGroup = async (groupId: string) => {
    setBusyKey(`rm-sso:${groupId}`);
    try {
      await sidePanelApi.removeSsoGroup(groupId);
      toast.success('已删除 SSO 关联组');
      await loadRules();
    } catch (err) {
      toast.error(`删除失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleExportRules = async (copyOnly = false) => {
    setBusyKey('export-rules');
    try {
      const jsonText = await sidePanelApi.exportRulesJson();
      if (copyOnly) {
        const ok = await copyToClipboard(jsonText);
        if (ok) toast.success('已复制规则 JSON 到剪贴板');
        else toast.error('复制失败');
      } else {
        downloadJsonFile('sessionmesh-rules.json', jsonText);
        toast.success('已导出规则 JSON 文件');
      }
    } catch (err) {
      toast.error(`导出规则失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleImportRules = async (parsed: unknown) => {
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('规则 JSON 必须是对象格式');
    }
    const raw = parsed as Record<string, unknown>;
    const spaceRules = (raw.spaceRules && typeof raw.spaceRules === 'object' ? raw.spaceRules : raw) as Record<
      string,
      unknown
    >;
    const payload: SyncRuleUpdatePayload = {
      spaceBlacklist: Array.isArray(spaceRules.spaceBlacklist)
        ? (spaceRules.spaceBlacklist as BlacklistEntry[])
        : undefined,
      deviceBlacklist: Array.isArray(raw.deviceBlacklist) ? (raw.deviceBlacklist as BlacklistEntry[]) : undefined,
      siteOverrides:
        spaceRules.siteOverrides && typeof spaceRules.siteOverrides === 'object'
          ? (spaceRules.siteOverrides as Record<string, SiteRuleOverride>)
          : undefined,
      ssoGroups: Array.isArray(spaceRules.ssoGroups)
        ? (spaceRules.ssoGroups as RulesAndBlacklistData['ssoGroups'])
        : undefined,
    };
    await sidePanelApi.importRulesJson(payload);
    toast.success('规则与黑名单导入成功');
    await loadRules();
    await onStatusChanged();
  };

  const filteredSpaceBl = data.spaceBlacklist.filter(
    e => !query || e.pattern.toLowerCase().includes(query) || (e.reason || '').toLowerCase().includes(query),
  );
  const filteredDeviceBl = data.deviceBlacklist.filter(
    e => !query || e.pattern.toLowerCase().includes(query) || (e.reason || '').toLowerCase().includes(query),
  );
  const overridesList = Object.values(data.siteOverrides)
    .filter(r => !query || r.siteKey.toLowerCase().includes(query) || r.pattern.toLowerCase().includes(query))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const filteredSsoGroups = data.ssoGroups.filter(
    g =>
      !query ||
      g.name.toLowerCase().includes(query) ||
      g.primarySiteKey.toLowerCase().includes(query) ||
      g.domains.some(d => d.toLowerCase().includes(query)),
  );

  return (
    <div className="flex h-full flex-col">
      {/* Sub-view Bar & Import/Export */}
      <div className="shrink-0 border-b border-border bg-card/50 px-3 py-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {(
            [
              ['blacklist', `双层黑名单 (${data.spaceBlacklist.length + data.deviceBlacklist.length})`],
              ['overrides', `单站方向 (${Object.keys(data.siteOverrides).length})`],
              ['sso', `SSO 组 (${data.ssoGroups.length})`],
            ] as Array<[RulesSubView, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSubView(key)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                subView === key
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}>
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setImportOpen(true)}>
            <Upload className="mr-1 h-3 w-3" />
            导入
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={busyKey === 'export-rules'}
            onClick={() => handleExportRules(false)}>
            <Download className="mr-1 h-3 w-3" />
            导出
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={() => handleExportRules(true)}
            title="复制规则 JSON">
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={loadRules} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {subView === 'blacklist' ? (
          <>
            {/* Add Blacklist Entry Form */}
            <form
              onSubmit={handleAddBlacklist}
              className="rounded-xl border border-border bg-card p-3 space-y-2.5 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-foreground">
                <Ban className="h-3.5 w-3.5 text-rose-500" />
                新增黑名单规则（黑名单优先，彻底阻断扫描、上传与覆写）
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">生效层级</Label>
                  <select
                    value={blScope}
                    onChange={e => setBlScope(e.target.value as 'space' | 'device')}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground">
                    <option value="space">空间级（全空间设备同步）</option>
                    <option value="device">本机级（仅当前电脑）</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">匹配模式</Label>
                  <select
                    value={blMatchType}
                    onChange={e => setBlMatchType(e.target.value as BlacklistEntry['matchType'])}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground">
                    <option value="subdomain">含子域名 (subdomain)</option>
                    <option value="exact_domain">精确域名 (exact_domain)</option>
                    <option value="wildcard">通配符 (wildcard)</option>
                    <option value="origin">精确 Origin (origin)</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={blPattern}
                  onChange={e => setBlPattern(e.target.value)}
                  placeholder={
                    blMatchType === 'origin'
                      ? 'https://admin.example.com:8443'
                      : blMatchType === 'wildcard'
                        ? '*bank*.com'
                        : 'bank.example.com'
                  }
                  className="h-8 text-xs font-mono"
                />
                <Input
                  value={blReason}
                  onChange={e => setBlReason(e.target.value)}
                  placeholder="备注原因（可选，如网银/内网）"
                  className="h-8 text-xs"
                />
              </div>
              <div className="flex justify-end">
                <Button type="submit" size="sm" className="h-7 px-3 text-xs" disabled={busyKey === 'add-bl'}>
                  {busyKey === 'add-bl' ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="mr-1 h-3.5 w-3.5" />
                  )}
                  添加黑名单
                </Button>
              </div>
            </form>

            {/* Space-level Blacklist */}
            <section className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <Globe className="h-3.5 w-3.5 text-primary" />
                  空间级黑名单 ({filteredSpaceBl.length})
                </div>
                <StatusBadge tone="primary">全设备加密同步</StatusBadge>
              </div>
              {filteredSpaceBl.length === 0 ? (
                <p className="p-3 text-center text-xs text-muted-foreground">暂无空间级黑名单规则</p>
              ) : (
                <div className="divide-y divide-border/70">
                  {filteredSpaceBl.map(entry => (
                    <div key={entry.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <code className="font-mono font-medium text-foreground break-all">{entry.pattern}</code>
                          <StatusBadge tone="neutral">{getMatchTypeLabel(entry.matchType)}</StatusBadge>
                          {entry.presetCategory && entry.presetCategory !== 'custom' ? (
                            <StatusBadge tone="info">预设: {entry.presetCategory}</StatusBadge>
                          ) : null}
                        </div>
                        {entry.reason ? (
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{entry.reason}</p>
                        ) : null}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-rose-600 hover:bg-rose-500/10"
                        disabled={busyKey === `rm-bl:${entry.id}`}
                        onClick={() => handleRemoveBlacklist(entry)}
                        title="移出空间级黑名单">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Device-level Blacklist */}
            <section className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <Laptop className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
                  本机级黑名单 ({filteredDeviceBl.length})
                </div>
                <StatusBadge tone="info">仅本电脑生效</StatusBadge>
              </div>
              {filteredDeviceBl.length === 0 ? (
                <p className="p-3 text-center text-xs text-muted-foreground">暂无本机级黑名单规则</p>
              ) : (
                <div className="divide-y divide-border/70">
                  {filteredDeviceBl.map(entry => (
                    <div key={entry.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <code className="font-mono font-medium text-foreground break-all">{entry.pattern}</code>
                          <StatusBadge tone="neutral">{getMatchTypeLabel(entry.matchType)}</StatusBadge>
                        </div>
                        {entry.reason ? (
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{entry.reason}</p>
                        ) : null}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-rose-600 hover:bg-rose-500/10"
                        disabled={busyKey === `rm-bl:${entry.id}`}
                        onClick={() => handleRemoveBlacklist(entry)}
                        title="移出本机级黑名单">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : subView === 'overrides' ? (
          <>
            {/* Add Site Override Form */}
            <form
              onSubmit={handleUpsertOverride}
              className="rounded-xl border border-border bg-card p-3 space-y-2.5 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-foreground">
                <Sliders className="h-3.5 w-3.5 text-primary" />
                新增或覆盖单站同步方向策略
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">站点主域 (siteKey)</Label>
                  <Input
                    value={ovSiteKey}
                    onChange={e => setOvSiteKey(e.target.value)}
                    placeholder="例如 github.com"
                    className="h-8 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">同步方向</Label>
                  <select
                    value={ovDirection}
                    onChange={e => setOvDirection(e.target.value as SyncDirection)}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground">
                    <option value="bidirectional">双向同步 (bidirectional)</option>
                    <option value="push_only">仅上传 (push_only)</option>
                    <option value="pull_only">仅下载 (pull_only)</option>
                    <option value="disabled">禁用同步 (disabled)</option>
                    <option value="inherit">继承空间默认 (inherit)</option>
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-muted/25 px-2.5 py-2">
                <div className="flex items-center gap-1.5">
                  <Switch
                    id="ov-sync-cookies"
                    className="scale-75"
                    checked={ovSyncCookies}
                    onCheckedChange={setOvSyncCookies}
                  />
                  <Label htmlFor="ov-sync-cookies" className="text-xs cursor-pointer">
                    同步 Cookie
                  </Label>
                </div>
                <div className="flex items-center gap-1.5">
                  <Switch id="ov-sync-ls" className="scale-75" checked={ovSyncLs} onCheckedChange={setOvSyncLs} />
                  <Label htmlFor="ov-sync-ls" className="text-xs cursor-pointer">
                    同步 LocalStorage
                  </Label>
                </div>
                <div className="flex items-center gap-1.5">
                  <Switch
                    id="ov-auto-refresh"
                    className="scale-75"
                    checked={ovAutoRefresh}
                    onCheckedChange={setOvAutoRefresh}
                  />
                  <Label htmlFor="ov-auto-refresh" className="text-xs cursor-pointer">
                    允许自动刷新
                  </Label>
                </div>
              </div>
              <div className="flex justify-end">
                <Button type="submit" size="sm" className="h-7 px-3 text-xs" disabled={busyKey === 'add-ov'}>
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  保存站点覆盖策略
                </Button>
              </div>
            </form>

            {/* Site Override List */}
            {overridesList.length === 0 ? (
              <EmptyState
                icon={<Shield className="h-5 w-5" />}
                title="暂无单站方向覆盖规则"
                description="所有非黑名单站点默认遵循全局双向同步策略，可按需为特定站点配置仅上传、仅下载或禁用。"
              />
            ) : (
              <div className="space-y-2">
                {overridesList.map(rule => (
                  <div key={rule.siteKey} className="rounded-xl border border-border bg-card p-3 text-xs space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-mono font-semibold text-foreground">{rule.siteKey}</span>
                        <p className="text-[10px] text-muted-foreground">更新于 {formatRelativeTime(rule.updatedAt)}</p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <select
                          aria-label={`${rule.siteKey} 同步方向`}
                          value={rule.direction}
                          disabled={busyKey === `ov:${rule.siteKey}`}
                          onChange={e => handleQuickDirectionChange(rule, e.target.value as SyncDirection)}
                          className="h-7 rounded border border-input bg-background px-2 text-[11px] text-foreground">
                          <option value="bidirectional">双向同步</option>
                          <option value="push_only">仅上传</option>
                          <option value="pull_only">仅下载</option>
                          <option value="disabled">禁用</option>
                          <option value="inherit">继承默认</option>
                        </select>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-rose-600 hover:bg-rose-500/10"
                          disabled={busyKey === `rm-ov:${rule.siteKey}`}
                          onClick={() => handleRemoveOverride(rule.siteKey)}
                          title="删除覆盖规则">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <StatusBadge tone={rule.syncCookies ? 'success' : 'neutral'}>
                        Cookie: {rule.syncCookies ? '开' : '关'}
                      </StatusBadge>
                      <StatusBadge tone={rule.syncLocalStorage ? 'success' : 'neutral'}>
                        LocalStorage: {rule.syncLocalStorage ? '开' : '关'}
                      </StatusBadge>
                      <StatusBadge tone={rule.autoRefresh ? 'info' : 'neutral'}>
                        自动刷新: {rule.autoRefresh ? '开' : '关'}
                      </StatusBadge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {/* SSO Groups */}
            <form
              onSubmit={handleAddSsoGroup}
              className="rounded-xl border border-border bg-card p-3 space-y-2.5 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-foreground">
                <Link2 className="h-3.5 w-3.5 text-primary" />
                跨主域 SSO 关联组（将同一体系多主域聚合为同一站点轨道）
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={ssoName}
                  onChange={e => setSsoName(e.target.value)}
                  placeholder="组名称，如 Google SSO"
                  className="h-8 text-xs"
                />
                <Input
                  value={ssoPrimary}
                  onChange={e => setSsoPrimary(e.target.value)}
                  placeholder="主站 siteKey，如 google.com"
                  className="h-8 text-xs font-mono"
                />
              </div>
              <Input
                value={ssoDomains}
                onChange={e => setSsoDomains(e.target.value)}
                placeholder="关联域名列表，逗号分隔，如 google.com, youtube.com, gmail.com"
                className="h-8 text-xs font-mono"
              />
              <div className="flex justify-end">
                <Button type="submit" size="sm" className="h-7 px-3 text-xs" disabled={busyKey === 'add-sso'}>
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  添加 SSO 组
                </Button>
              </div>
            </form>

            {filteredSsoGroups.length === 0 ? (
              <EmptyState
                icon={<Link2 className="h-5 w-5" />}
                title="暂无自定义 SSO 关联组"
                description="当多个不同主域共享同一单点登录体系时，可在此合并归入同一同步轨道。"
              />
            ) : (
              <div className="space-y-2">
                {filteredSsoGroups.map(group => (
                  <div key={group.groupId} className="rounded-xl border border-border bg-card p-3 text-xs space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <span className="font-semibold text-foreground">{group.name}</span>
                        <span className="ml-2 text-[11px] text-muted-foreground">主域：{group.primarySiteKey}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-rose-600 hover:bg-rose-500/10"
                        disabled={busyKey === `rm-sso:${group.groupId}`}
                        onClick={() => handleRemoveSsoGroup(group.groupId)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {group.domains.map(d => (
                        <code
                          key={d}
                          className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
                          {d}
                        </code>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Shared Warning & Banner Visibility Preferences Card */}
        <section className="rounded-xl border border-border bg-card p-3 text-xs space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-semibold text-foreground">
              <Bell className="h-3.5 w-3.5 text-primary" />
              警告与提示横幅显示控制
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={!hasSuppressedHints}
              onClick={async () => {
                await restoreAllBanners();
                toast.success('已恢复显示所有已关闭的提示横幅');
              }}>
              <RotateCcw className="mr-1 h-3 w-3" />
              恢复已关闭提示{dismissedCount > 0 ? ` (${dismissedCount})` : ''}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-muted/25 px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <Switch
                id="rules-pref-security"
                className="scale-75"
                checked={bannerPrefs.showSecurityWarnings}
                onCheckedChange={checked => void setShowSecurityWarnings(checked)}
              />
              <Label htmlFor="rules-pref-security" className="text-xs cursor-pointer">
                显示安全风险提示
              </Label>
            </div>
            <div className="flex items-center gap-1.5">
              <Switch
                id="rules-pref-degraded"
                className="scale-75"
                checked={bannerPrefs.showDegradedWarnings}
                onCheckedChange={checked => void setShowDegradedWarnings(checked)}
              />
              <Label htmlFor="rules-pref-degraded" className="text-xs cursor-pointer">
                显示降级与阻尼提示
              </Label>
            </div>
          </div>
        </section>
      </div>

      <JsonImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="导入黑名单与同步规则 JSON"
        description="支持由 SessionMesh 导出的规则 JSON，将合并更新空间级黑名单、本机级黑名单及单站方向覆盖。"
        placeholder='{"spaceBlacklist": [], "deviceBlacklist": [], "siteOverrides": {}}'
        onImport={handleImportRules}
      />
    </div>
  );
};
