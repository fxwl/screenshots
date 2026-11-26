import type { BrowserCookieInput, CookieRecord, SameSiteValue } from '@sessionmesh/shared';
import { Button, Input, Label, Switch } from '@sessionmesh/ui';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { Modal } from './common/Modal';

export interface CookieEditorModalProps {
  open: boolean;
  onClose: () => void;
  siteKey: string;
  initialCookie?: CookieRecord | null;
  onSave: (cookie: BrowserCookieInput) => Promise<void>;
}

function isLocalOrSingleLabelDomain(rawDomain: string): boolean {
  const clean = rawDomain.trim().toLowerCase().replace(/^\.+/, '');
  if (!clean) return false;
  if (clean === 'localhost' || !clean.includes('.') || clean.includes(':')) return true;
  const parts = clean.split('.');
  return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function toDatetimeLocalValue(expirationDate?: number): string {
  if (!expirationDate) return '';
  const ms = expirationDate > 1e12 ? expirationDate : expirationDate * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const CookieEditorModal: React.FC<CookieEditorModalProps> = ({
  open,
  onClose,
  siteKey,
  initialCookie,
  onSave,
}) => {
  const isEdit = !!initialCookie;
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [domain, setDomain] = useState(siteKey);
  const [path, setPath] = useState('/');
  const [sameSite, setSameSite] = useState<SameSiteValue>('lax');
  const [secure, setSecure] = useState(true);
  const [httpOnly, setHttpOnly] = useState(false);
  const [session, setSession] = useState(false);
  const [hostOnly, setHostOnly] = useState(false);
  const [expiryInput, setExpiryInput] = useState('');
  const [partitionTopLevelSite, setPartitionTopLevelSite] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSubmitting(false);
    if (initialCookie) {
      setName(initialCookie.name);
      setValue(initialCookie.value);
      setDomain(initialCookie.domain);
      setPath(initialCookie.path || '/');
      setSameSite(initialCookie.sameSite || 'unspecified');
      setSecure(initialCookie.secure);
      setHttpOnly(initialCookie.httpOnly);
      setSession(initialCookie.session);
      setHostOnly(initialCookie.hostOnly);
      setExpiryInput(toDatetimeLocalValue(initialCookie.expirationDate));
      setPartitionTopLevelSite(initialCookie.partitionKey?.topLevelSite || '');
    } else {
      setName('');
      setValue('');
      setDomain(siteKey);
      setPath('/');
      setSameSite('lax');
      setSecure(true);
      setHttpOnly(false);
      setSession(false);
      setHostOnly(isLocalOrSingleLabelDomain(siteKey));
      const oneYearLater = Math.floor(Date.now() / 1000) + 86400 * 365;
      setExpiryInput(toDatetimeLocalValue(oneYearLater));
      setPartitionTopLevelSite('');
    }
  }, [open, initialCookie, siteKey]);

  const isHostPrefix = name.startsWith('__Host-');
  const isSecurePrefix = name.startsWith('__Secure-');
  const warnings: string[] = [];
  if (sameSite === 'no_restriction' && !secure) {
    warnings.push('SameSite=None 在 Chromium 中必须同时开启 Secure，否则写入会被拒绝。');
  }
  if (isHostPrefix && (!secure || path !== '/' || !hostOnly)) {
    warnings.push('__Host- 前缀 Cookie 要求 Secure=true、Path="/" 且 HostOnly=true。');
  }
  if (isSecurePrefix && !secure) {
    warnings.push('__Secure- 前缀 Cookie 要求 Secure=true。');
  }
  if (!hostOnly && isLocalOrSingleLabelDomain(domain)) {
    warnings.push('localhost / IP / 单段主机名在 Chromium/Edge 中始终为 HostOnly，保存时将自动规范化。');
  }

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    const trimmedDomain = domain.trim();
    if (!trimmedName) {
      setError('请输入 Cookie 名称 (name)');
      return;
    }
    if (!trimmedDomain) {
      setError('请输入域名 (domain)');
      return;
    }

    let expirationDate: number | undefined;
    if (!session && expiryInput) {
      const parsedMs = new Date(expiryInput).getTime();
      if (Number.isNaN(parsedMs)) {
        setError('过期时间格式无效');
        return;
      }
      expirationDate = Math.floor(parsedMs / 1000);
    }

    const payload: BrowserCookieInput = {
      name: trimmedName,
      value,
      domain: trimmedDomain,
      path: path.trim() || '/',
      sameSite,
      secure,
      httpOnly,
      session,
      expirationDate: session ? undefined : expirationDate,
      hostOnly,
      storeId:
        initialCookie?.storeScope && initialCookie.storeScope !== 'default' ? initialCookie.storeScope : undefined,
      partitionKey: partitionTopLevelSite.trim()
        ? {
            topLevelSite: partitionTopLevelSite.trim(),
            hasCrossSiteAncestor: initialCookie?.partitionKey?.hasCrossSiteAncestor,
          }
        : null,
    };

    setSubmitting(true);
    setError(null);
    try {
      await onSave(payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title={isEdit ? `编辑 Cookie：${initialCookie?.name}` : `新建 Cookie (${siteKey})`}
      description="保存后将写入当前同步轨道、生成新因果版本并尝试回读校验应用至浏览器。"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={submitting}>
            {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {isEdit ? '保存并同步' : '创建并同步'}
          </Button>
        </>
      }>
      <div className="space-y-3 text-xs">
        <div className="grid grid-cols-2 gap-2.5">
          <div className="space-y-1">
            <Label htmlFor="ck-name" className="text-xs">
              名称 (Name) *
            </Label>
            <Input
              id="ck-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例如 session_id"
              className="h-8 text-xs font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ck-domain" className="text-xs">
              域名 (Domain) *
            </Label>
            <Input
              id="ck-domain"
              value={domain}
              onChange={e => setDomain(e.target.value)}
              placeholder={siteKey}
              className="h-8 text-xs font-mono"
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="ck-value" className="text-xs">
            值 (Value)
          </Label>
          <textarea
            id="ck-value"
            rows={3}
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="Cookie 值..."
            className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div className="space-y-1">
            <Label htmlFor="ck-path" className="text-xs">
              路径 (Path)
            </Label>
            <Input
              id="ck-path"
              value={path}
              onChange={e => setPath(e.target.value)}
              placeholder="/"
              className="h-8 text-xs font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ck-samesite" className="text-xs">
              SameSite
            </Label>
            <select
              id="ck-samesite"
              value={sameSite}
              onChange={e => setSameSite(e.target.value as SameSiteValue)}
              className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
              <option value="unspecified">Unspecified</option>
              <option value="lax">Lax</option>
              <option value="strict">Strict</option>
              <option value="no_restriction">None (no_restriction)</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/25 p-2.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="ck-secure" className="text-xs cursor-pointer">
              Secure (仅 HTTPS)
            </Label>
            <Switch id="ck-secure" className="scale-75" checked={secure} onCheckedChange={setSecure} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="ck-httponly" className="text-xs cursor-pointer">
              HttpOnly
            </Label>
            <Switch id="ck-httponly" className="scale-75" checked={httpOnly} onCheckedChange={setHttpOnly} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="ck-hostonly" className="text-xs cursor-pointer">
              HostOnly (精确主机)
            </Label>
            <Switch id="ck-hostonly" className="scale-75" checked={hostOnly} onCheckedChange={setHostOnly} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="ck-session" className="text-xs cursor-pointer">
              Session (关闭即过期)
            </Label>
            <Switch id="ck-session" className="scale-75" checked={session} onCheckedChange={setSession} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div className="space-y-1">
            <Label htmlFor="ck-expiry" className="text-xs">
              过期时间 (Expiration)
            </Label>
            <Input
              id="ck-expiry"
              type="datetime-local"
              value={expiryInput}
              disabled={session}
              onChange={e => setExpiryInput(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ck-partition" className="text-xs">
              CHIPS PartitionKey (可选)
            </Label>
            <Input
              id="ck-partition"
              value={partitionTopLevelSite}
              onChange={e => setPartitionTopLevelSite(e.target.value)}
              placeholder="例如 https://example.com"
              className="h-8 text-xs font-mono"
            />
          </div>
        </div>

        {warnings.length > 0 ? (
          <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-300 space-y-1">
            {warnings.map((w, idx) => (
              <div key={idx} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        ) : null}

        {error ? <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}
      </div>
    </Modal>
  );
};
