import * as React from "react";
import { cn } from "../lib/utils";
import { MAIN_CONTENT_ID } from "./skip-to-main";

interface MainProps {
  className?: string;
  children: React.ReactNode;
}

export function Main({
  className,
  children,
}: MainProps): React.ReactElement {
  return (
    <div
      id={MAIN_CONTENT_ID}
      className={cn(
        "@container/content",
        "mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6",
        className,
      )}
    >
      {children}
    </div>
  );
}
