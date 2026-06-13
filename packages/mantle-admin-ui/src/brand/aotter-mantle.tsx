import * as React from "react";
import { cn } from "../lib/utils";

export const AOTTER_MANTLE_PACKAGE = "@aotter/mantle";
export const AOTTER_MANTLE_VERSION = __AOTTER_MANTLE_VERSION__;
export const AOTTER_MANTLE_NPM_URL = "https://www.npmjs.com/package/@aotter/mantle";
export const AOTTER_MANTLE_GITHUB_URL = "https://github.com/aotter/mantle";

export type AotterMantleLogoTone = "brand" | "black" | "white" | "current";

export const AOTTER_MANTLE_VIEW_BOX = "0 0 391.23 128";
export const AOTTER_MANTLE_MARK_PATH =
  "M62.27,18.91c-24.86,0-45.09,20.23-45.09,45.09s20.23,45.09,45.09,45.09,45.09-20.23,45.09-45.09-20.23-45.09-45.09-45.09ZM65.07,102.86v-18.98h5.49c1.26,0,2.29-1.03,2.29-2.29v-4.47h11.6c1.26,0,2.29-1.03,2.29-2.29v-20.57c0-1.26-1.03-2.29-2.29-2.29h-5.13v-12.73c0-1.55-1.26-2.8-2.8-2.8s-2.8,1.26-2.8,2.8v12.73h-22.89v-12.73c0-1.55-1.26-2.8-2.81-2.8s-2.8,1.26-2.8,2.8v12.73h-5.13c-1.26,0-2.29,1.03-2.29,2.29v20.57c0,1.26,1.03,2.29,2.29,2.29h11.6v4.47c0,1.26,1.03,2.29,2.29,2.29h5.49v18.98c-20.32-1.45-36.16-18.42-36.16-38.86,0-21.49,17.48-38.97,38.97-38.97s38.97,17.48,38.97,38.97-15.84,37.42-36.16,38.86ZM41.89,73.03v-16.96h14.46c1.94,2.28,5.02,5.87,5.11,5.97.19.19.39.23.52.23s.34-.04.54-.25c.07-.06,1.33-1.44,4.33-4.69.4-.44.8-.87,1.17-1.26h14.63v16.96h-40.75ZM55.78,79.79v-3.15h12.98v3.15h-12.98Z";
