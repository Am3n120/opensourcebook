import { render, screen } from "@testing-library/react";
import { OutlineButton, PrimaryButton } from "./Buttons";

test("the outlined and the filled pill are plain buttons that keep what they are given", () => {
  render(
    <>
      <OutlineButton icon="play" aria-label="Play the quiz">Play</OutlineButton>
      <PrimaryButton wide disabled>Make the video</PrimaryButton>
    </>,
  );
  expect(screen.getByRole("button", { name: "Play the quiz" })).toHaveClass("obtn");
  expect(screen.getByRole("button", { name: "Make the video" })).toHaveClass("pbtn", "wide");
  expect(screen.getByRole("button", { name: "Make the video" })).toBeDisabled();
});
