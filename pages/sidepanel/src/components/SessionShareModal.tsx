import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import {
  copyToClipboard,
  formatDateTime,
  formatRemainingDuration,
  generateRandomSharePassphrase,
} from '@console/lib/format';
import type { CreateSessionShareResult } from '@sessionmesh/shared';
import { Button, Input, Label, Switch } from '@sessionmesh/ui';
import { CheckCircle2, Copy, KeyRound, Loader2, RefreshCw, Share2, ShieldAlert } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Modal } from './common/Modal';

export interface SessionShareModalProps {
  open: boolean;
  onClose: () => void;
  siteKey: string;
  trackId?: string;
  trackLabel?: string;
}

const TTL_OPTIONS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: '15 分钟', ms: 15 * 60_000 },
  { label: '1 小时', ms: 60 * 60_000 },
  { label: '6 小时', ms: 6 * 3600_000 },
  { label: '24 小时', ms: 24 * 3600_000 },
  { label: '7 天', ms: 7 * 24 * 3600_000 },
];

export const SessionShareModal: React.FC<SessionShareModalProps> = ({
  open,
  onClose,
  siteKey,
  trackId,
  trackLabel,
}) => {
  const [ttlMs, setTtlMs] = useState<number>(60 * 60_000);
  const [passphrase, setPassphrase] = useState<string>('');
  const [accountLabel, setAccountLabel] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [clampCookieExpiry, setClampCookieExpiry] = useState<boolean>(true);
  const [filterNoise, setFilterNoise] = useState<boolean>(true);
  const [excludeHttpOnly, setExcludeHttpOnly] = useState<boolean>(false);
  const [includeLocalStorage, setIncludeLocalStorage] = useState<boolean>(true);
  const [includeSessionStorage, setIncludeSessionStorage] = useState<boolean>(true);

  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<CreateSessionShareResult | null>(null);

  useEffect(() => {
    if (open) {
      setTtlMs(60 * 60_000);
      setPassphrase(generateRandomSharePassphrase(16));
      setAccountLabel(trackLabel || '');
      setNote('');
      setClampCookieExpiry(true);
      setFilterNoise(true);
      setExcludeHttpOnly(false);
      setIncludeLocalStorage(true);
      setIncludeSessionStorage(true);
      setResult(null);
      setGenerating(false);
    }
  }, [open, siteKey, trackId, trackLabel]);

  const handleGenerate = async () => {
    const trimmedPass = passphrase.trim();
    if (!trimmedPass) {
      toast.warning('请先设置或生成解密口令');
      return;
    }
    setGenerating(true);
    try {
      const res = await sidePanelApi.createSessionShare({
        siteKey,
        trackId,
        passphrase: trimmedPass,
        ttlMs,
        accountLabel: accountLabel.trim() || undefined,
        note: note.trim() || undefined,
        clampCookieExpiry,
        filterNoise,
        excludeHttpOnly,
        includeLocalStorage,
        includeSessionStorage,
      });
      setResult(res);
      toast.success('已生成临时端到端加密分享片段');
    } catch (err) {
      toast.error(`生成临时分享失败：${extractErrorMessage(err)}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyToken = async () => {
    if (!result) return;
    const ok = await copyToClipboard(result.code);
    if (ok) toast.success('已复制加密会话片段（smesh://share/v1...）');
    else toast.error('复制失败');
  };

  const handleCopyPassphrase = async () => {
    if (!passphrase.trim()) return;
    const ok = await copyToClipboard(passphrase.trim());
    if (ok) toast.success('已复制一次性口令（建议通过另一通道发送）');
    else toast.error('复制失败');
  };

  const handleCopyFullCard = async () => {
    if (!result) return;
    const lines = [
      '【SessionMesh 临时会话分享】',
      `站点：${result.siteKey}`,
      `账号：${result.accountLabel || trackLabel || '默认账号'}`,
      note.trim() ? `说明：${note.trim()}` : null,
      `有效期至：${formatDateTime(result.expiresAt)}（${formatRemainingDuration(result.expiresAt - Date.now())}）`,
      `包含数据：${result.cookieCount} 条 Cookie · ${result.localStorageCount} 项 LS · ${result.sessionStorageCount} 项 SS`,
      '',
      '加密片段：',
      result.code,
      '',
      '安全提示：解密口令已单独保留，请通过另一通信通道发送给协作者，切勿与加密片段在同一条消息中明文发送。',
    ].filter((line): line is string => line !== null);

    const ok = await copyToClipboard(lines.join('\n'));
    if (ok) toast.success('已复制完整分享卡片文案（建议分通道发送口令）');
    else toast.error('复制失败');
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!generating) onClose();
      }}
      title={
        <span className="flex items-center gap-1.5">
          <Share2 className="h-4 w-4 text-primary" />
          临时加密会话分享 · {siteKey}
        </span>
      }
      description={
        trackLabel
          ? `将账号「${trackLabel}」打包为一次性端到端加密分享片段，接收方将在本机隔离运行且到期自动清理。`
          : '打包为一次性端到端加密分享片段，接收方将在本机隔离运行且到期自动清理。'
      }
      maxWidthClass="max-w-lg"
      footer={
        result ? (
          <div className="flex w-full items-center justify-between gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setResult(null)}>
              修改参数重新生成
            </Button>
            <Button type="button" size="sm" onClick={onClose}>
              完成
            </Button>
          </div>
        ) : (
          <>
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={generating}>
              取消
            </Button>
            <Button type="button" size="sm" disabled={generating || !passphrase.trim()} onClick={handleGenerate}>
              {generating ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Share2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              生成加密分享片段
            </Button>
          </>
        )
      }>
      {result ? (
        <div className="space-y-3 text-xs">
          <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/[0.08] p-2.5 text-emerald-900 dark:text-emerald-200 space-y-1">
            <div className="flex items-center gap-1.5 font-semibold">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>临时分享片段已生成</span>
            </div>
            <p className="text-[11px] opacity-90">
              包含 {result.cookieCount} 条 Cookie、{result.localStorageCount} 项 LS、{result.sessionStorageCount} 项 SS
              · 有效期至 {formatDateTime(result.expiresAt)}（{formatRemainingDuration(result.expiresAt - Date.now())}）
            </p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] font-medium">加密分享片段（smesh://share/v1...）</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={handleCopyToken}>
                <Copy className="mr-1 h-3 w-3" />
                复制加密片段
              </Button>
            </div>
            <textarea
              readOnly
              rows={4}
              value={result.code}
              onClick={e => (e.target as HTMLTextAreaElement).select()}
              className="w-full rounded-md border border-input bg-muted/30 p-2 font-mono text-[11px] text-foreground break-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] font-medium">一次性解密口令</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={handleCopyPassphrase}>
                <KeyRound className="mr-1 h-3 w-3" />
                复制口令
              </Button>
            </div>
            <Input readOnly value={passphrase} className="h-8 bg-muted/30 font-mono text-xs" />
          </div>

          <div className="rounded-lg border border-amber-500/35 bg-amber-500/[0.08] p-2.5 text-[11px] text-amber-900 dark:text-amber-200 flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>
              建议将「加密片段」与「解密口令」通过不同聊天通道分别发送给协作者，且仅用于临时排障，勿用于长期共享高权限账号。
            </span>
          </div>

          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-full h-8 text-xs"
            onClick={handleCopyFullCard}>
            <Copy className="mr-1.5 h-3.5 w-3.5" />
            复制完整分享卡片文案（建议分通道发送口令）
          </Button>
        </div>
      ) : (
        <div className="space-y-3 text-xs">
          {/* TTL Selector */}
          <div className="space-y-1.5">
            <Label className="text-[11px] font-medium">分享有效期（TTL）</Label>
            <div className="flex flex-wrap gap-1.5">
              {TTL_OPTIONS.map(opt => (
                <button
                  key={opt.ms}
                  type="button"
                  onClick={() => setTtlMs(opt.ms)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    ttlMs === opt.ms
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:text-foreground'
                  }`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Passphrase */}
          <div className="space-y-1">
            <Label htmlFor="share-passphrase" className="text-[11px] font-medium">
              一次性加密口令（AES-256-GCM 独立派生）*
            </Label>
            <div className="flex items-center gap-1.5">
              <Input
                id="share-passphrase"
                value={passphrase}
                onChange={e => setPassphrase(e.target.value)}
                placeholder="16 位随机口令"
                className="h-8 font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => setPassphrase(generateRandomSharePassphrase(16))}
                title="重新生成 16 位随机口令">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => void handleCopyPassphrase()}
                title="复制口令">
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Account Label & Note */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="share-acct-label" className="text-[11px]">
                展示账号名称（可选）
              </Label>
              <Input
                id="share-acct-label"
                value={accountLabel}
                onChange={e => setAccountLabel(e.target.value)}
                placeholder="如 只读测试号"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="share-note" className="text-[11px]">
                协作用途备注（可选）
              </Label>
              <Input
                id="share-note"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="例如：复现线上导出 500 Bug"
                className="h-8 text-xs"
              />
            </div>
          </div>

          {/* Options Toggles */}
          <div className="space-y-2 rounded-lg border border-border bg-muted/25 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="share-clamp-exp" className="text-[11px] cursor-pointer">
                收敛 Cookie 过期时间不超过分享 TTL（推荐）
              </Label>
              <Switch
                id="share-clamp-exp"
                className="scale-75"
                checked={clampCookieExpiry}
                onCheckedChange={setClampCookieExpiry}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="share-filter-noise" className="text-[11px] cursor-pointer">
                过滤统计埋点噪声 Cookie
              </Label>
              <Switch
                id="share-filter-noise"
                className="scale-75"
                checked={filterNoise}
                onCheckedChange={setFilterNoise}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="share-exclude-httponly" className="text-[11px] cursor-pointer">
                排除 HttpOnly Cookie（仅分享前端可读态）
              </Label>
              <Switch
                id="share-exclude-httponly"
                className="scale-75"
                checked={excludeHttpOnly}
                onCheckedChange={setExcludeHttpOnly}
              />
            </div>
            <div className="flex flex-wrap items-center gap-4 pt-1 border-t border-border/60">
              <div className="flex items-center gap-1.5">
                <Switch
                  id="share-inc-ls"
                  className="scale-75"
                  checked={includeLocalStorage}
                  onCheckedChange={setIncludeLocalStorage}
                />
                <Label htmlFor="share-inc-ls" className="text-[11px] cursor-pointer">
                  包含 LocalStorage
                </Label>
              </div>
              <div className="flex items-center gap-1.5">
                <Switch
                  id="share-inc-ss"
                  className="scale-75"
                  checked={includeSessionStorage}
                  onCheckedChange={setIncludeSessionStorage}
                />
                <Label htmlFor="share-inc-ss" className="text-[11px] cursor-pointer">
                  包含 SessionStorage
                </Label>
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};
