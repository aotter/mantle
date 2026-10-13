import * as React from "react";
import { Check, Copy } from "lucide-react";
import { t } from "../app/i18n";
import type { AdminLanguage } from "../app/preferences";
import { mantleRefOf, type JsonSchema } from "../lib/types";

export function isIdField(name: string, schema?: JsonSchema): boolean {
  return name === "id" || /(?:Id|_id)$/.test(name) || mantleRefOf(schema)?.field === "id";
}

export function shortenId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 7)}…${value.slice(-6)}` : value;
}

export function IdValue({ value, language, href }: { value: string; language: AdminLanguage; href?: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className="group inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
      {href ? (
        <a href={href} className="hover:text-foreground hover:underline" title={value}>{shortenId(value)}</a>
      ) : (
        <span title={value}>{shortenId(value)}</span>
      )}
      <button
        type="button"
        className="hover:text-foreground"
        title={t(language, "collection.copyId")}
        aria-label={`${t(language, "collection.copyId")}: ${value}`}
        onClick={() => void copy()}
      >
        {copied ? (
          <Check className="size-3 text-[color:var(--success)]" aria-hidden />
        ) : (
          <Copy className="size-3 opacity-40 transition-opacity group-hover:opacity-80" aria-hidden />
        )}
      </button>
    </span>
  );
}
