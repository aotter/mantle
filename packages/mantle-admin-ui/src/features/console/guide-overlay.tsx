import * as React from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t, type I18nKey } from "../../app/i18n";
import { useAdminRouter } from "../../app/router";

const GUIDE_CLOSED_KEY = "mantle.admin.guide.closed";

interface TourStep {
  readonly key: "collections" | "filters" | "actions" | "reopen";
  readonly selector: string;
  readonly href?: string;
}

function tourSteps(firstCollection: { name: string } | null): readonly TourStep[] {
  const reopen: TourStep = { key: "reopen", selector: '[data-tour="guide-button"]' };
  if (!firstCollection) return [reopen];
  const href = `/admin/c/${encodeURIComponent(firstCollection.name)}`;
  return [
    { key: "collections", selector: `[data-tour="nav-c-${firstCollection.name}"]` },
    { key: "filters", selector: '[data-tour="status-filter"]', href },
    { key: "actions", selector: '[data-tour="entry-actions"]', href },
    reopen,
  ];
}

const STEP_COPY: Record<TourStep["key"], { title: I18nKey; body: I18nKey }> = {
  collections: { title: "guide.collections.title", body: "guide.collections.body" },
  filters: { title: "guide.filters.title", body: "guide.filters.body" },
  actions: { title: "guide.actions.title", body: "guide.actions.body" },
  reopen: { title: "guide.reopen.title", body: "guide.reopen.body" },
};

interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export function GuideOverlay({
  language,
  firstCollection,
  onClose,
}: {
  language: AdminLanguage;
  firstCollection: { name: string } | null;
  onClose: () => void;
}): React.ReactElement {
  const [index, setIndex] = React.useState(0);
  const { location, navigate } = useAdminRouter();
  const steps = React.useMemo(() => tourSteps(firstCollection), [firstCollection]);
  const step = steps[index] ?? steps[0]!;
  const rect = useTargetRect(step);
  const panelPosition = React.useMemo(() => panelStyle(rect), [rect]);
  const isLast = index === steps.length - 1;

  React.useEffect(() => {
    if (!step.href) return;
    const current = `${location.pathname}${location.search}`;
    if (current !== step.href) navigate(step.href);
  }, [location.pathname, location.search, navigate, step]);

  return (
    <div className="admin-guide-overlay" role="dialog" aria-modal="false" aria-labelledby="admin-guide-title">
      {rect ? (
        <div
          className="admin-guide-highlight"
          style={{
            top: rect.top - 8,
            left: rect.left - 8,
            width: rect.width + 16,
            height: rect.height + 16,
          }}
        />
      ) : null}
      <section className="admin-guide-popover" style={panelPosition}>
        <div className="admin-guide-progress">
          <span>{index + 1}</span>
          <small>{steps.length}</small>
        </div>
        <div className="admin-guide-copy">
          <p className="label-eyebrow">AotterMantle</p>
          <h2 id="admin-guide-title">{t(language, STEP_COPY[step.key].title)}</h2>
          <p>{t(language, STEP_COPY[step.key].body)}</p>
        </div>
        <div className="admin-guide-controls">
          <button type="button" className="guide-icon-button" onClick={() => setIndex((v) => Math.max(0, v - 1))} disabled={index === 0} title={t(language, "guide.prev")}>
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button type="button" className="guide-primary-button" onClick={() => isLast ? onClose() : setIndex((v) => Math.min(steps.length - 1, v + 1))}>
            {isLast ? t(language, "guide.finish") : t(language, "guide.next")}
            {!isLast ? <ChevronRight className="size-4" aria-hidden /> : null}
          </button>
          <button type="button" className="guide-icon-button" onClick={onClose} title={t(language, "guide.close")}>
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </section>
    </div>
  );
}

export function useGuideOverlay(): {
  language: ReturnType<typeof usePreferences>["language"];
  open: boolean;
  showGuide: () => void;
  closeGuide: () => void;
} {
  const { language } = usePreferences();
  const [open, setOpen] = React.useState(() => readGuideOpen());

  const showGuide = React.useCallback(() => {
    try {
      localStorage.removeItem(GUIDE_CLOSED_KEY);
    } catch {
      /* ignore */
    }
    setOpen(true);
  }, []);

  const closeGuide = React.useCallback(() => {
    try {
      localStorage.setItem(GUIDE_CLOSED_KEY, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  }, []);

  return { language, open, showGuide, closeGuide };
}

function useTargetRect(step: TourStep): Rect | null {
  const [rect, setRect] = React.useState<Rect | null>(null);

  React.useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(step.selector);
        if (!el) {
          setRect(null);
          return;
        }
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        const next = el.getBoundingClientRect();
        setRect({
          top: next.top,
          left: next.left,
          width: next.width,
          height: next.height,
        });
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step]);

  return rect;
}

function panelStyle(rect: Rect | null): React.CSSProperties {
  if (typeof window === "undefined") return {};
  if (!rect) {
    return {
      top: "5rem",
      left: "50%",
      transform: "translateX(-50%)",
    };
  }

  const panelWidth = Math.min(380, Math.max(280, window.innerWidth - 32));
  const preferRight = rect.left + rect.width + panelWidth + 24 < window.innerWidth;
  const preferLeft = rect.left - panelWidth - 24 > 0;
  const top = Math.min(window.innerHeight - 220, Math.max(16, rect.top));

  if (preferRight) {
    return { top, left: rect.left + rect.width + 18 };
  }
  if (preferLeft) {
    return { top, left: rect.left - panelWidth - 18 };
  }
  return {
    top: Math.min(window.innerHeight - 220, rect.top + rect.height + 18),
    left: "50%",
    transform: "translateX(-50%)",
  };
}

function readGuideOpen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(GUIDE_CLOSED_KEY) !== "1";
  } catch {
    return true;
  }
}
