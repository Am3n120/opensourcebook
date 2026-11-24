import type { ClipboardEvent } from "react";

/**
 * Copying part of a reply gives clean text: lists stay lists ("- ", "1. "),
 * table rows read "a | b", maths reads as its TeX, and cite chips, the steps
 * line and other controls (`data-copy="skip"`) are left out, so no number is
 * glued into a word. The copied HTML is the same selection without them.
 */
export function copySelection(event: ClipboardEvent<HTMLElement>): void {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const box = document.createElement("div");
  for (let i = 0; i < selection.rangeCount; i++) box.append(selection.getRangeAt(i).cloneContents());
  box.querySelectorAll("[data-copy='skip'], .citetip").forEach((node) => node.remove());
  const text = plainText(box).replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", text);
  event.clipboardData.setData("text/html", box.innerHTML);
}

const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "PRE", "UL", "OL", "TABLE", "SECTION"]);

/** The words of a copied piece of a reply, laid out as plain text. */
export function plainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return [...node.childNodes].map(plainText).join("");
  // KaTeX keeps the formula's TeX beside what it draws.
  if (node.classList.contains("katex")) {
    const tex = node.querySelector("annotation[encoding='application/x-tex']")?.textContent ?? "";
    return node.closest(".katex-display") ? `$$${tex}$$` : `$${tex}$`;
  }
  const inner = () => [...node.childNodes].map(plainText).join("");
  switch (node.tagName) {
    case "BR":
      return "\n";
    case "LI": {
      const list = node.parentElement;
      const marker = list?.tagName === "OL" ? `${[...list.children].indexOf(node) + 1}. ` : "- ";
      return `${marker}${inner().trim()}\n`;
    }
    case "TR":
      return `${[...node.children].map((cell) => plainText(cell).trim()).join(" | ")}\n`;
    case "PRE":
      return `\n${node.textContent ?? ""}\n\n`;
    default:
      return BLOCKS.has(node.tagName) ? `\n${inner().trim()}\n\n` : inner();
  }
}
