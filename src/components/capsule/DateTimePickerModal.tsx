import { useState, useEffect } from "react";
import { format, isValid } from "date-fns";
import { CalendarIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";


interface DateTimePickerModalProps {

  date: Date | null;

  time: string | null;

  onDateChange: (
    date: Date
  ) => void;

  onTimeChange: (
    time: string
  ) => void;

  trigger?: React.ReactNode;

}


/**
 * Canonical creator runtime invariant
 *
 * openAt must always normalize
 * to 12:00 UTC
 */

const CANONICAL_TIME =
  "12:00";


export function DateTimePickerModal({

  date,

  time: _time,

  onDateChange,

  onTimeChange,

  trigger,

}: DateTimePickerModalProps) {

  const [open, setOpen] =
    useState(false);


  /**
   * TEMP BUFFER STATE
   */

  const [
    tempDate,
    setTempDate
  ] =
    useState<Date | null>(
      date
    );


  const [
    dateInput,
    setDateInput
  ] =
    useState("");


  const [
    dateInputError,
    setDateInputError
  ] =
    useState(false);


  /**
   * HARDENING:
   * reject invalid Date instance.
   *
   * Object.prototype.toString.call() replaces bare Number.isNaN check —
   * instanceof Date breaks across iframe / Worker / SSR hydration
   * boundaries where the Date constructor may differ between realms.
   * toString tag comparison is realm-agnostic and portable.
   */

  useEffect(() => {

    if (
      date &&
      (
        Object.prototype.toString.call(date) !== "[object Date]" ||
        !Number.isFinite(date.getTime())
      )
    ) {

      throw new Error(
        "[AETERNA] Invalid date instance"
      );

    }

  }, [date]);


  /**
   * Sync modal buffer when opened
   */

  useEffect(() => {

    if (!open) {

      return;

    }


    setTempDate(date);


    if (date) {

      setDateInput(
        format(
          date,
          "dd.MM.yyyy"
        )
      );

    }

    else {

      setDateInput("");

    }


    setDateInputError(
      false
    );

  }, [
    open,
    date,
  ]);


  const selectedDate =
    tempDate ?? undefined;


  /**
   * HANDLERS
   */

  const handleDateInputChange =
    (
      e:
      React.ChangeEvent<
        HTMLInputElement
      >
    ) => {

      let value =
        e.target.value.replace(
          /[^\d]/g,
          ""
        );


      if (
        value.length > 2
      ) {

        value =
          value.slice(
            0,
            2
          ) +
          "." +
          value.slice(
            2
          );

      }


      if (
        value.length > 5
      ) {

        value =
          value.slice(
            0,
            5
          ) +
          "." +
          value.slice(
            5
          );

      }


      if (
        value.length > 10
      ) {

        value =
          value.slice(
            0,
            10
          );

      }


      setDateInput(
        value
      );


      if (
        value.length === 10
      ) {

        const [
          dd,
          mm,
          yyyy
        ] =
          value.split(
            "."
          );


        /**
         * Canonical UTC parsing
         * replaces date-fns.parse()
         */

        const parsed =
          new Date(
            Date.UTC(
              Number(yyyy),
              Number(mm) - 1,
              Number(dd),
              12, 0, 0, 0
            )
          );


        // PATCH — unified UTC midnight boundary
        // Aligns manual-input "today" comparison with calendar
        // disable path, which already uses setUTCHours.
        // Eliminates local/UTC split on timezone boundaries
        // (UTC+ offsets, DST transitions, mobile drift).

        const todayUtc =
          new Date();

        todayUtc.setUTCHours(
          0,
          0,
          0,
          0
        );


        if (

          isValid(
            parsed
          ) &&

          parsed.getTime() >=
            todayUtc.getTime() &&

          parsed.getUTCDate() ===
            Number(dd) &&

          parsed.getUTCMonth() + 1 ===
            Number(mm)

        ) {

          setTempDate(
            parsed
          );

          setDateInputError(
            false
          );

        }

        else {

          setDateInputError(
            true
          );

        }

      }

      else {

        setDateInputError(
          false
        );

      }

    };


  const handleDateSelect =
    (
      d:
      Date | undefined
    ) => {

      if (!d) {

        return;

      }


      setTempDate(d);


      setDateInput(

        format(
          d,
          "dd.MM.yyyy"
        )

      );

    };


  const handleConfirm =
    () => {

      /**
       * Defensive guard
       */

      if (
        !tempDate ||
        Number.isNaN(
          tempDate.getTime()
        )
      ) {

        return;

      }


      onDateChange(
        tempDate
      );


      /**
       * Enforce canonical time
       */

      onTimeChange(
        CANONICAL_TIME
      );


      setOpen(
        false
      );

    };


  /**
   * RENDER
   */

  return (

    <Dialog

      open={open}

      onOpenChange={
        setOpen
      }

    >

      <DialogTrigger asChild>

        {

          trigger ||

          (

            <Button

              variant="outline"

              size="sm"

              className={cn(

                "gap-2",

                "border-border/60",

                "bg-background",

                "text-foreground",

                "hover:border-border",

                "hover:bg-muted/50",

                "focus-visible:ring-2",

                "focus-visible:ring-ring",

                "focus-visible:ring-offset-2",

                "transition-colors",

              )}

            >

              <CalendarIcon

                className="h-4 w-4 text-muted-foreground"

              />

              Set unlock date

            </Button>

          )

        }

      </DialogTrigger>


      <DialogContent

        className="sm:max-w-[400px] w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto p-4 sm:p-6 aeterna-modal-capsule"

        showClose={false}

      >

        <div className="flex items-center justify-between">

          <DialogTitle>

            Select Unlock Date

          </DialogTitle>

          <button

            type="button"

            onClick={() => setOpen(false)}

            className="rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"

            aria-label="Close"

          >

            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">

              <path d="M18 6 6 18M6 6l12 12" />

            </svg>

          </button>

        </div>

        <div className="space-y-4 py-4">


          {/* Manual input */}

          <div className="flex flex-col items-center gap-2">

            <label

              className="text-sm text-muted-foreground"

            >

              Enter date (DD.MM.YYYY)

            </label>


            <Input

              value={dateInput}

              onFocus={() => {

                setDateInput("");

                setDateInputError(
                  false
                );

              }}

              onChange={
                handleDateInputChange
              }

              className={cn(

                "w-full max-w-[140px]",

                "text-center",

                "font-mono",

                dateInputError &&
                  "border-destructive",

              )}

              maxLength={10}

            />


            {

              dateInputError &&

              (

                <p

                  className="text-xs text-destructive"

                >

                  Invalid date

                </p>

              )

            }

          </div>


          {/* Calendar */}

          <div className="flex justify-center overflow-x-auto w-full">

            <Calendar

              mode="single"

              selected={selectedDate}

              onSelect={
                handleDateSelect
              }

              disabled={(d) => {

                const todayUtc =
                  new Date();

                todayUtc.setUTCHours(
                  0,
                  0,
                  0,
                  0
                );

                return (
                  d.getTime() <
                  todayUtc.getTime()
                );

              }}

              initialFocus

            />

          </div>


          {/* Confirm */}

          <div className="w-full pt-2">

            <Button
              className="w-full"
              onClick={
                handleConfirm
              }
              disabled={
                !tempDate
              }
            >

              Confirm

            </Button>

          </div>

        </div>

      </DialogContent>

    </Dialog>

  );

}