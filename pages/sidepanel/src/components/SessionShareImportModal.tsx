import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import { formatDateTime, formatRemainingDuration } from '@console/lib/format';
import type { SessionShareImportMode, SessionSharePreview } from '@sessionmesh/shared';
import { Button, Input, Label, Switch } from '@sessionmesh/ui';
import { ArrowLeftRight, Clock, Cookie, Database, Eye, Loader2, ShieldAlert, Sparkles, Upload } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from './common/Badge';
import { Modal } from './common/Modal';

export interface SessionShareImportModalProps {
  open: boolean;
  onClose: () => void;
  onImported: () => Promise<void> | void;
}

export const SessionShareImportModal: React.FC<SessionShareImportModalProps> = ({ open, onClose, onImported }) => {
  const [code, setCode] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [preview, setPreview] = useState<SessionSharePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [mode, setMode] = useState<SessionShareImportMode>('ephemeral_track');
  const [customLabel, setCustomLabel] = useState('');
  const [targetUrl, setTargetUrl] = useState('http://localhost:3000');
  const [adaptForHttp, setAdaptForHttp] = useState(true);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (open) {
      setCode('');
      setPassphrase('');
      setPreview(null);
      setPreviewing(false);
      setMode('ephemeral_track');
      setCustomLabel('');
      setTargetUrl('http://localhost:3000');
      setAdaptForHttp(true);
      setImporting(false);
    }
  }, [open]);

  const handlePreview = async () => {
    const trimmedCode = code.trim();
    const trimmedPass = passphrase.trim();
    if (!trimmedCode || !trimmedPass) {
      toast.warning('请粘贴加密分享片段并输入解密口令');
      return;
    }
    setPreviewing(true);
    try {
      const res = await sidePanelApi.previewSessionShare(trimmedCode, trimmedPass);
      setPreview(res);
      setCustomLabel(res.accountLabel ? `${res.accountLabel} (临时)` : '');
      toast.success(`解密预览成功：${res.siteKey}`);
    } catch (err) {
      setPreview(null);
      toast.error(`解密预览失败：${extractErrorMessage(err)}`);
    } finally {
      setPreviewing(false);
    }
  };

  const handleImport = async () => {
    if (!preview) return;
    if (mode === 'env_target' && !targetUrl.trim()) {
      toast.warning('请填写本地开发环境目标 URL（如 http://localhost:3000）');
      return;
    }
    setImporting(true);
    try {
      const res = await sidePanelApi.importSessionShare({
        code: code.trim(),
        passphrase: passphrase.trim(),
        mode,
        customLabel: mode === 'ephemeral_track' ? customLabel.trim() || undefined : undefined,
        targetUrl: mode === 'env_target' ? targetUrl.trim() : undefined,
        adaptForHttp: mode === 'env_target' ? adaptForHttp : undefined,
      });

      const ssHint = res.appliedSessionStorage > 0 ? `、${res.appliedSessionStorage} SS` : '';
      toast.success(
        mode === 'env_target'
          ? `已将分享会话直连注入 ${res.targetUrl}（${res.appliedCookies} Cookie · ${res.appliedLocalStorage} LS${ssHint}）`
          : mode === 'ephemeral_track'
            ? `已导入为 ${res.siteKey} 本机临时隔离账号「${res.track?.label || '临时分享'}」（到期自动清理）`
            : `已覆盖 ${res.siteKey} 当前活跃账号（已自动保存本地后悔药）`,
      );
      await onImported();
      onClose();
    } catch (err) {
      toast.error(`导入分享会话失败：${extractErrorMessage(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!previewing && !importing) onClose();
      }}
      title={
        <span className="flex items-center gap-1.5">
          <Upload className="h-4 w-4 text-primary" />
          导入团队加密分享会话
        </span>
      }
      description="先解密预览团队成员分享的 smesh://share/v1... 会话内容，再选择本机临时隔离运行、直连本地开发环境或覆盖当前账号。"
      maxWidthClass="max-w-lg"
      footer={
        <>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={previewing || importing}>
            取消
          </Button>
          {!preview ? (
            <Button
              type="button"
              size="sm"
              disabled={previewing || !code.trim() || !passphrase.trim()}
              onClick={handlePreview}>
              {previewing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Eye className="mr-1.5 h-3.5 w-3.5" />
              )}
              解密预览
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={importing} onClick={handleImport}>
              {importing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="mr-1.5 h-3.5 w-3.5" />
              )}
              确认导入会话
            </Button>
          )}
        </>
      }>
      <div className="space-y-3 text-xs">
        {/* Step 1: Code + Passphrase */}
        <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-2.5">
          <div className="space-y-1">
            <Label htmlFor="share-import-code" className="text-[11px] font-medium">
              加密分享片段 (smesh://share/v1....) *
            </Label>
            <textarea
              id="share-import-code"
              rows={3}
              value={code}
              onChange={e => {
                setCode(e.target.value);
                if (preview) setPreview(null);
              }}
              placeholder="粘贴 smesh://share/v1...."
              className="w-full rounded-md border border-input bg-background p-2 font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor="share-import-pass" className="text-[11px] font-medium">
                解密口令 *
              </Label>
              <Input
                id="share-import-pass"
                type="password"
                value={passphrase}
                onChange={e => {
                  setPassphrase(e.target.value);
                  if (preview) setPreview(null);
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') void handlePreview();
                }}
                placeholder="输入协作者发送的一次性解密口令"
                className="h-8 font-mono text-xs bg-background"
              />
            </div>
            {preview ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 text-[11px]"
                disabled={previewing}
                onClick={handlePreview}>
                {previewing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Eye className="mr-1 h-3 w-3" />}
                重新预览
              </Button>
            ) : null}
          </div>
        </div>

        {/* Preview Panel & Step 2 */}
        {preview ? (
          <>
            <div className="rounded-xl border border-purple-500/35 bg-purple-500/[0.06] p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-bold text-foreground">{preview.siteKey}</span>
                  {preview.accountLabel ? <StatusBadge tone="primary">{preview.accountLabel}</StatusBadge> : null}
                  {preview.clampCookieExpiry ? <StatusBadge tone="info">已收敛 TTL</StatusBadge> : null}
                </div>
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-purple-500/35 bg-purple-500/15 px-2 py-0.5 text-[10px] font-semibold text-purple-700 dark:text-purple-300"
                  title={`到期时间：${formatDateTime(preview.expiresAt)}`}>
                  <Clock className="h-3 w-3" />
                  {formatRemainingDuration(preview.remainingMs)}
                </span>
              </div>

              {preview.note ? (
                <p className="text-[11px] text-foreground/90">
                  备注：{preview.note}
                  {preview.sharedBy ? `（由 ${preview.sharedBy} 分享）` : ''}
                </p>
              ) : preview.sharedBy ? (
                <p className="text-[11px] text-muted-foreground">分享来源：{preview.sharedBy}</p>
              ) : null}

              <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Cookie className="h-3 w-3" />
                  {preview.cookieCount} 条 Cookie
                </span>
                <span className="inline-flex items-center gap-1">
                  <Database className="h-3 w-3" />
                  {preview.localStorageCount} 项 LS · {preview.sessionStorageCount} 项 SS
                </span>
              </div>

              {preview.cookieNames.length > 0 ? (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {preview.cookieNames.slice(0, 12).map(name => (
                    <code
                      key={name}
                      className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                      {name}
                    </code>
                  ))}
                  {preview.cookieNames.length > 12 ? (
                    <span className="text-[10px] text-muted-foreground">+{preview.cookieNames.length - 12} 项</span>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* Step 2: Landing Mode */}
            <div className="space-y-2">
              <div className="text-[11px] font-semibold text-foreground">选择导入落点模式：</div>

              {/* Mode 1: ephemeral_track */}
              <div
                className={`rounded-lg border p-2.5 space-y-2 transition-colors ${
                  mode === 'ephemeral_track'
                    ? 'border-purple-500 bg-purple-500/[0.06]'
                    : 'border-border hover:bg-muted/30'
                }`}>
                <div className="flex items-start gap-2">
                  <input
                    id="share-mode-ephemeral"
                    type="radio"
                    name="share-import-mode"
                    checked={mode === 'ephemeral_track'}
                    onChange={() => setMode('ephemeral_track')}
                    className="mt-0.5 cursor-pointer accent-primary"
                  />
                  <label htmlFor="share-mode-ephemeral" className="min-w-0 flex-1 cursor-pointer">
                    <span className="flex flex-wrap items-center gap-1.5 font-medium text-foreground">
                      <Sparkles className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                      <span>创建本机临时隔离账号（推荐）</span>
                      <span className="rounded bg-purple-500/15 px-1.5 py-0 text-[10px] font-bold text-purple-700 dark:text-purple-300">
                        TEMP
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      创建本机临时隔离账号（挂紫色 TEMP 角标，不上传个人云端，到期自动清理）
                    </span>
                  </label>
                </div>
                {mode === 'ephemeral_track' ? (
                  <div className="pl-5">
                    <Input
                      value={customLabel}
                      onChange={e => setCustomLabel(e.target.value)}
                      placeholder="自定义临时账号名称（可选）"
                      className="h-7 bg-background text-xs"
                    />
                  </div>
                ) : null}
              </div>

              {/* Mode 2: env_target */}
              <div
                className={`rounded-lg border p-2.5 space-y-2 transition-colors ${
                  mode === 'env_target' ? 'border-primary bg-primary/[0.05]' : 'border-border hover:bg-muted/30'
                }`}>
                <div className="flex items-start gap-2">
                  <input
                    id="share-mode-env"
                    type="radio"
                    name="share-import-mode"
                    checked={mode === 'env_target'}
                    onChange={() => setMode('env_target')}
                    className="mt-0.5 cursor-pointer accent-primary"
                  />
                  <label htmlFor="share-mode-env" className="min-w-0 flex-1 cursor-pointer">
                    <span className="flex items-center gap-1.5 font-medium text-foreground">
                      <ArrowLeftRight className="h-3.5 w-3.5 text-primary" />
                      直连映射到本地开发环境
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      直连映射到本地开发环境（如 http://localhost:3000，不改动线上登录态）
                    </span>
                  </label>
                </div>
                {mode === 'env_target' ? (
                  <div className="space-y-2 pl-5">
                    <div className="flex flex-wrap items-center gap-1">
                      {['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:8080'].map(preset => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setTargetUrl(preset)}
                          className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground">
                          {preset.replace('http://', '')}
                        </button>
                      ))}
                    </div>
                    <Input
                      value={targetUrl}
                      onChange={e => setTargetUrl(e.target.value)}
                      placeholder="http://localhost:3000"
                      className="h-7 bg-background font-mono text-xs"
                    />
                    <div className="flex items-center gap-1.5">
                      <Switch
                        id="share-mode-env-http"
                        className="scale-75"
                        checked={adaptForHttp}
                        onCheckedChange={setAdaptForHttp}
                      />
                      <Label htmlFor="share-mode-env-http" className="text-[11px] cursor-pointer">
                        自动适配 HTTP / localhost（去除 Secure / 放宽 SameSite）
                      </Label>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Mode 3: override_active */}
              <div
                className={`rounded-lg border p-2.5 transition-colors ${
                  mode === 'override_active'
                    ? 'border-amber-500 bg-amber-500/[0.06]'
                    : 'border-border hover:bg-muted/30'
                }`}>
                <div className="flex items-start gap-2">
                  <input
                    id="share-mode-override"
                    type="radio"
                    name="share-import-mode"
                    checked={mode === 'override_active'}
                    onChange={() => setMode('override_active')}
                    className="mt-0.5 cursor-pointer accent-primary"
                  />
                  <label htmlFor="share-mode-override" className="min-w-0 flex-1 cursor-pointer">
                    <span className="flex items-center gap-1.5 font-medium text-foreground">
                      <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                      覆盖当前站点活跃账号
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      覆盖当前站点活跃账号（自动创建后悔药）
                    </span>
                  </label>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
};
