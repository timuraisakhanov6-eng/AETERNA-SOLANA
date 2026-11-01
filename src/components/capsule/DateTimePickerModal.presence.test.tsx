// @vitest-environment jsdom
/**
 * AETERNA - calendar modal x Creator Presence link (R9-A52).
 *
 * The REAL calendar modal (DateTimePickerModal, the component the creation
 * page opens through DateTimePicker) now carries a single compact link:
 *
 *   "Learn how the Confirm Presence button works ->"
 *
 * Pins:
 *  - the link is always present (Creator Presence is part of every capsule;
 *    there is no enabled/disabled state and no prop to switch it off);
 *  - the R9-A51 long explanation is gone (no heading, no bullets, no card);
 *  - the link follows the Confirm block, so no existing control moves;
 *  - date entry, validation, Confirm and close keep working unchanged.
 *
 * jsdom only. No network, wallet, payment, storage, upload or sealing.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { DateTimePickerModal } from "./DateTimePickerModal";

const CALENDAR_LABEL = "Learn how the Confirm Presence button works →";

const norm = (el: Element | null): string =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

type HarnessProps = {
  onDateChange?: (date: Date) => void;
  onTimeChange?: (time: string) => void;
};

function Harness({ onDateChange, onTimeChange }: HarnessProps) {
  const [date, setDate] = useState<Date | null>(null);

  return (
    <MemoryRouter>
      <DateTimePickerModal
        date={date}
        time="12:00"
        onDateChange={(next) => {
          setDate(next);
          onDateChange?.(next);
        }}
        onTimeChange={(time) => onTimeChange?.(time)}
        trigger={<button type="button">Open calendar</button>}
      />
    </MemoryRouter>
  );
}

const openModal = () => {
  fireEvent.click(screen.getByRole("button", { name: "Open calendar" }));
  return screen.getByRole("dialog");
};

afterEach(() => {
  cleanup();
});

describe("calendar modal - compact Presence link", () => {
  it("always renders the single compact link", () => {
    render(<Harness />);

    const dialog = openModal();

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);

    const link = links[0]!;
    expect(norm(link)).toBe(CALENDAR_LABEL);
    expect(link).toBe(dialog.querySelector("[data-aeterna-presence-link]"));
    expect(link.getAttribute("data-aeterna-presence-link")).toBe("calendar");
    expect(link.getAttribute("href")).toBe("/protocol?section=opening-presence");
    expect(link.getAttribute("target")).toBeNull();
  });

  it("no longer renders the R9-A51 long explanation", () => {
    render(<Harness />);

    const dialog = openModal();
    const body = norm(dialog);

    expect(screen.queryByText("Creator Presence & Opening Date")).toBeNull();
    expect(document.querySelector("[data-aeterna-creator-presence-calendar-note]")).toBeNull();
    expect(body).not.toContain("missing a required confirmation");
    expect(body).not.toContain("postponed by the selected confirmation interval");
    expect(body).not.toContain("The updated opening date will be displayed");
    // No card / banner / bullet list beyond the calendar grid.
    expect(dialog.querySelectorAll("li")).toHaveLength(0);
  });

  it("keeps every existing control in place: the link follows Confirm", () => {
    render(<Harness />);

    const dialog = openModal();
    const link = screen.getByRole("link", { name: CALENDAR_LABEL });
    const confirm = screen.getByRole("button", { name: "Confirm" });

    expect(
      confirm.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(dialog.querySelector('[role="grid"]')).toBeTruthy();
  });

  it("keeps the underlying Protocol copy out of the modal itself", () => {
    render(<Harness />);
    openModal();

    // The modal explains nothing inline; the explanation lives in the Protocol.
    expect(norm(screen.getByRole("dialog"))).not.toMatch(
      /30 days or less|More than 30 days/
    );
  });
});

describe("calendar modal - selection behaviour is unchanged", () => {
  it("accepts a typed date, normalizes it to 12:00 UTC and closes on Confirm", async () => {
    const onDateChange = vi.fn();
    const onTimeChange = vi.fn();

    render(<Harness onDateChange={onDateChange} onTimeChange={onTimeChange} />);
    openModal();

    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "12.12.2030" } });

    expect(input.value).toBe("12.12.2030");
    expect(screen.queryByText("Invalid date")).toBeNull();

    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm);

    expect(onDateChange).toHaveBeenCalledTimes(1);
    const selected = onDateChange.mock.calls[0]?.[0] as Date;
    expect(selected.getTime()).toBe(Date.UTC(2030, 11, 12, 12, 0, 0, 0));
    expect(onTimeChange).toHaveBeenCalledWith("12:00");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("still rejects an invalid typed date", () => {
    render(<Harness />);
    openModal();

    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "31.02.2030" } });

    expect(screen.getByText("Invalid date")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Confirm" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("still closes from the close control", async () => {
    render(<Harness />);
    openModal();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
