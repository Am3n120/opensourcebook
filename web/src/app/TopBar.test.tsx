import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { TopBar } from "./TopBar";

function Bar({ path = "/" }: { path?: string }) {
  const [value, setValue] = useState("");
  return (
    <MemoryRouter initialEntries={[path]}>
      <TopBar search={{ value, onChange: setValue, placeholder: "Search projects", label: "Search projects" }} />
      <output>{value}</output>
    </MemoryRouter>
  );
}

test("the mark and name go home, the two tabs mark where you are, and search sits at the right", () => {
  render(<Bar path="/library" />);
  expect(screen.getByRole("link", { name: "Open Sourcebook home" })).toHaveAttribute("href", "/");
  const tabs = within(screen.getByRole("navigation", { name: "Main" }));
  expect(tabs.getAllByRole("link").map((l) => l.textContent)).toEqual(["Projects", "Library"]);
  expect(tabs.getByRole("link", { name: "Library" })).toHaveClass("active");
  expect(tabs.getByRole("link", { name: "Projects" })).not.toHaveClass("active");
  expect(screen.getByRole("searchbox", { name: "Search projects" })).toBeInTheDocument();
});

test("the search icon opens the field (a phone shows only the icon), and closing it clears the words", async () => {
  render(<Bar />);
  const header = screen.getByRole("banner");
  const icon = screen.getByRole("button", { name: "Search projects" });
  expect(header).not.toHaveClass("finding");
  await userEvent.click(icon);
  expect(header).toHaveClass("finding");
  expect(screen.getByRole("searchbox")).toHaveFocus();
  await userEvent.type(screen.getByRole("searchbox"), "cells");
  expect(screen.getByRole("status")).toHaveTextContent("cells");
  await userEvent.click(screen.getByRole("button", { name: "Close search" }));
  expect(screen.getByRole("status")).toHaveTextContent("");
  expect(header).not.toHaveClass("finding");
});
