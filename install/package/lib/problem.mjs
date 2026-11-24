/** Something that went wrong, in a person's words: what happened, and the ONE thing to do next. */
export class Problem extends Error {
  constructor(what, next, cause) {
    super(what);
    this.name = "Problem";
    this.next = next;
    if (cause) this.cause = cause;
  }
}

/** The sentence a person reads for a problem. */
export const told = (problem) => `${problem.message} ${problem.next}`.trim();
