# Shapes, a link, and counting turns

Plain shapes for things named in passing, a link that carries a flow, atoms that build a sum, and a program of ticks that count.

Narration: "A bicycle's gears trade force for speed. The front ring has forty eight teeth and the back one sixteen. So one turn of the pedals turns the back wheel three times. Forty eight divided by sixteen is three, and each tick here is one more turn of the wheel as you pedal along the road."

```scene
program ticks n=24 doc="A dial of tick marks that light up in turn."
  for (let i = 0; i < args.n; i++) {
    const a = TAU * i / args.n, r = Math.min(W, H) * 0.45;
    const id = path("t" + i, { x: W / 2, y: H / 2, points: [Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9, Math.cos(a) * r, Math.sin(a) * r], stroke: "ink", strokeWidth: 8 });
    key(id, "opacity", T0, 0.2);
    key(id, "opacity", lerp(T0, T1, i / args.n), 1, "step");
  }
end

@0
text title "Why a bicycle has gears" role=title
@6 keep
row pair
  circle front "48" w=320
  circle back "16" w=170
link front -- back "chain" id=chain
@14 keep
tag front "one turn"
do pulse front
@19 keep
tag back "three turns"
light back
do flow chain
@26
big: t48=48 sign=÷ t16=16 eq== three=3
run ticks dial until=@50 w=700 h=700
@33 keep
light three
mark ring three
```
