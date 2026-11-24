import type { BadgeTone } from '@src/lib/format';
import { cn } from '@sessionmesh/ui';
import type React from 'react';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-muted-foreground border-border/80',
  primary: 'bg-primary/12 text-primary border-primary/25 dark:bg-primary/20 dark:text-purple-300',
  success: 'bg-emerald-500/12 text-emerald-700 border-emerald-500/25 dark:bg-emerald-500/20 dark:text-emerald-300',
  warning: 'bg-amber-500/15 text-amber-800 border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-300',
  danger: 'bg-rose-500/12 text-rose-700 border-rose-500/25 dark:bg-rose-500/20 dark:text-rose-300',
  info: 'bg-sky-500/12 text-sky-700 border-sky-500/25 dark:bg-sky-500/20 dark:text-sky-300',
};

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ tone = 'neutral', className, children, ...props }) => {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      )}
      {...props}>
      {children}
    </span>
  );
};
