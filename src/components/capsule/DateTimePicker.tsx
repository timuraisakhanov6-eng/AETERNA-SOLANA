import { useMemo, useEffect } from "react";
import { CalendarDays } from "lucide-react";
import { DateTimePickerModal } from "./DateTimePickerModal";

interface DateTimePickerProps {
  date: Date | null;

  /** legacy / compatibility */
  time?: string | null;
  onTimeChange?: (time: string) => void;

  onDateChange: (date: Date) => void;
  disabled?: boolean;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Canonical normalization
 * Date-only UX → fixed 12:00 UTC
 */
export function normalizeOpenAt(date: Date): number {

  /**
   * Fail-closed temporal invariant guard
   *
   * Invalid Date objects must never enter the
   * canonical unlock normalization pipeline.
   *
   * Object.prototype.toString.call() replaces instanceof Date —
   * instanceof breaks across iframe / Worker / SSR hydration
   * boundaries where the Date constructor may differ between realms.
   * toString tag comparison is realm-agnostic and portable.
   */

  if (
    Object.prototype.toString.call(date) !== "[object Date]" ||
    !Number.isFinite(date.getTime())
  ) {
    throw new Error(
      "[AETERNA] Invalid unlock date"
    );
  }

  return Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    12, 0, 0, 0,
  );
}

const CANONICAL_TIME = "12:00";

export function DateTimePicker({
  date,
  time,
  onDateChange,
  onTimeChange,
  disabled = false,
}: DateTimePickerProps): JSX.Element {

  /**
   * Compatibility layer:
   * if time handling exists upstream — force canonical value
   */
  useEffect(() => {
    if (date && onTimeChange && time !== CANONICAL_TIME) {
      onTimeChange(CANONICAL_TIME);
    }
  }, [date, time, onTimeChange]);

  const isComplete = Boolean(date);

  // вынесено чтобы не дублировать ?? (() => {}) дважды
  const handleTimeChange = onTimeChange ?? (() => {});

  /* ========================= FORMATTED DISPLAY ========================= */

  const formattedDate = useMemo(() => {
    if (!date) return null;

    const day   = String(date.getUTCDate()).padStart(2, "0");
    const month = MONTHS[date.getUTCMonth()];
    const year  = date.getUTCFullYear();

    return `${month} ${day}, ${year}`;
  }, [date]);

  return (
    <div className={`space-y-4 ${disabled ? "opacity-60 pointer-events-none" : ""}`}>
      <h3 className="text-sm font-semibold tracking-widest uppercase text-center text-foreground/80">
        SET OPENING CONDITIONS
      </h3>

      {isComplete && formattedDate ? (
        <div className="text-center">
          <DateTimePickerModal
            date={date}
            time={CANONICAL_TIME}
            onDateChange={onDateChange}
            onTimeChange={handleTimeChange}
            trigger={
              <button
                type="button"
                disabled={disabled}
                className="
                  text-2xl sm:text-3xl font-bold tracking-tight
                  text-foreground transition-all
                  hover:text-orange-400
                  disabled:hover:text-foreground
                  focus-visible:outline-none rounded-md
                "
              >
                {formattedDate}
              </button>
            }
          />
          <p className="mt-2 text-xs text-foreground/60">
            Unlock occurs automatically on this date.
          </p>
        </div>
      ) : (
        <div className="flex justify-center pt-2">
          <DateTimePickerModal
            date={date}
            time={CANONICAL_TIME}
            onDateChange={onDateChange}
            onTimeChange={handleTimeChange}
            trigger={
              <button
                type="button"
                disabled={disabled}
                className="
                  group flex items-center gap-4 px-6 py-3.5
                  rounded-xl font-medium text-sm
                  text-orange-900 dark:text-orange-100
                  bg-orange-200/90 dark:bg-orange-900/50
                  border border-orange-400/60 dark:border-orange-400/40
                  transition-colors disabled:opacity-50
                  hover:bg-orange-300/90 dark:hover:bg-orange-900/60
                "
              >
                <CalendarDays size={24} />
                <span>Set unlock date</span>
              </button>
            }
          />
        </div>
      )}
    </div>
  );
}