# A pattern seen by its first cases, then run fast

Each of the first four pieces arrives on the word that names it (a half, a quarter, an eighth, a sixteenth), more slowly at first; once the viewer has the rule, the rest arrive quickly under one phrase, and the picture keeps changing for as long as the voice talks about it. The program computes every piece from the rule, so what is shaded is right.

Narration: "Start with one whole square. Cut it in half, and shade one half. Now cut the part that is left in half, and shade one of those pieces: a quarter more. Again, an eighth. Again, a sixteenth. Keep going, faster, and the shaded part creeps toward the whole square but never quite fills it."

```scene
program halves n=10 a=0 b=0 e=0 f=0 c=0 d=0 doc="A square shaded by halves: each piece is half of what is left. The first four pieces arrive at a, b, e and f, the rest spread from c to d." proves="each piece is half of the part not yet shaded"
  const s = Math.min(W, H) * 0.92, x0 = (W - s) / 2, y0 = (H - s) / 2;
  path("edge", { points: rect(x0, y0, s, s), closed: 1, stroke: "ink", strokeWidth: 8 });
  let x = x0, y = y0, w = s, h = s, total = 0;
  for (let k = 1; k <= args.n; k++) {
    let p;
    if (k % 2 === 1) { p = [x, y, w / 2, h]; x += w / 2; w /= 2; } else { p = [x, y, w, h / 2]; y += h / 2; h /= 2; }
    const named = [args.a, args.b, args.e, args.f];
    const at = k <= 4 ? named[k - 1] : lerp(args.c, args.d, (k - 5) / Math.max(1, args.n - 5));
    const piece = path("p" + k, { points: rect(p[0], p[1], p[2], p[3]), closed: 1, fill: "accent", stroke: "ink", strokeWidth: 4 });
    const slow = k <= 2 ? 24 : k <= 4 ? 14 : 5;
    key(piece, "opacity", T0, 0); key(piece, "opacity", at, 0); key(piece, "opacity", at + slow, 1, "out");
    total += 1 / Math.pow(2, k);
    measure("shaded", at + slow, total);
  }
end

@0
text t "Half again" role=title
run halves sq w=1000 h=1000 a=@10 b=@23 e=@32 f=@35 c=@37 d=@44
@12 keep
tag sq.p1 "1/2" side=left
@29 keep
tag sq.p2 "1/4" side=right
@37 keep
drop tag.sq.p1 tag.sq.p2
@50 keep
tag sq.edge "never quite 1" side=bottom
```
