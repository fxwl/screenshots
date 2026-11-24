import { X } from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../../libs/utils';

interface DialogContextValue {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}

const DialogContext = React.createContext<DialogContextValue>({ open: false });

export interface DialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

const Dialog: React.FC<DialogProps> = ({ open, onOpenChange, children }) => {
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange?.(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  const value = React.useMemo(() => ({ open, onOpenChange }), [open, onOpenChange]);

  if (!open) return null;

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
};
Dialog.displayName = 'Dialog';

export interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  hideCloseButton?: boolean;
  closeOnBackdropClick?: boolean;
}

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  ({ className, children, hideCloseButton = false, closeOnBackdropClick = true, ...props }, ref) => {
    const { open, onOpenChange } = React.useContext(DialogContext);
    if (!open) return null;

    const node = (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px] animate-in fade-in-0"
        role="presentation"
        onMouseDown={e => {
          if (closeOnBackdropClick && e.target === e.currentTarget) {
            onOpenChange?.(false);
          }
        }}>
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          className={cn(
            'relative z-50 grid w-full max-w-lg max-h-[88vh] overflow-y-auto gap-4 rounded-xl border border-border bg-background p-6 text-foreground shadow-xl',
            className,
          )}
          {...props}>
          {children}
          {!hideCloseButton && onOpenChange ? (
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
              className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground opacity-75 transition-opacity hover:bg-muted hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
    );

    if (typeof document !== 'undefined') {
      return createPortal(node, document.body);
    }
    return node;
  },
);
DialogContent.displayName = 'DialogContent';

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-left pr-6', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, children, ...props }, ref) => (
    <h3 ref={ref} className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props}>
      {children}
    </h3>
  ),
);
DialogTitle.displayName = 'DialogTitle';

const DialogDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
  ),
);
DialogDescription.displayName = 'DialogDescription';

const DialogClose = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ onClick, ...props }, ref) => {
    const { onOpenChange } = React.useContext(DialogContext);
    return (
      <button
        ref={ref}
        type="button"
        onClick={e => {
          onClick?.(e);
          onOpenChange?.(false);
        }}
        {...props}
      />
    );
  },
);
DialogClose.displayName = 'DialogClose';

// Convenient Modal aliases
const Modal = Dialog;
const ModalContent = DialogContent;
const ModalHeader = DialogHeader;
const ModalFooter = DialogFooter;
const ModalTitle = DialogTitle;
const ModalDescription = DialogDescription;
const ModalClose = DialogClose;

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
};
