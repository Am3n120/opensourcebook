import { useId } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { errorText, isApiError } from "../api/errors";
import { codeSrc, usePhone } from "../feed/usePhone";
import { OutlineButton, PrimaryButton } from "../design/Buttons";
import { Icon } from "../design/Icon";
import { useDismiss } from "../design/useDismiss";
import "./phoneDialog.css";

/**
 * "Open on your phone", from the bottom-left link on every top-level page:
 * the real pairing code, three steps, and what to know (the code works once;
 * plain HTTP on the home network). Turning listening on is the person's own
 * click here, never a side effect of opening the dialog.
 */
export function PhoneDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const { client, status, busy, error, act } = usePhone();
  const box = useDismiss<HTMLDivElement>(true, onClose);
  const s = status.data;
  const offline = isApiError(status.error, "phone_unavailable");
  const paired = s?.devices.length ?? 0;
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="pd" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="pd-h">
          <h2 id={titleId}>Open on your phone</h2>
          <button type="button" className="ib" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {!s ? (
          <p className="pd-note">
            {status.loading ? "Checking…" : offline ? "Opening Open Sourcebook on a phone needs it started the usual way, with all its parts, not the web app alone." : errorText(status.error)}
          </p>
        ) : !s.on ? (
          <div className="pd-off">
            <p className="pd-note">Open Sourcebook listens on this computer only. Turn this on to watch what you made on your phone, on the same Wi-Fi.</p>
            <PrimaryButton disabled={busy} icon="share" onClick={() => void act(() => client.phoneOn())}>
              Open on your phone
            </PrimaryButton>
          </div>
        ) : (
          <>
            <div className="pd-main">
              {s.code ? (
                <img className="pd-qr" src={codeSrc(s.code.svg)} alt="QR code to open Open Sourcebook on your phone" width={200} height={200} />
              ) : (
                <p className="pd-qr none">The last code was used or ran out.</p>
              )}
              <div className="pd-side">
                <ol>
                  <li>Be on the same Wi-Fi as this computer.</li>
                  <li>Point your phone's camera at the code and open the link.</li>
                  <li>Your phone opens your projects, then the Library tab to watch what you made.</li>
                </ol>
                <p className="pd-note">
                  {s.code ? `The code works once, until ${new Date(s.code.expiresAt).toLocaleTimeString(undefined, { timeStyle: "short" })}. ` : ""}
                  Each phone pairs once and stays paired.
                </p>
                <div className="pd-acts">
                  <OutlineButton className="soft" disabled={busy} onClick={() => void act(() => client.phoneCode())}>
                    New code
                  </OutlineButton>
                  <OutlineButton disabled={busy} onClick={() => void act(() => client.phoneOff())}>
                    Stop listening on the network
                  </OutlineButton>
                </div>
              </div>
            </div>
            <p className="pd-warn">Plain HTTP on your home network: it is not encrypted, so use it on a network you trust.</p>
          </>
        )}
        {error !== undefined && (
          <p className="pd-note err" role="alert">
            {errorText(error)}
          </p>
        )}
        {s && (
          <div className="pd-foot">
            <span>{paired === 0 ? "No phone paired yet" : paired === 1 ? "1 phone paired" : `${paired} phones paired`}</span>
            <Link to="/settings#phone" onClick={onClose}>
              Paired phones in Settings
            </Link>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
