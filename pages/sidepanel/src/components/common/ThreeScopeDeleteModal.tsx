import type { DeleteScope } from '@sessionmesh/shared';
import { Button, cn } from '@sessionmesh/ui';
import { AlertTriangle, CloudOff, Globe, Laptop, Loader2, Trash2 } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { Modal } from './Modal';

export interface ThreeScopeDeleteModalProps {
  open: boolean;
  onClose: () => void;
  itemTypeLabel: string;
  itemNames: string[];
  onConfirm: (scope: DeleteScope) => Promise<void>;
}

const SCOPE_OPTIONS: Array<{
  scope: DeleteScope;
  title: string;
  subtitle: string;
  detail: string;
  icon: React.ReactNode;
  danger?: boolean;
}> = [
  {
    scope: 'local_only',
    title: '仅删除本机浏览器 (local_only)',
    subtitle: '只清除当前浏览器的本地数据',
    detail: '不会删除云端轨道记录，也不会影响其他设备。若未拉黑该站点，下次拉取同步时可能会重新同步回本机。',
    icon: <Laptop className="h-4 w-4 text-sky-600 dark:text-sky-400" />,
  },
  {
    scope: 'remote_track_only',
    title: '仅清理当前轨道记录 (remote_track_only)',
    subtitle: '只移除云端当前同步轨道中的条目',
    detail: '保留本机当前浏览器数据，且不会向其他设备广播删除墓碑（Tombstone）。适合整理云端冗余轨道数据。',
    icon: <CloudOff className="h-4 w-4 text-amber-600 dark:text-amber-400" />,
  },
  {
    scope: 'all_devices',
    title: '全设备同步删除 · Tombstone (all_devices)',
    subtitle: '删除本机并向同轨道全部设备广播不可逆删除墓碑',
    detail:
      '本机与云端立即删除，并生成因果删除墓碑（Tombstone）。同一同步轨道下的所有其他设备上线后都会自动清除该条目，旧版本无法将其复活。',
    icon: <Globe className="h-4 w-4 text-rose-600 dark:text-rose-400" />,
    danger: true,
  },
];

export const ThreeScopeDeleteModal: React.FC<ThreeScopeDeleteModalProps> = ({
  open,
  onClose,
  itemTypeLabel,
  itemNames,
  onConfirm,
}) => {
  const [selectedScope, setSelectedScope] = useState<DeleteScope>('local_only');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedScope('local_only');
      setSubmitting(false);
    }
  }, [open]);

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await onConfirm(selectedScope);
      onClose();
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
      title={
        <span className="flex items-center gap-1.5 text-rose-600 dark:text-rose-400">
          <Trash2 className="h-4 w-4" />
          确认删除 {itemNames.length} 条 {itemTypeLabel}
        </span>
      }
      description="请选择本次删除的作用域。SessionMesh 严禁隐式跨设备删除，不同作用域影响范围不同。"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            variant={selectedScope === 'all_devices' ? 'destructive' : 'default'}
            size="sm"
            onClick={handleConfirm}
            disabled={submitting}>
            {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {selectedScope === 'all_devices' ? '确认全设备同步删除' : '确认执行删除'}
          </Button>
        </>
      }>
      <div className="space-y-3">
        {itemNames.length > 0 ? (
          <div className="rounded-lg border border-border bg-muted/40 p-2.5">
            <p className="mb-1 text-[11px] font-medium text-muted-foreground">待删除目标：</p>
            <div className="flex flex-wrap gap-1">
              {itemNames.slice(0, 8).map((name, idx) => (
                <code
                  key={`${name}-${idx}`}
                  className="max-w-[200px] truncate rounded bg-background px-1.5 py-0.5 text-[11px] font-mono border border-border">
                  {name}
                </code>
              ))}
              {itemNames.length > 8 ? (
                <span className="text-[11px] text-muted-foreground">等共 {itemNames.length} 项</span>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          {SCOPE_OPTIONS.map(option => {
            const checked = selectedScope === option.scope;
            return (
              <div
                key={option.scope}
                className={cn(
                  'flex items-start gap-2.5 rounded-lg border p-3 transition-colors',
                  checked
                    ? option.danger
                      ? 'border-rose-500 bg-rose-500/10'
                      : 'border-primary bg-primary/5'
                    : 'border-border bg-card hover:bg-muted/40',
                )}>
                <input
                  id={`delete-scope-${option.scope}`}
                  type="radio"
                  name="delete-scope"
                  value={option.scope}
                  checked={checked}
                  onChange={() => setSelectedScope(option.scope)}
                  className="mt-1 h-3.5 w-3.5 cursor-pointer accent-primary"
                />
                <label htmlFor={`delete-scope-${option.scope}`} className="min-w-0 flex-1 cursor-pointer">
                  <span className="flex items-center gap-1.5">
                    {option.icon}
                    <span className="text-xs font-semibold text-foreground">{option.title}</span>
                  </span>
                  <span className="mt-0.5 block text-[11px] font-medium text-foreground/85">{option.subtitle}</span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">{option.detail}</span>
                </label>
              </div>
            );
          })}
        </div>

        {selectedScope === 'all_devices' ? (
          <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-[11px] text-rose-700 dark:text-rose-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>提示：全设备删除后仍可在「历史与后悔药」标签页中通过「恢复此版本」生成新的恢复事件重新生效。</span>
          </div>
        ) : null}
      </div>
    </Modal>
  );
};
