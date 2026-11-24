import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { Icon } from "../design/Icon";
import { Logo } from "../design/ui";

export interface TopSearch {
  value: string;
  onChange: (value: string) => void;
  /** What the box says while empty, and what a screen reader calls it. */
  placeholder: string;
  label: string;
}

/**
 * The bar every top-level page wears: the mark and name, the two tabs, and
 * search at the right, which follows the tab. On a phone the name goes and
 * search folds into an icon that opens it.
 */
export function TopBar({ search }: { search?: TopSearch }) {
  const { pathname } = useLocation();
  // The feed's older address still counts as the Library tab.
  const onLibrary = pathname === "/library" || pathname === "/feed";
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const searching = open || Boolean(search?.value);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  function close() {
    search?.onChange("");
    setOpen(false);
  }
  return (
    <header className={`topbar${searching ? " finding" : ""}`}>
      <Link to="/" className="logo" aria-label="Open Sourcebook home">
        <Logo />
      </Link>
      <nav className="topnav" aria-label="Main">
        <NavLink to="/" end>
          Projects
        </NavLink>
        <NavLink to="/library" className={onLibrary ? "active" : ""}>
          Library
        </NavLink>
      </nav>
      <span className="sp" />
      {search && (
        <>
          <button type="button" className="ib topfind-btn" aria-label={search.label} aria-expanded={searching} onClick={() => setOpen(true)}>
            <Icon name="search" />
          </button>
          <label className="topfind">
            <Icon name="search" />
            <input
              ref={field}
              type="search"
              placeholder={search.placeholder}
              aria-label={search.label}
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && close()}
            />
            <button type="button" className="ib topfind-close" aria-label="Close search" onClick={close}>
              <Icon name="x" />
            </button>
          </label>
        </>
      )}
    </header>
  );
}
