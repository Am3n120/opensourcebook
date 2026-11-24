# A balloon that fills and rises

A thing with a body drawn by a program, large, its change keyed to the words that say it.

Narration: "Warm air fills the balloon from below. Because warm air is lighter than the cooler air around it, the whole balloon rises."

The program draws the thing itself, large, and its settings take spoken moments, so it fills on @6 and rises from @12. The subject is there from the first frame, small, and grows from it.

```scene
program balloon full=0 rise=0 doc="A balloon that fills with warm air, then floats up."
  const cx = W / 2, cy = H * 0.6;
  const g = group("b", { x: cx, y: cy });
  path("body", { parent: g, points: circle(0, 0, W * 0.38), closed: 1, smooth: 1, fill: "accent" });
  path("string", { parent: g, points: [0, W * 0.38, -24, W * 0.5, 12, W * 0.6], smooth: 1, stroke: "ink", strokeWidth: 8 });
  key(g, "scaleX", T0, 0.25); key(g, "scaleY", T0, 0.25);
  key(g, "scaleX", args.full, 1, "smooth"); key(g, "scaleY", args.full, 1, "smooth");
  key(g, "y", args.rise, cy, "smooth"); key(g, "y", T1, cy - H * 0.25, "smooth");
end

@0
text t "Why it floats" role=title
run balloon air w=1000 h=1300 full=@6 rise=@12
@6 keep
tag air "warm air" side=right
@12 keep
drop tag.air
tag air "lighter" side=left
```
