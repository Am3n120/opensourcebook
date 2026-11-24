import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScrimClose, ScrimDrawn, Sheet } from "./Sheet";

test("the sheet is named by its title, scrolls its body, and its foot has Cancel and one filled button", async () => {
  const close = vi.fn();
  const make = vi.fn();
  render(
    <Sheet title="Make a video" closeLabel="Back to Made here" onClose={close} primary={{ label: "Make the video", onClick: make }}>
      <p>the settings</p>
    </Sheet>,
  );
  expect(screen.getByRole("region", { name: "Make a video" })).toHaveTextContent("the settings");
  await userEvent.click(screen.getByRole("button", { name: "Make the video" }));
  expect(make).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Back to Made here" }));
  await userEvent.keyboard("{Escape}");
  expect(close).toHaveBeenCalledTimes(3);
});

test("the filled button can wait until something can make it", () => {
  render(<Sheet title="Make a quiz" onClose={() => {}} primary={{ label: "Make the quiz", onClick: () => {}, disabled: true }}>body</Sheet>);
  expect(screen.getByRole("button", { name: "Make the quiz" })).toBeDisabled();
});

test("on its own a sheet draws its scrim, which closes it", async () => {
  const close = vi.fn();
  const { container } = render(<Sheet title="Make a quiz" onClose={close} primary={{ label: "Make", onClick: () => {} }}>body</Sheet>);
  await userEvent.click(container.querySelector(".sheet-scrim")!);
  expect(close).toHaveBeenCalledOnce();
});

test("inside a host that draws the scrim, the host's scrim closes the sheet the sheet's own way", () => {
  const close = vi.fn();
  let handed: (() => void) | null = null;
  const { unmount } = render(
    <ScrimClose.Provider value={(own) => (handed = own)}>
      <ScrimDrawn.Provider value>
        <Sheet title="Make a quiz" onClose={close} primary={{ label: "Make", onClick: () => {} }}>
          body
        </Sheet>
      </ScrimDrawn.Provider>
    </ScrimClose.Provider>,
  );
  expect(document.querySelector(".sheet-scrim")).toBeNull();
  handed!();
  expect(close).toHaveBeenCalledOnce();
  unmount();
  expect(handed).toBeNull();
});

test("Escape leaves the sheet open while a picker is open over it", async () => {
  const close = vi.fn();
  render(
    <Sheet title="Make a quiz" onClose={close} primary={{ label: "Make", onClick: () => {} }}>
      <div className="picker-layer">
        <button type="button">in the picker</button>
      </div>
    </Sheet>,
  );
  screen.getByRole("button", { name: "in the picker" }).focus();
  await userEvent.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
});
