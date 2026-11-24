# A rule that runs

A small simulation: the program steps a real rule forward and draws from its state, so what is seen comes out of the rule; `measure` sends back the numbers that prove it.

Narration: "A hot cup of tea cools fastest at the start. The warmer it is than the room, the faster it loses heat, so the drop slows as it nears room temperature."

The rule is Newton's law of cooling: each moment the tea loses a share of the gap between it and the room. Nothing is keyed toward an answer; the bar and the number both come from `temp`.

```scene
program cool t0=90 room=20 rate=0.35 doc="A cup cooling by Newton's law: each second it loses a fixed share of how much warmer than the room it is." proves="the gap to the room shrinks by the same share each second, so the fall slows"
  let temp = args.t0;
  const base = H * 0.92, tall = H * 0.8;
  path("tube", { x: W / 2, y: base, points: rect(-70, -tall, 140, tall), closed: 1, stroke: "ink", strokeWidth: 8 });
  const col = path("column", { x: W / 2, y: base, points: rect(-50, -tall, 100, tall), closed: 1, fill: "accent" });
  const room = (args.room - 0) / (100 - 0);
  path("roomline", { x: W / 2, y: base - tall * room, points: [-140, 0, 140, 0], stroke: "ink", strokeWidth: 6 });
  const label = text("reading", { x: W / 2, y: H * 0.04, text: Math.round(temp) + "°C", size: 110 });
  for (let f = T0; f <= T1; f += 2) {
    key(col, "scaleY", f, temp / 100);
    key(label, "text", f, Math.round(temp) + "°C", "step");
    if ((f - T0) % fps === 0) measure("gap", f, temp - args.room);
    temp -= args.rate * (temp - args.room) * (2 / fps);
  }
end

@0
text t "How tea cools" role=title
run cool cup w=900 h=1300
@8 keep
tag cup "fast at first" side=right
@20 keep
drop tag.cup
tag cup "then slower" side=left
```
