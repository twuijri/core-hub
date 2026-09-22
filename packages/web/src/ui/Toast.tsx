/**
 * Our toast, over Radix `Toast`: the note that something happened, when the thing that
 * happened is not worth a dialog and not worth a line in the page.
 *
 * It is never where an error goes that the person must act on — that is a `Notice`, in
 * place, next to the thing that failed (TEAM-RULES §4). A toast says "copied", "saved",
 * "the run was cancelled".
 *
 * The viewport is mounted once, by the app; `useToast()` is how any screen reaches it.
 * Radix handles the swipe, the pause on hover, the focus-safe queue, and the F8 hotkey.
 */
import { Toast as RadixToast } from 'radix-ui';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { IconClose } from './icons.js';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastRequest {
  title: string;
  body?: string;
  tone?: ToastTone;
  /** How long it stays. 0 keeps it until it is dismissed. */
  durationMs?: number;
}

interface Live extends ToastRequest {
  id: number;
}

const ToastContext = createContext<((request: ToastRequest) => void) | null>(null);

export function ToastProvider({
  children,
  closeLabel,
}: {
  children: ReactNode;
  closeLabel: string;
}) {
  const [items, setItems] = useState<Live[]>([]);
  const show = useCallback((request: ToastRequest) => {
    setItems((current) => [...current, { ...request, id: Date.now() + current.length }]);
  }, []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      <RadixToast.Provider swipeDirection="right">
        {children}
        {items.map((item) => (
          <RadixToast.Root
            key={item.id}
            className="mj-toast"
            data-tone={item.tone ?? 'info'}
            duration={item.durationMs ?? 4000}
            onOpenChange={(open) => {
              if (!open) setItems((current) => current.filter((c) => c.id !== item.id));
            }}
          >
            <div className="mj-toast-text">
              <RadixToast.Title className="mj-toast-title" dir="auto">
                {item.title}
              </RadixToast.Title>
              {item.body !== undefined && (
                <RadixToast.Description className="mj-toast-body" dir="auto">
                  {item.body}
                </RadixToast.Description>
              )}
            </div>
            <RadixToast.Close className="mj-toast-close" aria-label={closeLabel}>
              <IconClose size={14} />
            </RadixToast.Close>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="mj-toast-viewport" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

/** Returns a function that shows one toast. Outside a provider it is a no-op, never a crash. */
export function useToast(): (request: ToastRequest) => void {
  const show = useContext(ToastContext);
  return show ?? (() => {});
}