export const AOTTER_MANTLE_WORD_PATHS = [
  "M264.97,45.43c-9.28,0-12.87,5.16-12.87,5.16v-5.16h-11.66v44.95h11.66v-27.01c0-2.01.62-8.46,8.78-8.46,4.98,0,7.1,2.53,7.1,8.46v27.01h11.65v-28.83c0-10.84-4.8-16.11-14.66-16.11Z",
  "M311.58,45.05h-10.58v-9.62h-11.39v9.62h-5.7v9.47h5.7v19.6c0,2.54.02,4.87.23,6.99.16,1.59.43,3.08.92,4.46.36,1.03.86,2,1.53,2.86,1,1.3,2.41,2.31,4.12,2.94,1.72.63,3.73.92,6.15.92,2.3,0,4.87-.25,7.44-.66l1.58-.26v-9.58l-2.24.43c-.8.15-1.75.31-2.67.42-.91.11-1.8.19-2.43.19h0c-1.01,0-1.56-.2-1.9-.42-.25-.17-.44-.36-.62-.7-.28-.49-.5-1.31-.6-2.38-.11-1.06-.12-2.36-.12-3.76v-21.05h10.59v-9.47h0Z",
  "M364.95,45.88c-3.18-1.95-6.82-2.79-10.37-2.79-2.3,0-4.74.36-7.13,1.19-3.58,1.24-7.05,3.58-9.59,7.3-2.54,3.72-4.1,8.77-4.1,15.28,0,4.45.72,8.15,1.93,11.19,1.21,3.04,2.91,5.42,4.81,7.23h0s0,0,.01.01c0,0,0,0,0,0h0c2.21,2.16,4.8,3.68,7.65,4.62,2.86.95,5.97,1.35,9.29,1.35,4.54,0,9.43-.75,14.24-2.16l1.36-.4v-9.63l-2.42.71c-4.49,1.32-9.07,2.01-12.86,2.01-1.93,0-3.63-.2-5.06-.63-1.07-.33-1.99-.77-2.78-1.37-1.18-.9-2.13-2.14-2.84-4.03-.56-1.51-.95-3.44-1.09-5.83h27.79l.13-1.75c.07-1.03.11-2.02.11-2.98,0-3.88-.58-7.22-1.65-10.06-1.58-4.25-4.27-7.34-7.46-9.29ZM346.82,60.49c.7-2.61,1.76-4.47,2.96-5.71,1.53-1.55,3.26-2.22,5.21-2.23,1.02,0,1.91.2,2.72.56,1.2.56,2.24,1.51,3.09,3.05.62,1.12,1.12,2.57,1.43,4.33h-15.4Z",
  "M223.68,44.34c-7.95-1.15-15.67.45-22.36,0v13.39s18.16-8.01,21.69-1.26v5.96s-13.41-.35-20.55,6.64c-7.15,6.98-2.5,22.33,7.6,22.22,10.1-.11,13.51-4.34,13.51-4.34v3.53h10.56v-33.66c0-2.64-.91-11.12-10.44-12.48ZM223.22,77.43s-3.75,4.92-10.55,4.35c-5.46-.45-5.79-12.36,10.55-11.56v7.21Z",
  "M177.59,43.56c-4.21,0-7.45,1.02-10.51,3.31-1.35,1.01-2.59,2.24-3.67,3.65-2.64-4.35-7.2-6.96-12.46-6.96s-9.12,1.71-12.31,5.1l-.24-4.14h-10.23l.14,1.84c.23,3.13.33,6.53.33,11.36v32.66h11.05v-27.31c0-1.25.17-2.29.55-3.24,1.01-3.14,3.96-6.53,8.04-6.53,6.57,0,7.28,6.95,7.28,9.94v27.13h11.03v-27.92c0-1.11.2-2.34.53-3.3,1.03-2.92,3.8-5.86,7.63-5.86,5.07,0,7.65,3.82,7.65,11.34v25.73h11.01v-26.69c0-14.85-8.52-20.13-15.81-20.13Z",
];

function aotterMantleLogoToneClass(tone: AotterMantleLogoTone): string {
  switch (tone) {
    case "brand":
      return "text-[#1a3062]";
    case "black":
      return "text-[#040000]";
    case "white":
      return "text-white";
    case "current":
    default:
      return "text-current";
  }
}

export function AotterMantleMark({
  className,
  title,
  tone = "current",
}: {
  className?: string;
  title?: string;
  tone?: AotterMantleLogoTone;
}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 128 128"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={cn(aotterMantleLogoToneClass(tone), className)}
    >
      {title ? <title>{title}</title> : null}
      <path fill="currentColor" d={AOTTER_MANTLE_MARK_PATH} />
    </svg>
  );
}

export function AotterMantleLogo({
  className,
  title,
  tone = "current",
}: {
  className?: string;
  title?: string;
  tone?: AotterMantleLogoTone;
}): React.ReactElement {
  return (
    <svg
      viewBox={AOTTER_MANTLE_VIEW_BOX}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={cn(aotterMantleLogoToneClass(tone), className)}
    >
      {title ? <title>{title}</title> : null}
      <path fill="currentColor" d={AOTTER_MANTLE_MARK_PATH} />
      <g>
        {AOTTER_MANTLE_WORD_PATHS.map((path, index) => (
          <path key={index} fill="currentColor" d={path} />
        ))}
        <rect fill="currentColor" x="317.72" y="33.52" width="10.42" height="57.77" />
      </g>
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
