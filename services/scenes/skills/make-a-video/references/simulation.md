# Programs that run real rules

When the words claim something happens by rule (energy trades between height and speed, a population doubles, heat spreads, waves add up, a count falls), a program can run that rule so what the viewer sees comes out of it instead of being drawn by hand. Knowledge from simulations that worked:

- **Rules first, picture second.** Keep the state in plain variables, step it forward frame by frame with the real rule, and draw from that state. A result is computed every frame from the same values you draw for its causes; never fade, scale or swap a result toward the outcome you want. Change the inputs and let the result follow.
- **The story's timing comes first.** A spoken moment (`settle=@14`) arrives as a frame number in `args`. If the real process is slower or faster than the words, tune the starting conditions, the strength of an effect or how many rule updates run per frame, until what the viewer should see happens on the word, while the rules stay real. Say it is sped up when it is.
- **Nothing before its moment.** Until the word that introduces a thing, draw only what already exists; a result appears at the step that produces it.
- **Measure what proves it.** `measure("name", frame, value)` the one to three numbers that would look different if the rules were wrong (a total that must stay, a count that must fall, a position that must meet another), about once a second, and say in `proves` what they should show. The build gives them back to you, so you see whether the rules did what the words say before anyone watches.
- **Random but repeatable.** `random()` is seeded, so every build draws the same thing.
- **Readable on a phone.** One clear idea, big shapes, strong contrast, very few words; the important thing in `accent`. Fill most of the box (`w=` near the frame's width, `h=` tall on a tall frame).
- **Fast.** It runs once per build, in a sealed box with a time limit; precompute the steps in a loop and write keyframes (`key`, `anim`) rather than thousands of parts.

The pattern, in the language: compute every frame's state in a loop from the rule, then key what you draw from that state. The cookbook's cooling (`references/examples/cooling.md`) is a whole scene that does this.
