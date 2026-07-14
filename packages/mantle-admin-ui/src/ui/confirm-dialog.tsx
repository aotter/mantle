import * as React from "react";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
import { usePreferences } from "../app/preferences";
import { t } from "../app/i18n";

/** Styled stand-in for `window.confirm` (#444): the media library used
 *  the browser-native confirm for destructive delete, which is visually
 *  inconsistent with the rest of the app's `Dialog`-based modals and
 *  also blocks automated/E2E drivers that don't handle native dialogs.
 *  `useConfirm()` returns a function that resolves to a boolean once
 *  the operator picks Cancel/Confirm, so call sites keep the exact same
 *  "await confirm(...) before proceeding" shape `window.confirm` had. */

interface ConfirmOptions {
  description: string;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = React.createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { language } = usePreferences();
  const [pending, setPending] = React.useState<PendingConfirm | null>(null);

  const confirm = React.useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setPending({ ...options, resolve });
    });
  }, []);

  function settle(result: boolean): void {
    pending?.resolve(result);
    setPending(null);
  }

  const value = React.useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Dialog open={pending != null} onOpenChange={(open) => { if (!open) settle(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(language, "confirm.title")}</DialogTitle>
            <DialogDescription>{pending?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => settle(false)}>
              {t(language, "confirm.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => settle(true)}
            >
              {t(language, "confirm.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm() must be used within <ConfirmProvider>.");
  return ctx.confirm;
}
