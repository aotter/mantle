import { appLabels } from "./locale.js";

// Only the App replaces the kit's calendar; Admin keeps its existing picker.
// DateTimePicker still owns the local time and numeric/ISO field conversion.
export function Calendar({ selected, onSelect }: { selected?: Date; onSelect(day: Date | undefined): void }) {
  const value = selected ? `${String(selected.getFullYear()).padStart(4, "0")}-${String(selected.getMonth() + 1).padStart(2, "0")}-${String(selected.getDate()).padStart(2, "0")}` : "";
  return <input type="date" className="rounded-md border bg-background p-3 text-sm" aria-label={appLabels(document.documentElement.lang).fields.dateTimeSelect}
    value={value} onChange={event => {
      if (!event.target.value) { onSelect(undefined); return; }
      const [year, month, day] = event.target.value.split("-").map(Number);
      const date = new Date(0);
      date.setFullYear(year!, month! - 1, day!); date.setHours(0, 0, 0, 0);
      onSelect(date);
    }} />;
}
