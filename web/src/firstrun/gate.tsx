import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useApi } from "../app/context";
import { useLoad } from "../app/useLoad";
import { needsSetup } from "./rules";

/**
 * Shows `children` unless setup is still to do, then sends the person to the
 * step they left off at. When the engine cannot say, the children show: the
 * app is not held back by a question it cannot answer.
 */
export function FirstRunGate({ children }: { children: ReactNode }) {
  const client = useApi();
  const setup = useLoad(() => client.setup(), [client]);
  if (setup.loading && !setup.data && setup.error === undefined) return null;
  if (setup.data && needsSetup(setup.data)) return <Navigate replace to="/welcome" />;
  return <>{children}</>;
}
