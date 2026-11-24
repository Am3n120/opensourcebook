import { render, screen, within } from "@testing-library/react";
import type { MindMapPiece } from "../../api/types";
import type { PieceProps } from "../pieces";
import { MindMapPieceView } from "./MindMap";

const piece = {
  kind: "mindmap",
  text: "",
  nodes: [
    { id: "a", text: "Cyclin B" },
    { id: "b", text: "CDK1" },
    { id: "c", text: "APC/C" },
  ],
  links: [
    { from: "a", to: "b", text: "activates" },
    { from: "c", to: "a", text: "destroys" },
  ],
} as unknown as MindMapPiece;

function view() {
  const props = { piece, message: {}, sourceById: new Map(), citeNumber: new Map(), onOpenCite: () => undefined, planCard: () => null } as unknown as PieceProps<MindMapPiece>;
  render(<MindMapPieceView {...props} />);
  return within(screen.getByRole("list", { name: "How Cyclin B connects" }));
}

test("an outgoing link shows the engine's words with an arrow away from the open idea", () => {
  const row = view().getByRole("button", { name: "CDK1" }).closest("li")!;
  expect(row).toHaveTextContent(/^CDK1\s*→\s*activates$/);
});

test("an incoming link shows the engine's words with an arrow toward the open idea", () => {
  const row = view().getByRole("button", { name: "APC/C" }).closest("li")!;
  expect(row).toHaveTextContent(/^APC\/C\s*←\s*destroys$/);
});
