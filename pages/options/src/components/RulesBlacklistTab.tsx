import type {
  BlacklistEntry,
  SiteRuleOverride,
  SsoDomainGroup,
  SyncDirection,
  SyncStatusSummary,
} from '@sessionmesh/core';
import type { SyncRuleUpdatePayload } from '@sessionmesh/shared';
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
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@sessionmesh/ui';
import {
  Ban,
  Copy,
  Download,
  Globe,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  copyToClipboard,
  downloadJsonFile,
  extractErrorMessage,
  formatDateTime,
  useUiBannerPrefs,
} from '../utils/helpers';

interface RulesBlacklistTabProps {
  status: SyncStatusSummary;
}

interface RulesState {
  spaceBlacklist: BlacklistEntry[];
  deviceBlacklist: BlacklistEntry[];
  siteOverrides: Record<string, SiteRuleOverride>;
  ssoGroups: SsoDomainGroup[];
}

const MATCH_TYPE_LABELS: Record<BlacklistEntry['matchType'], string> = {
  exact_domain: '精确域名',
  subdomain: '子域名 (*.domain)',
  wildcard: '通配符',
  origin: '精确 Origin',
};

const DIRECTION_LABELS: Record<SyncDirection, string> = {
  inherit: '继承全局',
  bidirectional: '双向同步',
  push_only: '仅上传',
  pull_only: '仅拉取',
  disabled: '禁用同步',
};

