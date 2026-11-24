import { extractErrorMessage } from '@src/lib/api';
import { Button } from '@sessionmesh/ui';
import { CloudOff, Laptop, Loader2, Unlink } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { StatusBadge } from './common/Badge';
import { Modal } from './common/Modal';

export type UnmanageSiteScope = 'device_unmanage' | 'space_remove';

export interface UnmanageSiteModalProps {
  siteKey: string | null;
  onClose: () => void;
  onConfirm: (siteKey: string, scope: UnmanageSiteScope) => Promise<void>;
}

export const UnmanageSiteModal: React.FC<UnmanageSiteModalProps> = ({ siteKey, onClose, onConfirm }) => {
  const [scope, setScope] = useState<UnmanageSiteScope>('device_unmanage');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (siteKey) {
      setScope('device_unmanage');
      setError(null);
      setSubmitting(false);
    }
  }, [siteKey]);

  const handleSubmit = async () => {
    if (!siteKey) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(siteKey, scope);
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={!!siteKey}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title={`移出同步管理：${siteKey || ''}`}
      description="选择停止同步的范围。此操作不会清除您当前浏览器中已有的本地登录 Cookie。"
      maxWidthClass="max-w-md"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            size="sm"
            variant={scope === 'space_remove' ? 'destructive' : 'default'}
            disabled={submitting || !siteKey}
            onClick={handleSubmit}>
            {submitting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Unlink className="mr-1 h-3.5 w-3.5" />
            )}
            {scope === 'device_unmanage' ? '确认仅在本机移出' : '确认从整个空间移除'}
          </Button>
        </>
      }>
      <div className="space-y-2.5 text-xs">
        <div
          className={`flex items-start gap-2.5 rounded-xl border p-3 transition-colors ${
            scope === 'device_unmanage' ? 'border-primary bg-primary/[0.06]' : 'border-border bg-card hover:bg-muted/30'
          }`}>
          <input
            id="unmanage-scope-device"
            type="radio"
            name="unmanage-site-scope"
            value="device_unmanage"
            checked={scope === 'device_unmanage'}
            onChange={() => setScope('device_unmanage')}
            className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-primary"
          />
          <label htmlFor="unmanage-scope-device" className="min-w-0 flex-1 cursor-pointer space-y-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <Laptop className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="font-semibold text-foreground">仅在本机移出同步管理</span>
              <StatusBadge tone="success">推荐 · 不影响他人</StatusBadge>
            </span>
            <span className="block text-[11px] leading-relaxed text-muted-foreground">
              本机不再上传或拉取 <strong>{siteKey}</strong>{' '}
              的登录态，不影响云端轨道及其他设备；后续可随时通过「添加同步网站」重新纳管。
            </span>
          </label>
        </div>

        <div
          className={`flex items-start gap-2.5 rounded-xl border p-3 transition-colors ${
            scope === 'space_remove'
              ? 'border-rose-500/60 bg-rose-500/[0.06]'
              : 'border-border bg-card hover:bg-muted/30'
          }`}>
          <input
            id="unmanage-scope-space"
            type="radio"
            name="unmanage-site-scope"
            value="space_remove"
            checked={scope === 'space_remove'}
            onChange={() => setScope('space_remove')}
            className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-rose-600"
          />
          <label htmlFor="unmanage-scope-space" className="min-w-0 flex-1 cursor-pointer space-y-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <CloudOff className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400 shrink-0" />
              <span className="font-semibold text-foreground">从整个同步空间移除</span>
              <StatusBadge tone="danger">清理云端轨道</StatusBadge>
            </span>
            <span className="block text-[11px] leading-relaxed text-muted-foreground">
              从云端空间彻底移除 <strong>{siteKey}</strong> 的所有同步轨道与记录，其他设备也将停止同步该网站。
            </span>
          </label>
        </div>

        {error ? (
          <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-2 text-[11px] text-rose-700 dark:text-rose-300">
            操作失败：{error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
};
