import * as React from "react";
import { Check, Languages, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ADMIN_LANGUAGES,
  usePreferences,
  type AdminLanguage,
  type AdminTheme,
} from "../app/preferences";
import { t } from "../app/i18n";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

export function LanguagePreferenceDropdown({ compact = false }: { compact?: boolean }): React.ReactElement {
  const { language, setLanguage } = usePreferences();
  const current =
    ADMIN_LANGUAGES.find((item) => item.value === language) ?? ADMIN_LANGUAGES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={compact ? "icon-sm" : "sm"}
          aria-label={t(language, "preferences.language")}
          title={t(language, "preferences.language")}
        >
          <Languages aria-hidden />
          <span className={compact ? "sr-only" : "hidden text-xs font-medium sm:inline"}>
            {current.nativeLabel}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[min(28rem,80vh)] w-52 overflow-y-auto">
        <DropdownMenuLabel>
          {t(language, "preferences.language")}
        </DropdownMenuLabel>
        {ADMIN_LANGUAGES.map((item) => (
          <DropdownMenuItem
            key={item.value}
            onSelect={() => setLanguage(item.value)}
            className="justify-between"
          >
            <span>{item.nativeLabel}</span>
            <Check
              aria-hidden
              className={cn(
                "size-4 text-primary",
                item.value === language ? "opacity-100" : "opacity-0",
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThemePreferenceDropdown({ compact = false }: { compact?: boolean }): React.ReactElement {
  const { language, theme, setTheme } = usePreferences();
  const current = themeOptions(language).find((item) => item.value === theme);
  const Icon = current?.icon ?? Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={compact ? "icon-sm" : "sm"}
          aria-label={t(language, "preferences.appearance")}
          title={t(language, "preferences.appearance")}
        >
          <Icon aria-hidden />
          <span className={compact ? "sr-only" : "hidden text-xs font-medium sm:inline"}>
            {current?.label ?? t(language, "preferences.system")}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>
          {t(language, "preferences.appearance")}
        </DropdownMenuLabel>
        {themeOptions(language).map((item) => {
          const ItemIcon = item.icon;
          return (
            <DropdownMenuItem
              key={item.value}
              onSelect={() => setTheme(item.value)}
              className="justify-between"
            >
              <span className="flex items-center gap-2">
                <ItemIcon className="size-4" aria-hidden />
                {item.label}
              </span>
              <Check
                aria-hidden
                className={cn(
                  "size-4 text-primary",
                  item.value === theme ? "opacity-100" : "opacity-0",
                )}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function themeOptions(language: AdminLanguage): ReadonlyArray<{
  value: AdminTheme;
  label: string;
  icon: LucideIcon;
}> {
  return [
    { value: "light", label: t(language, "preferences.light"), icon: Sun },
    { value: "dark", label: t(language, "preferences.dark"), icon: Moon },
    { value: "system", label: t(language, "preferences.system"), icon: Monitor },
  ];
}
