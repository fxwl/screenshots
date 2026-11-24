import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '../../libs/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/85',
        secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive: 'border-transparent bg-destructive/15 text-destructive dark:bg-destructive/25 dark:text-red-300',
        outline: 'text-foreground border-border',
        success:
          'border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 dark:bg-emerald-500/20',
        warning: 'border-amber-500/30 bg-amber-500/15 text-amber-800 dark:text-amber-300 dark:bg-amber-500/20',
        info: 'border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-300 dark:bg-sky-500/20',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(({ className, variant, ...props }, ref) => {
  return <div ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />;
});
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
