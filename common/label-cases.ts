/**
 * The cases the label check (`labels.ts`) is held to, read by the engine's tests and the scenes service's tests alike,
 * so the check the agent meets while it writes and the one Open Sourcebook applies at the end answer the same. Each case is a text a
 * person reads or hears, the labels its writer was handed, the person's own source text, and what in the text points
 * at the writer's material (empty: nothing does).
 */
export interface LabelCase {
  text: string;
  labels: string[];
  sources: string;
  leaks: string[];
}

const BILL = "A bill must be passed in the same form by both chambers. The final vote in the Senate also needs a simple majority.";
const LABELS = ["P1", "P2", "P3", "s1", "s2", "s3"];

export const LABEL_CASES: LabelCase[] = [
  // The subject's own words, used as ordinary vocabulary.
  { text: "Final passage needs a simple majority.", labels: LABELS, sources: BILL, leaks: [] },
  { text: "The final passage of the bill comes after the debate.", labels: LABELS, sources: BILL, leaks: [] },
  { text: "Traders found a passage through the mountains.", labels: LABELS, sources: "The pass was the only way east.", leaks: [] },
  { text: "Explorers looked for the source of the river for centuries.", labels: LABELS, sources: "The Nile rises in the highlands.", leaks: [] },
  { text: "A quote from Lincoln opens the speech.", labels: LABELS, sources: "Lincoln spoke at Gettysburg.", leaks: [] },
  { text: "The passage of time wears the stone down.", labels: LABELS, sources: "Water erodes rock.", leaks: [] },
  { text: "Sources of energy include coal, wind and the sun.", labels: LABELS, sources: "Coal, wind and the sun all give energy.", leaks: [] },
  { text: "She read an excerpt from the novel aloud.", labels: LABELS, sources: "The class read the novel together.", leaks: [] },
  { text: "Each passage of the poem has four lines.", labels: LABELS, sources: "The poem is in quatrains.", leaks: [] },
  { text: "The bird's passage south takes three weeks.", labels: LABELS, sources: "Migration south lasts about three weeks.", leaks: [] },
  // Pointers at the labelled material the viewer never saw.
  { text: "As passage 2 says, the committee can change the bill.", labels: LABELS, sources: BILL, leaks: ["passage 2"] },
  { text: "Source s1 lists three steps.", labels: LABELS, sources: BILL, leaks: ["s1", "Source s1"] },
  { text: "P3 explains the veto.", labels: LABELS, sources: BILL, leaks: ["P3"] },
  { text: "The passage above shows how a veto works.", labels: LABELS, sources: BILL, leaks: ["The passage above"] },
  { text: "This excerpt says most bills die in committee.", labels: LABELS, sources: BILL, leaks: ["This excerpt says"] },
  { text: "According to the source text given, the House starts revenue bills.", labels: LABELS, sources: BILL, leaks: ["According to the source text", "the source text given"] },
  { text: "According to the passage, the House starts revenue bills.", labels: LABELS, sources: BILL, leaks: ["According to the passage"] },
  { text: "Using the passages, what did the enzyme change?", labels: LABELS, sources: "Enzymes lower activation energy.", leaks: ["Using the passages"] },
  { text: "The passage teaches one compact concept.", labels: LABELS, sources: "One compact concept.", leaks: ["The passage teaches"] },
  { text: "In the provided source, the Senate needs 60 votes.", labels: LABELS, sources: BILL, leaks: ["the provided source"] },
  { text: "Look at excerpt #3 for the timeline.", labels: LABELS, sources: BILL, leaks: ["excerpt #3"] },
  // The person's own sources use the term in the same sense: their word, not the writer's.
  { text: "The P1 visa lets athletes compete.", labels: LABELS, sources: "The P1 visa is for athletes.", leaks: [] },
  { text: "The Northwest Passage links two oceans.", labels: LABELS, sources: "The Northwest Passage links the Atlantic and the Pacific.", leaks: [] },
  { text: "Passage 2 of the exam asks about tone.", labels: LABELS, sources: "Read passage 2 and answer the questions on tone.", leaks: [] },
  { text: "S1 is the first heart sound.", labels: LABELS, sources: "The first heart sound, S1, is the closing of the valves.", leaks: [] },
];
