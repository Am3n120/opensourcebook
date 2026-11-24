---
name: teaching
description: How to explain so a person follows and understands - the viewer first, slow the first time and faster once they see it, setting up before acting, what is on screen at each spoken word, keeping the picture alive. Read it before writing a video's words and pictures, and whenever a beat feels flat or rushed.
---

# Moving a person from where they are to where you want them

What the explainers people love have in common is not a look. It is care for the person listening. They know who is watching and what that person already has in their head, they know where they want to take them, and they move them there at a speed a human can follow, with every picture there to help that person understand. This guide is about that care: how to think about the viewer, how to pace, and what to put on screen at each spoken moment. None of it is a rule or a structure to fill in. Read it as what good teachers, animators and storytellers know, and use what this video, this viewer and this request need.

The field behind it has several names. Teachers call it explanation or instruction; researchers study it as multimedia learning and cognitive load (Mayer, Sweller), as how people understand animations (Tversky, Hegarty, Lowe and Boucheix), as attention and event perception in film (Smith, Zacks), and as curiosity and narrative (Loewenstein, Green and Brock). Practitioners call it direction, or simply storytelling. Underneath all of it: a viewer has a small working memory that empties as the video moves on, an eye pulled by whatever changes, and no way to look back. A video is a schedule of what you give that person and when.

## You read everything at once; they hear it once

You see the whole script and every word number at the same time. The viewer gets one word after another, once, while the picture moves. Something said once while something else happens is often not understood at all. So before writing a scene, walk through it as the viewer, moment by moment, and ask at each moment:

- What do they know right now, and what do they not know yet?
- What are they waiting for? (The question in their head, the thing promised.)
- Where is their eye, and is that where the idea is?
- What do they need to see to understand the words they are hearing this second?
- What would be too early to show?

The answers decide the scene. They differ for every viewer: someone meeting a topic for the first time needs the first instance slow and the parts named before they move; someone revising before an exam needs one clear instance and the rest quickly; someone curious needs a gap they can almost close. The brief and what the viewer is said to already know tell you who this is.

## Begin on ground the viewer already stands on