export function RulesBlacklistTab({ status }: RulesBlacklistTabProps) {
  const { isBannerVisible, dismissBanner } = useUiBannerPrefs();
  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState<RulesState>({
    spaceBlacklist: [],
    deviceBlacklist: [],
    siteOverrides: {},
    ssoGroups: [],
  });

  // Add blacklist form
  const [blScope, setBlScope] = useState<'space' | 'device'>('space');
  const [blPattern, setBlPattern] = useState('');
  const [blMatchType, setBlMatchType] = useState<BlacklistEntry['matchType']>('subdomain');
  const [blReason, setBlReason] = useState('');
  const [addingBl, setAddingBl] = useState(false);

  // Add SSO group form
  const [ssoName, setSsoName] = useState('');
  const [ssoPrimary, setSsoPrimary] = useState('');
  const [ssoDomains, setSsoDomains] = useState('');
  const [savingSso, setSavingSso] = useState(false);

  // Add site override form
  const [ovSiteKey, setOvSiteKey] = useState('');
  const [ovDirection, setOvDirection] = useState<SyncDirection>('bidirectional');
  const [ovSyncCookies, setOvSyncCookies] = useState(true);
  const [ovSyncLs, setOvSyncLs] = useState(true);
  const [ovAutoRefresh, setOvAutoRefresh] = useState(false);
  const [savingOv, setSavingOv] = useState(false);

  // Import/Export modal
  const [importOpen, setImportOpen] = useState(false);
  const [importJsonText, setImportJsonText] = useState('');
  const [importing, setImporting] = useState(false);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await unwrapCommand<RulesState>({ type: 'GET_RULES_AND_BLACKLIST' });
      setRules({
        spaceBlacklist: res?.spaceBlacklist ?? [],
        deviceBlacklist: res?.deviceBlacklist ?? [],
        siteOverrides: res?.siteOverrides ?? {},
        ssoGroups: res?.ssoGroups ?? [],
      });
    } catch (err) {
      toast.error(`加载规则失败：${extractErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status.configured && !status.locked) {
      void fetchRules();
    }
  }, [status.configured, status.locked, status.activeSpaceId, fetchRules]);

  const handleAddBlacklist = async () => {
    if (!blPattern.trim()) {
      toast.warning('请输入要排除的域名、通配符或 Origin');
      return;
    }
    setAddingBl(true);
    try {
      await unwrapCommand({
        type: 'ADD_BLACKLIST_ENTRY',
        entry: {
          pattern: blPattern.trim(),
          matchType: blMatchType,
          scope: blScope,
          reason: blReason.trim() || undefined,
          presetCategory: 'custom',
        },
      });
      toast.success(`已添加至${blScope === 'space' ? '空间级' : '本机级'}黑名单`);
      setBlPattern('');
      setBlReason('');
      await fetchRules();
    } catch (err) {
      toast.error(`添加黑名单失败：${extractErrorMessage(err)}`);
    } finally {
      setAddingBl(false);
    }
  };

  const handleRemoveBlacklist = async (id: string, scope: 'space' | 'device') => {
    try {
      await unwrapCommand({ type: 'REMOVE_BLACKLIST_ENTRY', id, scope });
      toast.success('已移出黑名单');
      await fetchRules();
    } catch (err) {
      toast.error(`移出失败：${extractErrorMessage(err)}`);
    }
  };

  const handleUpsertSsoGroup = async () => {
    const domains = ssoDomains
      .split(/[,，\s]+/)
      .map(d => d.trim())
      .filter(Boolean);
    if (!ssoName.trim() || !ssoPrimary.trim() || domains.length === 0) {
      toast.warning('请填写 SSO 组名称、主站点 Key 及至少一个关联域名');
      return;
    }
    setSavingSso(true);
    try {
      const groupId = `sso_${ssoPrimary
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9.-]/g, '_')}`;
      await unwrapCommand({
        type: 'UPSERT_SSO_GROUP',
        group: {
          groupId,
          name: ssoName.trim(),
          primarySiteKey: ssoPrimary.trim().toLowerCase(),
          domains: Array.from(new Set([ssoPrimary.trim().toLowerCase(), ...domains.map(d => d.toLowerCase())])),
        },
      });
      toast.success(`已保存 SSO 关联域名组「${ssoName.trim()}」`);
      setSsoName('');
      setSsoPrimary('');
      setSsoDomains('');
      await fetchRules();
    } catch (err) {
      toast.error(`保存 SSO 组失败：${extractErrorMessage(err)}`);
    } finally {
      setSavingSso(false);
    }
  };

  const handleRemoveSsoGroup = async (groupId: string) => {
    try {
      await unwrapCommand({ type: 'REMOVE_SSO_GROUP', groupId });
      toast.success('已删除 SSO 关联域名组');
      await fetchRules();
    } catch (err) {
      toast.error(`删除失败：${extractErrorMessage(err)}`);
    }
  };

  const handleUpsertSiteRule = async () => {
    const key = ovSiteKey.trim().toLowerCase();
    if (!key) {
      toast.warning('请输入站点域名（如 github.com）');
      return;
    }
    setSavingOv(true);
    try {
      await unwrapCommand({
        type: 'UPSERT_SITE_RULE',
        rule: {
          siteKey: key,
          pattern: key,
          direction: ovDirection,
          syncCookies: ovSyncCookies,
          syncLocalStorage: ovSyncLs,
          autoRefresh: ovAutoRefresh,
          updatedAt: Date.now(),
        },
      });
      toast.success(`已保存 ${key} 的站点同步策略`);
      setOvSiteKey('');
      await fetchRules();
    } catch (err) {
      toast.error(`保存站点规则失败：${extractErrorMessage(err)}`);
    } finally {
      setSavingOv(false);
    }
  };

  const handleRemoveSiteRule = async (siteKey: string) => {
    try {
      await unwrapCommand({ type: 'REMOVE_SITE_RULE', siteKey });
      toast.success(`已恢复 ${siteKey} 使用全局默认策略`);
      await fetchRules();
    } catch (err) {
      toast.error(`移除规则失败：${extractErrorMessage(err)}`);
    }
  };

  const handleExportRules = async (download: boolean) => {
    try {
      const jsonStr = await unwrapCommand<string>({ type: 'EXPORT_RULES_JSON' });
      const text = typeof jsonStr === 'string' ? jsonStr : JSON.stringify(jsonStr, null, 2);
      if (download) {
        downloadJsonFile(`sessionmesh-rules-${status.activeSpaceId || 'default'}.json`, text);
        toast.success('已导出规则 JSON 文件');
      } else {
        await copyToClipboard(text, '已复制规则 JSON 到剪贴板');
      }
    } catch (err) {
      toast.error(`导出规则失败：${extractErrorMessage(err)}`);
    }
  };

  const handleImportRules = async () => {
    if (!importJsonText.trim()) {
      toast.warning('请粘贴规则 JSON 内容');
      return;
    }
    setImporting(true);
    try {
      const parsed = JSON.parse(importJsonText) as Record<string, unknown>;
      // Support both flat SyncRuleUpdatePayload and nested { spaceRules, deviceBlacklist } export shape
      const spaceRulesObj =
        parsed.spaceRules && typeof parsed.spaceRules === 'object'
          ? (parsed.spaceRules as Record<string, unknown>)
          : parsed;
      const payload: SyncRuleUpdatePayload = {
        spaceBlacklist: (spaceRulesObj.spaceBlacklist as BlacklistEntry[] | undefined) ?? undefined,
        siteOverrides: (spaceRulesObj.siteOverrides as Record<string, SiteRuleOverride> | undefined) ?? undefined,
        ssoGroups: (spaceRulesObj.ssoGroups as SsoDomainGroup[] | undefined) ?? undefined,
        deviceBlacklist: (parsed.deviceBlacklist as BlacklistEntry[] | undefined) ?? undefined,
      };
      await unwrapCommand({ type: 'IMPORT_RULES_JSON', payload });
      toast.success('已成功导入同步规则与黑名单');
      setImportOpen(false);
      setImportJsonText('');
      await fetchRules();
    } catch (err) {
      toast.error(`导入失败（请确认 JSON 格式有效）：${extractErrorMessage(err)}`);
    } finally {
      setImporting(false);
    }
  };

  const renderBlacklistList = (items: BlacklistEntry[], scope: 'space' | 'device', emptyText: string) => {
    if (items.length === 0) {
      return (
        <div className="rounded-lg border border-dashed border-border py-5 text-center text-xs text-muted-foreground">
          {emptyText}
        </div>
      );
    }
    return (
      <div className="divide-y divide-border rounded-lg border border-border">
        {items.map(entry => (
          <div key={entry.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs">
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono font-semibold text-foreground">{entry.pattern}</code>
                <Badge variant="outline" className="text-[10px]">
                  {MATCH_TYPE_LABELS[entry.matchType]}
                </Badge>
                {entry.presetCategory && entry.presetCategory !== 'custom' ? (
                  <Badge variant="secondary" className="text-[10px]">
                    预设: {entry.presetCategory}
                  </Badge>
                ) : null}
              </div>
              {entry.reason ? <p className="text-[11px] text-muted-foreground">{entry.reason}</p> : null}
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-destructive hover:text-destructive shrink-0"
              onClick={() => handleRemoveBlacklist(entry.id, scope)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    );
  };

  const overrideList = Object.values(rules.siteOverrides);

  return (
    <div className="space-y-5">
      {/* Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3">
        <div className="text-xs text-muted-foreground">
          规则优先级：<strong>本机黑名单 / 空间黑名单</strong> &gt; 精确 Origin &gt; 精确域名 &gt; 子域名 &gt; 通配符
          &gt; 全局默认
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={loading} onClick={fetchRules}>
            {loading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            刷新
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => handleExportRules(false)}>
            <Copy className="mr-1.5 h-3.5 w-3.5" />
            复制 JSON
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => handleExportRules(true)}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            导出 JSON
          </Button>
          <Button type="button" size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            导入规则 JSON
          </Button>
        </div>
      </div>

      {/* Dismissible Security Best-Practice Tip */}
      {isBannerVisible('rules_blacklist_security_notice', 'security') ? (
        <Alert className="border-amber-500/40 bg-amber-500/10 pr-24">
          <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <AlertTitle className="text-sm font-semibold">高敏感站点隔离建议</AlertTitle>
          <AlertDescription className="text-xs leading-relaxed">
            建议始终将网银、支付平台、在线密码管理器以及当前 WebDAV
            管理后台保留在双层黑名单中；黑名单优先级高于任意同步规则与纳管清单，可彻底阻断上传与覆盖。
          </AlertDescription>
          <div className="absolute right-3 top-3 flex items-center gap-1">
            <button
              type="button"
              onClick={() => void dismissBanner('rules_blacklist_security_notice')}
              className="rounded px-1.5 py-0.5 text-[11px] text-amber-900/80 hover:bg-amber-500/20 dark:text-amber-200">
              不再提示
            </button>
            <button
              type="button"
              aria-label="关闭建议提示"
              onClick={() => void dismissBanner('rules_blacklist_security_notice')}
              className="rounded p-1 text-amber-900/80 hover:bg-amber-500/20 dark:text-amber-200">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </Alert>
      ) : null}

      {/* Dual-Layer Blacklist */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Ban className="h-5 w-5 text-destructive" />
            双层黑名单（空间级 + 本机级）
          </CardTitle>
          <CardDescription>命中任意一层黑名单的网站将被彻底阻断扫描、上传、拉取、覆盖与自动刷新。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Add Form */}
          <div className="grid gap-3 rounded-xl border border-border bg-muted/25 p-3.5 sm:grid-cols-12">
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">黑名单层级</Label>
              <Select value={blScope} onValueChange={v => setBlScope(v as 'space' | 'device')}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="space">空间级（全设备）</SelectItem>
                  <SelectItem value="device">本机级（仅本电脑）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs">匹配模式</Label>
              <Select value={blMatchType} onValueChange={v => setBlMatchType(v as BlacklistEntry['matchType'])}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="subdomain">子域名（含主域与所有子域）</SelectItem>
                  <SelectItem value="exact_domain">精确域名</SelectItem>
                  <SelectItem value="wildcard">通配符（如 *.bank.cn）</SelectItem>
                  <SelectItem value="origin">精确 Origin（https://...）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs">域名 / 表达式 *</Label>
              <Input
                className="h-9 text-xs"
                value={blPattern}
                onChange={e => setBlPattern(e.target.value)}
                placeholder="例如 bank.example.com"
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">备注（可选）</Label>
              <Input
                className="h-9 text-xs"
                value={blReason}
                onChange={e => setBlReason(e.target.value)}
                placeholder="如 个人网银"
              />
            </div>
            <div className="flex items-end sm:col-span-2">
              <Button
                type="button"
                size="sm"
                disabled={addingBl || status.locked}
                onClick={handleAddBlacklist}
                className="h-9 w-full text-xs">
                {addingBl ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="mr-1 h-3.5 w-3.5" />
                )}
                添加规则
              </Button>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                  <Shield className="h-4 w-4 text-primary" />
                  空间级黑名单（随空间加密同步至全设备）
                </span>
                <Badge variant="secondary">{rules.spaceBlacklist.length}</Badge>
              </div>
              {renderBlacklistList(rules.spaceBlacklist, 'space', '暂无空间级黑名单规则')}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                  <Globe className="h-4 w-4 text-amber-600" />
                  本机级黑名单（仅对当前这台电脑生效）
                </span>
                <Badge variant="secondary">{rules.deviceBlacklist.length}</Badge>
              </div>
              {renderBlacklistList(rules.deviceBlacklist, 'device', '暂无本机级黑名单规则')}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Linked SSO Domain Groups */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Link2 className="h-5 w-5 text-primary" />
            跨主域 SSO 关联组（Linked SSO Domain Groups）
          </CardTitle>
          <CardDescription>
            将共享同一套账号体系的多个独立主域归入同一个 <code>siteKey</code> 轨道同步，避免拆开重复确认（如 Microsoft /
            Google / 企业 SSO 域名组）。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 rounded-xl border border-border bg-muted/25 p-3.5 sm:grid-cols-12">
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs">分组名称 *</Label>
              <Input
                className="h-9 text-xs"
                value={ssoName}
                onChange={e => setSsoName(e.target.value)}
                placeholder="例如 微软生态 SSO"
              />
            </div>
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs">主站点 Key *</Label>
              <Input
                className="h-9 text-xs"
                value={ssoPrimary}
                onChange={e => setSsoPrimary(e.target.value)}
                placeholder="例如 microsoft.com"
              />
            </div>
            <div className="space-y-1 sm:col-span-4">
              <Label className="text-xs">关联域名（逗号分隔）*</Label>
              <Input
                className="h-9 text-xs"
                value={ssoDomains}
                onChange={e => setSsoDomains(e.target.value)}
                placeholder="live.com, office.com, azure.com"
              />
            </div>
            <div className="flex items-end sm:col-span-2">
              <Button
                type="button"
                size="sm"
                disabled={savingSso || status.locked}
                onClick={handleUpsertSsoGroup}
                className="h-9 w-full text-xs">
                {savingSso ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="mr-1 h-3.5 w-3.5" />
                )}
                保存分组
              </Button>
            </div>
          </div>

          {rules.ssoGroups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-5 text-center text-xs text-muted-foreground">
              暂无跨主域 SSO 关联组（默认已自动按 eTLD+1 主域聚合所有子域）。
            </div>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border">
              {rules.ssoGroups.map(group => (
                <div
                  key={group.groupId}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-foreground">{group.name}</span>
                      <Badge variant="info">主 Key: {group.primarySiteKey}</Badge>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {group.domains.map(d => (
                        <Badge key={d} variant="outline" className="font-mono text-[11px]">
                          {d}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleRemoveSsoGroup(group.groupId)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-Site Rule Overrides */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <SlidersHorizontal className="h-5 w-5 text-primary" />
            单站同步策略覆盖（Per-Site Overrides）
          </CardTitle>
          <CardDescription>
            为特定网站单独指定同步方向（双向 / 仅上传 / 仅拉取 / 禁用）以及是否同步 Cookie、LocalStorage 与自动刷新。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-xl border border-border bg-muted/25 p-3.5 space-y-3">
            <div className="grid gap-3 sm:grid-cols-12">
              <div className="space-y-1 sm:col-span-5">
                <Label className="text-xs">目标站点域名 *</Label>
                <Input
                  className="h-9 text-xs"
                  value={ovSiteKey}
                  onChange={e => setOvSiteKey(e.target.value)}
                  placeholder="例如 github.com"
                />
              </div>
              <div className="space-y-1 sm:col-span-4">
                <Label className="text-xs">同步方向</Label>
                <Select value={ovDirection} onValueChange={v => setOvDirection(v as SyncDirection)}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bidirectional">双向同步</SelectItem>
                    <SelectItem value="push_only">仅上传（本机 -&gt; 云端）</SelectItem>
                    <SelectItem value="pull_only">仅拉取（云端 -&gt; 本机）</SelectItem>
                    <SelectItem value="disabled">禁用同步</SelectItem>
                    <SelectItem value="inherit">继承全局策略</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end sm:col-span-3">
                <Button
                  type="button"
                  size="sm"
                  disabled={savingOv || status.locked}
                  onClick={handleUpsertSiteRule}
                  className="h-9 w-full text-xs">
                  {savingOv ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="mr-1 h-3.5 w-3.5" />
                  )}
                  保存站点覆盖
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-5 pt-1 text-xs">
              <div className="inline-flex items-center gap-2">
                <Switch id="rule-ov-cookies" checked={ovSyncCookies} onCheckedChange={setOvSyncCookies} />
                <Label htmlFor="rule-ov-cookies" className="text-xs font-normal">
                  同步 Cookies
                </Label>
              </div>
              <div className="inline-flex items-center gap-2">
                <Switch id="rule-ov-ls" checked={ovSyncLs} onCheckedChange={setOvSyncLs} />
                <Label htmlFor="rule-ov-ls" className="text-xs font-normal">
                  同步 LocalStorage
                </Label>
              </div>
              <div className="inline-flex items-center gap-2">
                <Switch id="rule-ov-refresh" checked={ovAutoRefresh} onCheckedChange={setOvAutoRefresh} />
                <Label htmlFor="rule-ov-refresh" className="text-xs font-normal">
                  自动刷新网页
                </Label>
              </div>
            </div>
          </div>

          {overrideList.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-5 text-center text-xs text-muted-foreground">
              暂无单站覆盖规则，所有未拉黑网站均遵循全局同步策略。
            </div>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border">
              {overrideList.map(rule => (
                <div key={rule.siteKey} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold text-sm text-foreground">{rule.siteKey}</span>
                      <Badge variant={rule.direction === 'disabled' ? 'destructive' : 'info'}>
                        {DIRECTION_LABELS[rule.direction]}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                      <span>Cookies: {rule.syncCookies ? '开' : '关'}</span>
                      <span>LocalStorage: {rule.syncLocalStorage ? '开' : '关'}</span>
                      <span>自动刷新: {rule.autoRefresh ? '开' : '关'}</span>
                      <span>更新于：{formatDateTime(rule.updatedAt)}</span>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleRemoveSiteRule(rule.siteKey)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Import Rules JSON Modal */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>导入同步规则与黑名单 JSON</DialogTitle>
            <DialogDescription>
              粘贴从 SessionMesh 导出的规则 JSON，支持空间级黑名单、本机级黑名单、SSO 关联组与单站策略覆盖。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={10}
            value={importJsonText}
            onChange={e => setImportJsonText(e.target.value)}
            placeholder='{"spaceBlacklist": [...], "deviceBlacklist": [...], "siteOverrides": {...}, "ssoGroups": [...]}'
            className="font-mono text-xs"
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={importing} onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={importing} onClick={handleImportRules}>
              {importing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              确认导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
