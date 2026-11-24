import { createContext, useContext } from "react";
import type { ApiClient } from "../api/client";
import type { AgentPickPatch, EdgeKind, FormatDescriptor, ProviderPatch, Providers } from "../api/types";

export type ProvidersStatus = "loading" | "failed" | "ready";

export interface AppData {
  client: ApiClient;
  /** Every format the engine declares, from GET /v1/formats; empty until loaded. */
  formats: FormatDescriptor[];
  formatsError?: unknown;
  /** The kinds of link between plan items, from GET /v1/edge-kinds; empty until loaded. */
  edgeKinds: EdgeKind[];
  /** Sources in the Inbox; undefined until loaded. `more` when the first page did not hold them all. */
  inbox?: { count: number; more: boolean };
  refreshInbox: () => void;
  /** Connected agents, their models/efforts, and remembered picks by scope; undefined until loaded. */
  providers?: Providers;
  /**
   * Where the providers stand: `loading` while the engine has not answered yet,
   * `failed` when it could not be reached, `ready` once `providers` is the
   * engine's answer. Only `ready` with no agent in it means none is set up.
   */
  providersStatus?: ProvidersStatus;
  /** Asks the engine for the providers again, after `failed`. */
  retryProviders?: () => void;
  refreshProviders?: (fresh?: boolean) => Promise<void>;
  setProviders?: (next: Providers) => void;
  updateProvider?: (id: string, patch: ProviderPatch) => Promise<Providers>;
  saveAgentPick?: (scope: string, patch: AgentPickPatch) => Promise<void>;
}

export const Ctx = createContext<AppData | null>(null);

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppData outside ApiProvider");
  return v;
}

export function useApi(): ApiClient {
  return useAppData().client;
}

export function useFormats(): FormatDescriptor[] {
  return useAppData().formats;
}

export function useEdgeKinds(): EdgeKind[] {
  return useAppData().edgeKinds;
}

/**
 * The providers with where their load stands, for every screen that draws
 * who makes or answers something: draw a quiet loading state while
 * `status` is `loading`, "Couldn't reach the engine" with `retry` when it is
 * `failed`, and say no agent is set up only when it is `ready` with none.
 */
export function useProviders(): { providers?: Providers; status: ProvidersStatus; retry: () => void } {
  const { providers, providersStatus, retryProviders } = useAppData();
  return { ...(providers ? { providers } : {}), status: providersStatus ?? (providers ? "ready" : "loading"), retry: retryProviders ?? (() => undefined) };
}
