import { useId } from "react";
import { PhoneSettings } from "../../feed/PhoneSettings";
import { SectionHead } from "./SectionHead";

/** Settings › Phone: pairing a phone on the same Wi-Fi, and the phones paired. */
export function PhoneSection() {
  const heading = useId();
  return (
    <section className="sx-sec" aria-labelledby={heading}>
      <SectionHead id={heading} title="Phone">
        Scroll what you made on your phone, on the same Wi-Fi. Each phone pairs once with a code that works one time.
      </SectionHead>
      <PhoneSettings />
    </section>
  );
}