A new idea is easiest to take in when it arrives as the answer to something the viewer already knows and already wonders about: a thing from their day, a situation they have been in, a question they would ask themselves. The abstract part (the diagram, the symbol, the general rule) can then enter as the tool that answers that question, rather than as the first thing on screen. Teachers have long known this as connecting new material to what a learner already holds (Ausubel's advance organizers); work on concreteness fading (Fyfe and colleagues) found that moving from a concrete case toward the abstract form tends to beat starting abstract. Whether a video needs this, and what the familiar ground is, depends on who is watching and what the brief says they already know; a recap for someone who knows the topic may be better starting straight on the idea.

## Say it in your own words, not the source's

The passages are where the facts come from, not the script. Narration that follows a passage sentence by sentence, in its wording and its order, is the source read aloud: the viewer could have read it faster, and the cites, which carry the source's exact words, already show where each fact stands. What a video gives that the page cannot is the explanation around the facts: why it is so, what it is like and what it is not, what would change if one part changed, and the order someone new to it needs, which is rarely the order the author wrote in.

So read the passages for what is true, then put them aside and say it the way you would to the person in front of you: shorter sentences than written prose, the plain word before the technical one (then the technical one, once it has something to stick to), one idea at a time. Keep the source's own phrasing only where the exact words are the point, such as a definition the viewer must learn as written. Look at the shape of what you are explaining before you write it: a process is a chain of causes to watch one link at a time, a comparison is two things side by side, a claim with a reason is the reason shown working. The quote carries a beat's claim in its cite; it does not also need to be the narration.

## Animation is for understanding

Every change on screen spends the viewer's attention, because the eye goes to whatever moves. So a change should be the change in the idea: the row that is being subtracted, the level that rises because the words say it rises, the part of the machine that is pushing the next part. Motion for its own sake (a bounce on a title, a drift on a box, something sliding in to look lively) pulls the eye away from the thing that matters and teaches nothing.

The best animators make the picture do what a good teacher's hand does at a board: point at the thing, bring the two things together that the sentence relates, do the operation where the viewer can watch it happen, and leave the result in place for the next step to use.

## Pacing is care: slow the first time, faster once they see it

The clearest sign that someone is teaching rather than reciting is how the tempo changes as the viewer learns.

The first time a step happens, the viewer does not know what to look at or why it works. So a great explainer sets it up: brings up what is about to be acted on, shows why the move works, does it slowly where it can be watched, and lets the result sit for a moment. The second time, the viewer knows the move, so it goes faster with less said. By the third or fourth time, the viewer is ahead of the picture, and the rest can run quickly, because what is being taught now is the pattern, not the step.

An example from reducing a matrix: a careful explainer does not say "subtract two times row one from row two" and have it done in a second. They pick out row two first. Then they bring up row one and show that two times it starts with the same number as row two, which is the reason the move works. Then they say they will subtract it, and the subtraction happens in front of the viewer, every number changing, the leading number becoming zero. The next row gets the same move faster, and the rows after that quickly, so the viewer sees the trend: everything below the pivot clearing. (Worked as a scene in the make-a-video skill's cookbook: `references/examples/row-reduction.md`.)

A much-watched maths video on the Fourier transform has the same shape at a larger scale. It starts with one concrete signal, a 3 beats a second wave, and asks what operation could take in that graph and give back the number 3. It winds that one wave around a circle at one speed and asks why the drawing has the petals it has. Only when the viewer has watched the winding work slowly on that one case does it sweep across many speeds quickly, then try a 2 beats a second wave in a sentence, then two waves at once, and only then names the general idea. Concrete first, slow first, then fast across many cases, then the name.

Ways to give the viewer time in Open Sourcebook:

- **Spend words where the viewer needs time.** You write the narration as well as the picture, so the narration is where time comes from. A first instance gets more words than its repeats: "Look at row two" is three words that send the eye to the right place before anything happens. A repeat gets one phrase: "Row three, the same way." The pattern after that can get half a sentence.
- **Tie each step of the first instance to the words that say it** (`do steps ... at=@N,@M`), so each change happens as it is said. Let later steps share one phrase (`until=`), and `pace=fast` once the viewer knows the move.
- **Let the result stay.** After a step that changes something, keep it on screen while the next words use it. A result that vanishes before the viewer has read it was not shown.
- **Brisk voice, slow demonstration.** People stay with a lively narrator. Slowness belongs in how much happens per sentence, not in a slow, drawn-out voice.

## Set up before you act

A step lands when the viewer already knows what is about to be acted on and why. A useful order for any step that matters, whatever the subject:

1. Bring the thing up: light it, ring it, move the camera to it, on the word that names it.
2. Show the relation that makes the step work: the multiple that matches, the two parts that touch, the force that pushes.
3. Do the step, on the words that say it, where it can be watched.
4. Leave the result in place, and point at what changed.

Steps that matter less, and repeats, can collapse these into one moment. The order is the teacher's; how much of it a step needs depends on the viewer and on how many times they have seen it.

## What is on screen at each spoken moment

The viewer's eye reaches a named thing about a quarter of a second after its word starts. So the thing the words name should appear, light up or change on that word, or a moment before it, never after. A label that arrives four seconds after it was said, or a number that appears a second and a half before anyone mentions it, makes the voice and the picture feel like two different people. When you place a moment, find the word that names the thing (not the start of the sentence, not the end) and put it there.

The same holds in reverse: when the words move on, the picture moves on. A title that still describes the last idea, or a diagram of the previous step while the voice explains the next, is the voice and the picture disagreeing.

## Keep the picture alive while the voice talks

When the voice keeps talking and nothing on screen changes, viewers stop looking, and the words that were meant to be shown are only heard. Viewers of finished videos noticed it as the picture going dead, often around five seconds of a still frame under a talking voice; the viewer report names every still stretch of three seconds or more, measured from the render, so you can see where yours are. Each sentence that says something new should change something the viewer can see: a part lights, a number arrives, a thing moves, the camera goes to what is being described. This is not motion for its own sake: it is the picture keeping up with the words. If a sentence says nothing the picture can show, it may be a sentence the video does not need.

The opposite also fails: everything moving at once. One thing moves at a time, and it is the thing the words are about.

These two pull the same way, though they can read as opposite. Elsewhere you will read to hold the rest still so the eye has one thing, and to make few moves, a move that carries no change in the idea being noise. That is about each moment: one change at a time, the one the words name, and everything else staying put. Keeping the picture alive is about the stretch: as the sentences go on, that one change keeps coming, a new one for each new thing said. So a picture can have few moves and still never stand still, because every move it has is the idea moving on.

## One picture that keeps growing

Each cut to a new picture asks the viewer to find their place again: what is this, where is the thing from a moment ago, what changed? A picture that stays and gains a part with each sentence spares them that work. What they already understood is still in front of them, and the new part arrives next to it, so the relation between them is visible rather than something to remember. Detail can be added as the words reach it rather than all at the start. And when a part has to become something else, letting the viewer watch it change keeps their eye on it in a way a swap does not. Film research on continuity editing (Smith) and on how viewers split what they see into events (Zacks) points the same way: people follow change more easily when what carries over is clear.

In Open Sourcebook each beat is its own scene, and a scene opens on a cut. A beat can still continue the last one: it can open on the state the previous beat ended with and add to it from there, so the cut lands on the same picture. A fresh picture is the right call when the subject truly changes; this is about not losing the viewer when it does not.

## Draw what is named

When the narration says "a banana", "a dozen eggs" or "a pile of silver", the viewer's mind makes a picture of it. If the screen shows a box with a word in it, or nothing, the viewer is doing the work the video should do. Draw the thing: a dozen as twelve things in a carton, the banana as a banana, the pile as a pile. Where the words compare things, put them side by side at sizes that tell the truth. A scene that only shows its title and a few words while the voice describes something visible is a missed scene.

## Build the mechanism one relation at a time

A mechanism with many parts running at once is a blur the first time. People understand machines and processes by working them out link by link, in the order the cause runs (Hegarty), and they learn far better from an animation that shows two parts interacting at a time, each pair sharing a part with the next, than from the whole running at once (Lowe and Boucheix found the mental model scores rose from about 31 to 43 percent with the same total viewing time). So:

- Name and place the parts before anything moves.
- Run the chain one link at a time, cause first: this pushes that, that turns this.
- Then run the whole, faster, once each link has been seen.

## Questions the viewer can almost answer

Curiosity is strongest when the viewer can nearly answer. A question with no setup is noise; a question after enough has been shown that a guess is possible makes the answer stick, especially when the guess was wrong. When you ask one, put on screen what the viewer needs to guess from, and keep the answer off screen until the words give it (`withhold`).

## Story is a tool, not a template

A story can carry a viewer into a subject: real people, real places, a specific moment, stakes that are felt. A documentary video about a bank heist, for example, sets up the town, the building and the people inside it before the event happens; tells the viewer early what is at stake; walks the event step by step in short sentences; then slows right down for the one moment that matters most (fourteen people squeezed into an airlock built for one) and compresses weeks of investigation into a few lines afterward. The slowing and speeding are the same care as in a maths lesson: time goes where the viewer needs it.

But not every video needs a hook, a story or suspense. A quick how-to, a definition or a recap before an exam is often better when it simply starts with the thing. Whether to use any of this depends on what the person asked for, what the material is and who will watch.

## Watching your own video

Read your narration beside the passages it cites. A sentence that would sit in the source unchanged is restating it; say what it means instead. When you look at a scene's stills, look as the person who has never heard any of this, and ask: at this second, do I know what I am looking at and why? Is the thing being talked about on screen, and is it the thing that is moving? Was I given time to see the step before the next one came? Do I want to know what happens next?

## Sources

- Mayer, R. E., Multimedia Learning (3rd ed., 2020): segmenting, pre-training, signaling, temporal contiguity. Fiorella and Mayer in the Cambridge Handbook of Multimedia Learning (2021).
- Sweller, Ayres and Kalyuga, Cognitive Load Theory (2011), including the transient information effect.
- Renkl and Atkinson (2003), fading worked examples; Kalyuga et al. (2003), the expertise reversal effect.
- Tversky, Morrison and Betrancourt (2002), Animation: can it facilitate? (congruence and apprehension).
- Hegarty (1992), mental animation; Hegarty, Kriz and Cate (2003).
- Boucheix, Lowe, Putri and Groff (2013), cueing animations; Lowe and Boucheix, the composition approach (principled animation design improves comprehension of complex dynamics).
- Rey et al. (2019), meta-analysis of the segmenting effect; Schneider et al. (2018), meta-analysis of signaling.
- Smith (2012), the attentional theory of cinematic continuity; Zacks et al. (2010), event segmentation in film.
- Loewenstein (1994), the information gap; Kang et al. (2009), curiosity and the inverted U.
- Green and Brock (2000), transportation into narratives.
- Ausubel (1960), the use of advance organizers in the learning of meaningful verbal material.
- Fyfe, McNeil, Son and Goldstone (2014), concreteness fading in mathematics and science instruction.
- A visual introduction to the Fourier transform, a maths explainer video (2018), and the lesson page written beside it.
- A documentary video on a bank heist (its transcript).
- The research this grew from: an earlier note on teaching tempo (Nov 2 2026).

## More in this skill

- `references/craft.md`: telling it - openings, a thread through the video, explaining over listing, numbers, endings, length.
- `references/demonstrate.md`: showing an idea working on a concrete example - choosing it, its size, its values, its tempo.
- `references/art-direction.md`: one look across the video - emphasis, scale, motifs, what carries across cuts, caption key words.
- `references/attention.md`: what research knows about watching - attention, load, timing to the voice, pacing, motion, reading on a phone.
