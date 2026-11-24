import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Ctx } from "./context";
import { ApiClient } from "../api/client";
import type { AppData, ProvidersStatus } from "./context";
import type { AgentPick, AgentPickPatch, EdgeKind, FormatDescriptor, ProviderPatch, Providers } from "../api/types";

/** Loads what every screen shares once: the formats, providers, and the Inbox count. */
export function ApiProvider({ client, children }: { client?: ApiClient; children: ReactNode }) {
  const api = useMemo(() => client ?? new ApiClient(), [client]);
  const [formats, setFormats] = useState<FormatDescriptor[]>([]);
  const [formatsError, setFormatsError] = useState<unknown>();
  const [edgeKinds, setEdgeKinds] = useState<EdgeKind[]>([]);
  const [inbox, setInbox] = useState<AppData["inbox"]>();
  const [providers, setProviders] = useState<Providers>();
  const [providersStatus, setProvidersStatus] = useState<ProvidersStatus>("loading");

  useEffect(() => {
    let live = true;
    api.formats().then(
      (f) => live && setFormats(f),
      (e: unknown) => live && setFormatsError(e),
    );
    // Only the plan editor's pick list reads these; without them it keeps the kinds as they are.
    api.edgeKinds().then(
      (k) => live && setEdgeKinds(k),
      () => undefined,
    );
    api.providers().then(
      (p) => {
        if (!live) return;
        setProviders(p);
        setProvidersStatus("ready");
      },
      () => live && setProvidersStatus("failed"),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const retryProviders = useCallback(() => {
    setProvidersStatus("loading");
    api.providers().then(
      (p) => {
        setProviders(p);
        setProvidersStatus("ready");
      },
      () => setProvidersStatus("failed"),
    );
  }, [api]);

  const refreshInbox = useCallback(() => {
    api.inbox({ limit: 200 }).then(
      (page) => setInbox({ count: page.rows.length, more: page.nextCursor !== undefined }),
      () => setInbox(undefined),
    );
  }, [api]);
  useEffect(refreshInbox, [refreshInbox]);

  const refreshProviders = useCallback(
    async (fresh = false) => {
      setProviders(await api.providers({ fresh }));
      setProvidersStatus("ready");
    },
    [api],
  );

  // A screen that read the providers itself hands them on: they are the engine's answer.
  const setReady = useCallback((next: Providers) => {
    setProviders(next);
    setProvidersStatus("ready");
  }, []);

  const updateProvider = useCallback(
    async (id: string, patch: ProviderPatch) => {
      const next = await api.updateProvider(id, patch);
      setProviders(next);
      setProvidersStatus("ready");
      return next;
    },
    [api],
  );

  const saveAgentPick = useCallback(
    async (scope: string, patch: AgentPickPatch) => {
      const { pick } = await api.putProviderPick(scope, patch);
      setProviders((prev) => {
        if (!prev) return prev;
        const picks = { ...(prev.picks ?? {}) };
        if (pick) {
          const entry: AgentPick = {
            ...(pick.agent ? { agent: pick.agent } : {}),
            ...(pick.model ? { model: pick.model } : {}),
            ...(pick.effort ? { effort: pick.effort } : {}),
          };
          picks[scope] = entry;
        } else {
          delete picks[scope];
        }
        if (Object.keys(picks).length === 0) {
          const rest = { ...prev };
          delete rest.picks;
          return rest;
        }
        return { ...prev, picks };
      });
    },
    [api],
  );

  const value = useMemo(
    () => ({ client: api, formats, formatsError, edgeKinds, inbox, refreshInbox, providers, providersStatus, retryProviders, refreshProviders, setProviders: setReady, updateProvider, saveAgentPick }),
    [api, formats, formatsError, edgeKinds, inbox, refreshInbox, providers, providersStatus, retryProviders, refreshProviders, setReady, updateProvider, saveAgentPick],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
