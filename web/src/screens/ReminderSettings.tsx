import { useState } from "react";
import { reminderState, setReminders, type ReminderState } from "../app/reminders";
import { Switch } from "../design/ui";

/** What a browser that can't remind says, and what to do. */
const CANNOT: Partial<Record<ReminderState, string>> = {
  blocked: "This browser blocks notifications from Open Sourcebook. Allow them in the browser's site settings, then turn reminders on here.",
  unsupported: "This browser cannot show notifications. On a phone, add Open Sourcebook to the home screen first.",
};

/** Turning this device's daily reminder of stages due on or off. */
export function ReminderSettings() {
  const [state, setState] = useState<ReminderState>(() => reminderState());
  const [busy, setBusy] = useState(false);
  async function flip(on: boolean) {
    setBusy(true);
    setState(await setReminders(on));
    setBusy(false);
  }
  const cannot = CANNOT[state];
  return (
    <>
      <div className="card sx-row">
        <span className="sx-two">
          <b>Daily reminder</b>
          <span>Once a day, while Open Sourcebook is open on this device, it tells you which stages are due today or were missed. Kept on this device.</span>
        </span>
        <Switch checked={state === "on"} disabled={busy || cannot !== undefined} label="Daily reminder" onChange={(on) => void flip(on)} />
      </div>
      {cannot && (
        <p className={`sx-banner${state === "blocked" ? " warn" : ""}`} role="status">
          {cannot}
        </p>
      )}
    </>
  );
}
