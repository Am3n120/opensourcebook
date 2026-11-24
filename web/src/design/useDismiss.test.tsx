import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { useDismiss } from "./useDismiss";

function Menu() {
  const [open, setOpen] = useState(false);
  const box = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  return (
    <div ref={box}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        More
      </button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem">
            Rename
          </button>
          <button type="button" role="menuitem">
            Remove…
          </button>
        </div>
      )}
    </div>
  );
}

test("a menu opened from the keyboard takes focus, moves with the arrows, and Escape gives focus back", async () => {
  render(<Menu />);
  const more = screen.getByRole("button", { name: "More" });
  more.focus();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "Remove…" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}");
  expect(screen.getByRole("menuitem", { name: "Remove…" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(more).toHaveFocus();
});

test("a press outside closes it", async () => {
  render(
    <>
      <Menu />
      <p>Elsewhere</p>
    </>,
  );
  await userEvent.click(screen.getByRole("button", { name: "More" }));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  await userEvent.click(screen.getByText("Elsewhere"));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("a press inside an extra portal ref does not close it", async () => {
  function PortalMenu() {
    const [open, setOpen] = useState(false);
    const extra = useRef<HTMLDivElement>(null);
    const box = useDismiss<HTMLDivElement>(open, () => setOpen(false), extra);
    return (
      <>
        <div ref={box}>
          <button type="button" onClick={() => setOpen(!open)}>
            Toggle
          </button>
        </div>
        {open && (
          <div ref={extra} role="dialog" aria-label="Portal">
            <button type="button">Inside</button>
          </div>
        )}
        <p>Outside</p>
      </>
    );
  }
  render(<PortalMenu />);
  await userEvent.click(screen.getByRole("button", { name: "Toggle" }));
  await userEvent.click(screen.getByRole("button", { name: "Inside" }));
  expect(screen.getByRole("dialog", { name: "Portal" })).toBeInTheDocument();
  await userEvent.click(screen.getByText("Outside"));
  expect(screen.queryByRole("dialog", { name: "Portal" })).not.toBeInTheDocument();
});
