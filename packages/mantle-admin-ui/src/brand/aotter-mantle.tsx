import * as React from "react";
import { cn } from "../lib/utils";

export const AOTTER_MANTLE_PACKAGE = "@aotter/mantle";
export const AOTTER_MANTLE_VERSION = __AOTTER_MANTLE_VERSION__;
export const AOTTER_MANTLE_NPM_URL = "https://www.npmjs.com/package/@aotter/mantle";
export const AOTTER_MANTLE_GITHUB_URL = "https://github.com/aotter/mantle";

export const AOTTER_MANTLE_MARK_PATH =
  "M62.27,18.91c-24.86,0-45.09,20.23-45.09,45.09s20.23,45.09,45.09,45.09,45.09-20.23,45.09-45.09-20.23-45.09-45.09-45.09ZM65.07,102.86v-18.98h5.49c1.26,0,2.29-1.03,2.29-2.29v-4.47h11.6c1.26,0,2.29-1.03,2.29-2.29v-20.57c0-1.26-1.03-2.29-2.29-2.29h-5.13v-12.73c0-1.55-1.26-2.8-2.8-2.8s-2.8,1.26-2.8,2.8v12.73h-22.89v-12.73c0-1.55-1.26-2.8-2.81-2.8s-2.8,1.26-2.8,2.8v12.73h-5.13c-1.26,0-2.29,1.03-2.29,2.29v20.57c0,1.26,1.03,2.29,2.29,2.29h11.6v4.47c0,1.26,1.03,2.29,2.29,2.29h5.49v18.98c-20.32-1.45-36.16-18.42-36.16-38.86,0-21.49,17.48-38.97,38.97-38.97s38.97,17.48,38.97,38.97-15.84,37.42-36.16,38.86ZM41.89,73.03v-16.96h14.46c1.94,2.28,5.02,5.87,5.11,5.97.19.19.39.23.52.23s.34-.04.54-.25c.07-.06,1.33-1.44,4.33-4.69.4-.44.8-.87,1.17-1.26h14.63v16.96h-40.75ZM55.78,79.79v-3.15h12.98v3.15h-12.98Z";
export function AotterMantleMark({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 128 128"
      aria-hidden
      className={cn(className)}
    >
      <path fill="currentColor" d={AOTTER_MANTLE_MARK_PATH} />
    </svg>
  );
}

export function AdminAttribution(): React.ReactElement {
  return (
    <div
      className={cn(
        "fixed bottom-3 end-3 z-30 hidden items-center gap-2 rounded-full",
        "border border-border/60 bg-background/65 px-2.5 py-1.5 text-xs",
        "text-muted-foreground shadow-[var(--glass-shadow)] backdrop-blur-md md:flex",
      )}
    >
      <AotterMantleMark className="size-4 text-primary" />
      <a
        href={AOTTER_MANTLE_NPM_URL}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-foreground/80 hover:text-primary"
      >
        {AOTTER_MANTLE_PACKAGE}
      </a>
      <span aria-hidden>·</span>
      <a
        href={AOTTER_MANTLE_GITHUB_URL}
        target="_blank"
        rel="noreferrer"
        className="hover:text-primary"
      >
        GitHub
      </a>
      <span aria-label={`version ${AOTTER_MANTLE_VERSION}`}>v{AOTTER_MANTLE_VERSION}</span>
    </div>
  );
}
