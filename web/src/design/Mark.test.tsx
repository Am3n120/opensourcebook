import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Logo } from "./ui";

test("the lock-up is the mark and the name; the mark alone leaves the name to the link around it", () => {
  const { container, rerender } = render(<Logo />);
  expect(container.querySelector("svg.mark")).toHaveAttribute("aria-hidden", "true");
  expect(container).toHaveTextContent(/^Open Sourcebook$/);
  rerender(<Logo markOnly />);
  expect(container.querySelector("svg.mark")).not.toBeNull();
  expect(container).toHaveTextContent(/^$/);
});

test("the mark's colours are the app's tokens, so it holds in both themes", () => {
  const { container } = render(<Logo markOnly />);
  const styles = [...container.querySelectorAll("svg.mark > *")].map((el) => el.getAttribute("style"));
  expect(styles).toEqual(["fill: var(--primary);", "fill: var(--onPrimary);", "stroke: var(--primary);", "fill: var(--logo-dot);"]);
});
