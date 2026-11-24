import { useId } from "react";
import { ReminderSettings } from "../ReminderSettings";
import { SectionHead } from "./SectionHead";

/** Settings › Reminders: this device's daily reminder of stages due. */
export function RemindersSection() {
  const heading = useId();
  return (
    <section className="sx-sec" aria-labelledby={heading}>
      <SectionHead id={heading} title="Reminders">
        Only for plans whose stages you gave days.
      </SectionHead>
      <ReminderSettings />
    </section>
  );
}
