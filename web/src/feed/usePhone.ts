import { useState } from "react";
import type { PhoneStatus } from "../api/types";
import { useApi } from "../app/context";
import { useLoad } from "../app/useLoad";

/**
 * The launcher's phone control: whether phones on the home network may open
 * the app, the open pairing code and the paired devices. `act` runs one change
 * (turn on, new code, turn off, remove a device) and keeps what it returns.
 */
export function usePhone() {
  const client = useApi();
  const status = useLoad(() => client.phone(), [client]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function act(call: () => Promise<PhoneStatus>) {
    setBusy(true);
    setError(undefined);
    try {
      status.set(await call());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return { client, status, busy, error, act };
}

/** The QR code a status carries, as a picture the browser can draw. */
export function codeSrc(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
