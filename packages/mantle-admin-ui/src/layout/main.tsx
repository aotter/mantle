import * as React from "react";
import { cn } from "../lib/utils";
import { MAIN_CONTENT_ID } from "./skip-to-main";

interface MainProps {
  fixed?: boolean;
  fluid?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function Main({
  fixed = false,
  fluid = false,
  className,
  children,
}: MainProps): React.ReactElement {
  return (
    <div
      id={MAIN_CONTENT_ID}
      data-layout={fixed ? "fixed" : "auto"}
      className={cn(
        "@container/content",
        "w-full px-4 py-6 sm:px-6",
        fixed && "flex grow flex-col overflow-hidden",
        !fluid && "mx-auto max-w-[1180px]",
        "flex-1",
        className,
      )}
    >
      {children}
    </div>
  );
}
