import { useState } from "react";
import { NavLink, Outlet, useLocation, useSearchParams } from "react-router";
import { Icon } from "../design/Icon";
import { isPhone } from "../feed/phone";
import { PhoneDialog } from "./PhoneDialog";
import { TopBar } from "./TopBar";
import "./shell.css";

/** Top bar with tabs and search, full-width screen body, and plain bottom-left links. */
export function Shell() {
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const onProjects = pathname === "/";
  const onLibrary = pathname === "/library";
  const showSearch = onProjects || onLibrary;
  const q = params.get("q") ?? "";
  const [phoning, setPhoning] = useState(false);

  function setQuery(value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set("q", value);
    else next.delete("q");
    setParams(next, { replace: true });
  }

  // On a phone the Library tab is the feed, which wears its own bar and fills the screen.
  if (onLibrary && isPhone()) return <Outlet />;
  return (
    <div className="shell">
      <TopBar
        {...(showSearch
          ? {
              search: {
                value: q,
                onChange: setQuery,
                placeholder: onLibrary ? "Search what you made" : "Search projects",
                label: onLibrary ? "Search the Library" : "Search projects",
              },
            }
          : {})}
      />
      <main className="main">
        <Outlet />
      </main>
      <footer className="shell-foot">
        <button type="button" className="navphone" aria-haspopup="dialog" onClick={() => setPhoning(true)}>
          <Icon name="share" />
          <span>Open on your phone</span>
        </button>
        <NavLink to="/settings" end>
          <Icon name="settings" />
          <span>Settings</span>
        </NavLink>
      </footer>
      {phoning && <PhoneDialog onClose={() => setPhoning(false)} />}
    </div>
  );
}
