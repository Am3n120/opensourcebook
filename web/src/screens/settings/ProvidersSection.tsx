import { useId, useState } from "react";
import { useSearchParams } from "react-router";
import { useNarrow } from "./useNarrow";
import { errorText } from "../../api/errors";
import type { ProviderPatch } from "../../api/types";
import { useAppData } from "../../app/context";
import { useLoad } from "../../app/useLoad";
import { ProvidersSettings } from "../ProvidersSettings";

/** Settings › Providers: loads the providers, checks them again, and keeps the app's copy in step with each change. */
export function ProvidersSection() {
  const heading = useId();
  const { client, setProviders } = useAppData();
  const providers = useLoad(() => client.providers(), [client]);
  const [checking, setChecking] = useState(false);
  const [saveError, setSaveError] = useState<unknown>();
  // The provider whose details show; a picker opens Settings on one that needs setup (?provider=).
  const [params, setParams] = useSearchParams();
  const selected = params.get("provider") ?? undefined;
  const narrow = useNarrow();
  async function check() {
    setChecking(true);
    setSaveError(undefined);
    try {
      const fresh = await client.providers({ fresh: true });
      providers.set(fresh);
      setProviders?.(fresh);
    } catch (e) {
      setSaveError(e);
    } finally {
      setChecking(false);
    }
  }
  async function change(id: string, patch: ProviderPatch) {
    setSaveError(undefined);
    try {
      const updated = await client.updateProvider(id, patch);
      providers.set(updated);
      setProviders?.(updated);
    } catch (e) {
      setSaveError(e);
    }
  }
  return (
    <section className="sx-sec" aria-labelledby={heading}>
      <ProvidersSettings
        headingId={heading}
        {...(providers.data ? { data: providers.data } : {})}
        failed={providers.error !== undefined}
        checking={checking || providers.loading}
        {...(selected ? { selected } : {})}
        // On a phone a tap opens the details as their own view, so it is a step of its own that Back undoes.
        onSelect={(id) => setParams((now) => (now.set("provider", id), now), { replace: !narrow, preventScrollReset: !narrow })}
        onBack={() => setParams((now) => (now.delete("provider"), now))}
        onChange={change}
        onCheck={() => void check()}
      />
      {saveError !== undefined && <p className="setnote err">{errorText(saveError)}</p>}
    </section>
  );
}
