import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import type { RulesAndBlacklistData } from '@console/lib/api';
import {
  copyToClipboard,
  downloadJsonFile,
  formatRelativeTime,
  getDirectionLabel,
  getMatchTypeLabel,
} from '@console/lib/format';
import type {
  BlacklistEntry,
  BrowserCandidateSite,
  EnvCookieSyncRule,
  SiteRuleOverride,
  SiteSummaryView,
  SyncDirection,
  SyncRuleUpdatePayload,
} from '@sessionmesh/shared';
import { Button, Input, Label, Switch } from '@sessionmesh/ui';
import {
  ArrowLeftRight,
  Ban,
  Copy,
  Download,
  Globe,
  Laptop,
  Link2,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
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
  layout?: 'compact' | 'wide';
  initialSubView?: RulesSubView;
}

type RulesSubView = 'blacklist' | 'env_sync' | 'overrides' | 'sso';

export const RulesTab: React.FC<RulesTabProps> = ({
  globalSearch,
  onStatusChanged,
  refreshSignal,
  layout = 'compact',
  initialSubView = 'blacklist',
}) => {
  const [data, setData] = useState<RulesAndBlacklistData>({
    spaceBlacklist: [],
    deviceBlacklist: [],
    siteOverrides: {},
    ssoGroups: [],
    envSyncRules: [],
  });
  const [managedSites, setManagedSites] = useState<SiteSummaryView[]>([]);
  const [candidateSites, setCandidateSites] = useState<BrowserCandidateSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [subView, setSubView] = useState<RulesSubView>(initialSubView);
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

  // Add / Edit Dev/Prod Env Sync Rule Form
  const [editingEnvId, setEditingEnvId] = useState<string | null>(null);
  const [envName, setEnvName] = useState('');
  const [envScope, setEnvScope] = useState<'device' | 'space'>('device');
  const [envSourceSiteKey, setEnvSourceSiteKey] = useState('');
  const [envSourceTrackId, setEnvSourceTrackId] = useState('');
  const [envTargetUrl, setEnvTargetUrl] = useState('http://localhost:3000');
  const [envSyncLs, setEnvSyncLs] = useState(true);
  const [envAdaptHttp, setEnvAdaptHttp] = useState(true);
  const [envCleanTarget, setEnvCleanTarget] = useState(true);
  const [envAutoSync, setEnvAutoSync] = useState(true);
  const [envAutoReload, setEnvAutoReload] = useState(false);
  const [envIncludeNames, setEnvIncludeNames] = useState('');
  const [envExcludeNames, setEnvExcludeNames] = useState('');

  const resetEnvForm = () => {
    setEditingEnvId(null);
    setEnvName('');
    setEnvScope('device');
    setEnvSourceSiteKey('');
    setEnvSourceTrackId('');
    setEnvTargetUrl('http://localhost:3000');
    setEnvSyncLs(true);
    setEnvAdaptHttp(true);
    setEnvCleanTarget(true);
    setEnvAutoSync(true);
    setEnvAutoReload(false);
    setEnvIncludeNames('');
    setEnvExcludeNames('');
  };

  const startEditEnvRule = (rule: EnvCookieSyncRule) => {
    setEditingEnvId(rule.id);
    setEnvName(rule.name);
    setEnvScope(rule.scope);
    setEnvSourceSiteKey(rule.sourceHostFilter || rule.sourceSiteKey);
    setEnvSourceTrackId(rule.sourceTrackId || '');
    setEnvTargetUrl(rule.targetUrl);
    setEnvSyncLs(rule.syncLocalStorage);
    setEnvAdaptHttp(rule.adaptForHttp);
    setEnvCleanTarget(rule.cleanTargetBeforeSync);
    setEnvAutoSync(rule.autoSync);
    setEnvAutoReload(rule.autoReloadTarget);
    setEnvIncludeNames((rule.includeCookieNames ?? []).join(', '));
    setEnvExcludeNames((rule.excludeCookieNames ?? []).join(', '));
  };

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const [res, overview, candidates] = await Promise.all([
        sidePanelApi.getRulesAndBlacklist(),
        sidePanelApi.getSitesOverview().catch(() => [] as SiteSummaryView[]),
        sidePanelApi.scanBrowserCandidateSites().catch(() => [] as BrowserCandidateSite[]),
      ]);
      setData({
        spaceBlacklist: res?.spaceBlacklist || [],
        deviceBlacklist: res?.deviceBlacklist || [],
        siteOverrides: res?.siteOverrides || {},
        ssoGroups: res?.ssoGroups || [],
        envSyncRules: res?.envSyncRules || [],
      });
      setManagedSites((overview || []).filter(s => s.binding.state !== 'BLACKLISTED'));
      setCandidateSites((candidates || []).filter(c => !c.blacklisted && c.cookieCount > 0));
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

  const handleAddEnvSyncRule = async (e: React.FormEvent, executeImmediately = true) => {
    e.preventDefault();
    const src = envSourceSiteKey.trim().toLowerCase();
    const dst = envTargetUrl.trim();
    if (!src || !dst) {
      toast.warning('请填写源站点域名与目标环境地址（如 http://localhost:3000）');
      return;
    }
    setBusyKey('add-env');
    try {
      const includeCookieNames = envIncludeNames
        .split(/[,，\s]+/)
        .map(s => s.trim())
        .filter(Boolean);
      const excludeCookieNames = envExcludeNames
        .split(/[,，\s]+/)
        .map(s => s.trim())
        .filter(Boolean);

      const saved = await sidePanelApi.upsertEnvSyncRule({
        id: editingEnvId || undefined,
        name: envName.trim() || undefined,
        scope: envScope,
        enabled: true,
        sourceSiteKey: src,
        sourceTrackId: envSourceTrackId || undefined,
        targetUrl: dst,
        syncCookies: true,
        syncLocalStorage: envSyncLs,
        adaptForHttp: envAdaptHttp,
        cleanTargetBeforeSync: envCleanTarget,
        autoSync: envAutoSync,
        autoReloadTarget: envAutoReload,
        includeCookieNames: includeCookieNames.length > 0 ? includeCookieNames : undefined,
        excludeCookieNames: excludeCookieNames.length > 0 ? excludeCookieNames : undefined,
      });

      if (executeImmediately) {
        const res = await sidePanelApi.executeEnvSync({ ruleId: saved.id });
        toast.success(
          `${editingEnvId ? '已更新' : '已保存'}映射并同步 ${res.appliedCookies} 条 Cookie 到 ${res.targetHost}`,
        );
      } else {
        toast.success(`${editingEnvId ? '已更新' : '已保存'}环境同步映射：${saved.name}`);
      }
      resetEnvForm();
      await loadRules();
      await onStatusChanged();
    } catch (err) {
      toast.error(`保存环境映射失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleExecuteEnvRule = async (rule: EnvCookieSyncRule, reverse = false) => {
    setBusyKey(`exec-env:${rule.id}`);
    try {
      const res = await sidePanelApi.executeEnvSync({ ruleId: rule.id, reverse });
      const lsHint = res.appliedLocalStorage > 0 ? `、${res.appliedLocalStorage} 项 LS` : '';
      toast.success(
        `${reverse ? '反向' : '环境'}同步完成：写入 ${res.appliedCookies} 条 Cookie${lsHint}${
          res.failedCookies > 0 ? `（失败 ${res.failedCookies} 条）` : ''
        }`,
      );
      await loadRules();
      await onStatusChanged();
    } catch (err) {
      toast.error(`执行同步失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleEnvRuleEnabled = async (rule: EnvCookieSyncRule, enabled: boolean) => {
    setBusyKey(`toggle-env:${rule.id}`);
    try {
      await sidePanelApi.upsertEnvSyncRule({ ...rule, enabled });
      await loadRules();
    } catch (err) {
      toast.error(`更新状态失败：${extractErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemoveEnvRule = async (rule: EnvCookieSyncRule) => {
    setBusyKey(`rm-env:${rule.id}`);
    try {
      await sidePanelApi.removeEnvSyncRule(rule.id, rule.scope);
      toast.success(`已删除环境同步规则：${rule.name}`);
      await loadRules();
    } catch (err) {
      toast.error(`删除规则失败：${extractErrorMessage(err)}`);
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
      envSyncRules: Array.isArray(spaceRules.envSyncRules)
        ? (spaceRules.envSyncRules as EnvCookieSyncRule[])
        : undefined,
      deviceEnvSyncRules: Array.isArray(raw.deviceEnvSyncRules)
        ? (raw.deviceEnvSyncRules as EnvCookieSyncRule[])
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
  const filteredEnvRules = data.envSyncRules.filter(
    r =>
      !query ||
      r.name.toLowerCase().includes(query) ||
      r.sourceSiteKey.toLowerCase().includes(query) ||
      r.targetUrl.toLowerCase().includes(query),
  );
  const selectedSourceSiteSummary = (() => {
    const cleaned = envSourceSiteKey
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split(/[/?#]/)[0]
      .replace(/:\d+$/, '')
      .replace(/^\.+/, '');
    if (!cleaned) return undefined;
    const exact = managedSites.find(s => s.siteKey === cleaned);
    if (exact) return exact;
    let best: SiteSummaryView | undefined;
    for (const s of managedSites) {
      if (cleaned.endsWith(`.${s.siteKey}`) && (!best || s.siteKey.length > best.siteKey.length)) {
        best = s;
      }
    }
    return best;
  })();

  return (
    <div className={layout === 'wide' ? 'space-y-4' : 'flex h-full flex-col'}>
      {/* Sub-view Bar & Import/Export */}
      <div
        className={
          layout === 'wide'
            ? 'flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-2.5'
            : 'shrink-0 border-b border-border bg-card/50 px-3 py-2 flex flex-wrap items-center justify-between gap-2'
        }>
        <div className="flex flex-wrap items-center gap-1">
          {(
            [
              ['blacklist', `黑名单 (${data.spaceBlacklist.length + data.deviceBlacklist.length})`],
              ['env_sync', `环境同步 (${data.envSyncRules.length})`],
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
      <div className={layout === 'wide' ? 'space-y-4' : 'flex-1 overflow-y-auto p-3 space-y-3'}>
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

            {/* Space-level & Device-level Blacklists */}
            <div className={layout === 'wide' ? 'grid gap-4 lg:grid-cols-2 items-start' : 'space-y-3'}>
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
            </div>
          </>
        ) : subView === 'env_sync' ? (
          <>
            {/* Add Dev <-> Prod Env Cookie Sync Rule Form */}
            <form
              onSubmit={e => void handleAddEnvSyncRule(e, true)}
              className="rounded-xl border border-border bg-card p-3 space-y-2.5 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-foreground">
                <ArrowLeftRight className="h-3.5 w-3.5 text-primary" />
                开发与生产环境 Cookie 数据同步（自动适配 localhost / HTTP 属性）
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">源环境站点 (生产 / UAT) *</Label>
                  <Input
                    list="sidepanel-managed-sites-datalist"
                    value={envSourceSiteKey}
                    onChange={e => {
                      setEnvSourceSiteKey(e.target.value);
                      setEnvSourceTrackId('');
                    }}
                    placeholder="如 example.com"
                    className="h-8 text-xs font-mono"
                  />
                  <datalist id="sidepanel-managed-sites-datalist">
                    {managedSites.map(s => (
                      <option key={`m-${s.siteKey}`} value={s.siteKey}>
                        {s.cookieCount} Cookie (已托管)
                      </option>
                    ))}
                    {candidateSites
                      .filter(c => !managedSites.some(m => m.siteKey === c.siteKey))
                      .map(c => (
                        <option key={`c-${c.siteKey}`} value={c.siteKey}>
                          {c.cookieCount} Cookie (本机已登录)
                        </option>
                      ))}
                  </datalist>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">绑定源账号轨道</Label>
                  <select
                    value={envSourceTrackId}
                    onChange={e => setEnvSourceTrackId(e.target.value)}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground">
                    <option value="">跟随源站当前激活账号</option>
                    {(selectedSourceSiteSummary?.allTracks ?? []).map(tr => (
                      <option key={tr.trackId} value={tr.trackId}>
                        固定：{tr.label} ({tr.cookieCount}条)
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-[11px]">目标开发/测试环境地址 *</Label>
                  <div className="flex items-center gap-1">
                    {['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:8080'].map(preset => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setEnvTargetUrl(preset)}
                        className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground">
                        {preset.replace('http://', '')}
                      </button>
                    ))}
                  </div>
                </div>
                <Input
                  value={envTargetUrl}
                  onChange={e => setEnvTargetUrl(e.target.value)}
                  placeholder="如 http://localhost:3000 或 https://dev.example.local"
                  className="h-8 text-xs font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">规则名称（可选）</Label>
                  <Input
                    value={envName}
                    onChange={e => setEnvName(e.target.value)}
                    placeholder="如 主站生产 -> 本地 3000"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">同步范围</Label>
                  <select
                    value={envScope}
                    onChange={e => setEnvScope(e.target.value as 'device' | 'space')}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground">
                    <option value="device">仅本机生效（推荐本地端口）</option>
                    <option value="space">空间级（全设备加密同步规则）</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={envIncludeNames}
                  onChange={e => setEnvIncludeNames(e.target.value)}
                  placeholder="仅同步指定键名(逗号分隔,留空全量)"
                  className="h-7 text-[11px] font-mono"
                />
                <Input
                  value={envExcludeNames}
                  onChange={e => setEnvExcludeNames(e.target.value)}
                  placeholder="排除指定键名(逗号分隔,可选)"
                  className="h-7 text-[11px] font-mono"
                />
              </div>

              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/25 px-2.5 py-2">
                <div className="flex items-center gap-1.5">
                  <Switch
                    id="sp-env-http"
                    className="scale-75"
                    checked={envAdaptHttp}
                    onCheckedChange={setEnvAdaptHttp}
                  />
                  <Label htmlFor="sp-env-http" className="text-[11px] cursor-pointer">
                    HTTP 适配(去 Secure/调 SameSite)
                  </Label>
                </div>
                <div className="flex items-center gap-1.5">
                  <Switch id="sp-env-ls" className="scale-75" checked={envSyncLs} onCheckedChange={setEnvSyncLs} />
                  <Label htmlFor="sp-env-ls" className="text-[11px] cursor-pointer">
                    同步 LocalStorage
                  </Label>
                </div>
                <div className="flex items-center gap-1.5">
                  <Switch
                    id="sp-env-auto"
                    className="scale-75"
                    checked={envAutoSync}
                    onCheckedChange={setEnvAutoSync}
                  />
                  <Label htmlFor="sp-env-auto" className="text-[11px] cursor-pointer">
                    源站变更/轮换自动跟随
                  </Label>
                </div>
                <div className="flex items-center gap-1.5">
                  <Switch
                    id="sp-env-clean"
                    className="scale-75"
                    checked={envCleanTarget}
                    onCheckedChange={setEnvCleanTarget}
                  />
                  <Label htmlFor="sp-env-clean" className="text-[11px] cursor-pointer">
                    清理目标残留旧 Cookie
                  </Label>
                </div>
                <div className="flex items-center gap-1.5">
                  <Switch
                    id="sp-env-reload"
                    className="scale-75"
                    checked={envAutoReload}
                    onCheckedChange={setEnvAutoReload}
                  />
                  <Label htmlFor="sp-env-reload" className="text-[11px] cursor-pointer">
                    自动刷新目标页
                  </Label>
                </div>
              </div>

              <div className="flex justify-end gap-1.5">
                {editingEnvId ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={resetEnvForm}>
                    取消编辑
                  </Button>
                ) : null}
                <Button type="submit" size="sm" className="h-7 px-3 text-xs" disabled={busyKey === 'add-env'}>
                  {busyKey === 'add-env' ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="mr-1 h-3.5 w-3.5" />
                  )}
                  {editingEnvId ? '更新映射并同步' : '保存映射并立即同步'}
                </Button>
              </div>
            </form>

            {/* Saved Env Sync Rules List */}
            {filteredEnvRules.length === 0 ? (
              <EmptyState
                icon={<ArrowLeftRight className="h-5 w-5" />}
                title="暂无开发/生产环境同步规则"
                description="将线上或测试环境的登录态 Cookie 与 LocalStorage 自动重写映射至 localhost / 本地测试域名，支持绑定指定账号或跟随多账号轮换。"
              />
            ) : (
              <div className="space-y-2">
                {filteredEnvRules.map(rule => (
                  <div key={rule.id} className="rounded-xl border border-border bg-card p-3 text-xs space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-foreground">{rule.name}</span>
                          <StatusBadge tone={rule.scope === 'space' ? 'primary' : 'info'}>
                            {rule.scope === 'space' ? '全空间' : '仅本机'}
                          </StatusBadge>
                          {rule.autoSync ? <StatusBadge tone="success">自动跟随</StatusBadge> : null}
                        </div>
                        <p className="font-mono text-[11px] text-muted-foreground break-all">
                          {rule.sourceHostFilter || rule.sourceSiteKey} → {rule.targetUrl}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {rule.lastSyncedAt
                            ? `上次同步：${formatRelativeTime(rule.lastSyncedAt)}（${rule.lastSyncedCount ?? 0} 项）`
                            : '尚未执行'}
                        </p>
                      </div>
                      <Switch
                        className="scale-75 shrink-0"
                        checked={rule.enabled}
                        onCheckedChange={checked => void handleToggleEnvRuleEnabled(rule, checked)}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1 border-t border-border/60">
                      <div className="flex flex-wrap gap-1">
                        {rule.adaptForHttp ? <StatusBadge tone="neutral">HTTP适配</StatusBadge> : null}
                        {rule.syncLocalStorage ? <StatusBadge tone="neutral">含LS</StatusBadge> : null}
                        {rule.cleanTargetBeforeSync ? <StatusBadge tone="neutral">清理旧项</StatusBadge> : null}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="default"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          disabled={busyKey === `exec-env:${rule.id}`}
                          onClick={() => void handleExecuteEnvRule(rule, false)}>
                          <Play className="mr-1 h-3 w-3" />
                          同步
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          disabled={busyKey === `exec-env:${rule.id}`}
                          onClick={() => void handleExecuteEnvRule(rule, true)}
                          title="从目标环境反向写回源环境">
                          反向
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-foreground"
                          onClick={() => startEditEnvRule(rule)}
                          title="编辑环境同步规则">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-rose-600 hover:bg-rose-500/10"
                          title="删除环境同步规则"
                          disabled={busyKey === `rm-env:${rule.id}`}
                          onClick={() => void handleRemoveEnvRule(rule)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
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
