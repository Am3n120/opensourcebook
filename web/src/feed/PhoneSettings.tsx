import { errorText, isApiError } from "../api/errors";
import { PrimaryButton } from "../design/Buttons";
import { Icon } from "../design/Icon";
import { codeSrc, usePhone } from "./usePhone";
import "./phoneSettings.css";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Settings › Phone: "Open on your phone" turns on listening on the home
 * network (remembered by the launcher) and shows the same QR code as the
 * terminal; the paired devices are listed, each with Remove.
 */
export function PhoneSettings() {
  const { client, status, busy, error, act } = usePhone();
  const s = status.data;
  if (!s) {
    const offline = isApiError(status.error, "phone_unavailable");
    return (
      <div className="card phone">
        <p className="setnote">{status.loading ? "Checking…" : offline ? "Opening Open Sourcebook on a phone needs it started the usual way, with all its parts, not the web app alone." : errorText(status.error)}</p>
      </div>
    );
  }
  return (
    <div className="phone-wrap">
      <div className="card phone">
        {!s.on ? (
          <div className="phone-off">
            <p className="setnote">Open Sourcebook listens on this computer only.</p>
            <PrimaryButton icon="share" disabled={busy} onClick={() => void act(() => client.phoneOn())}>
              Open on your phone
            </PrimaryButton>
          </div>
        ) : (
          <div className="phone-on">
            {s.code ? (
              <figure className="phone-qr">
                <img src={codeSrc(s.code.svg)} alt="QR code to open Open Sourcebook on your phone" width={200} height={200} />
                <figcaption>
                  Scan with your phone's camera. Works once, until {new Date(s.code.expiresAt).toLocaleTimeString(undefined, { timeStyle: "short" })}.
                </figcaption>
              </figure>
            ) : (
              <p className="setnote phone-used">The last code was used or ran out.</p>
            )}
            <div className="phone-side">
              <p className="phone-live">
                <span className="dot" aria-hidden="true" />
                Listening on your network
              </p>
              <p className="setnote">
                Phones on this network that you pair can open it at <b>{s.address ?? "this computer's address"}</b>.
              </p>
              <div className="phone-acts">
                <button className="btn soft" type="button" disabled={busy} onClick={() => void act(() => client.phoneCode())}>
                  <Icon name="repeat" />
                  New code
                </button>
                <button className="btn ghost" type="button" disabled={busy} onClick={() => void act(() => client.phoneOff())}>
                  Stop listening on the network
                </button>
              </div>
              <p className="phone-warn">Plain HTTP on your home network: it is not encrypted, so use it on a network you trust.</p>
            </div>
          </div>
        )}
      </div>
      <section className="card phone-devs" aria-label="Paired devices">
        <b>Paired devices</b>
        {s.devices.length === 0 ? (
          <p className="setnote">None yet.</p>
        ) : (
          <ul aria-label="Paired devices">
            {s.devices.map((d) => (
              <li key={d.id}>
                <span className="ab">
                  <b>{d.name}</b>
                  <small>
                    Paired {when(d.pairedAt)} · last seen {when(d.lastSeenAt)}
                  </small>
                </span>
                <button className="mini" type="button" disabled={busy} aria-label={`Remove ${d.name}`} onClick={() => void act(() => client.unpairDevice(d.id))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {error !== undefined && <p className="setnote err">{errorText(error)}</p>}
    </div>
  );
}
