# Bars computed from a rule

A quantity that changes by a rule: a program computes every bar from the rule, grows them on the words, and measures what it claims.

Narration: "Savings earn interest on their interest. Each year the balance grows by the same share of itself, so every bar is taller than the last, and after ten years the steps are far bigger than at the start."

The formula is set by `math`; the program grows the bars from @6 to @28, and `measure` sends back each bar's value so the build can show the rule held. The first bar is there from the first frame.

```scene
program growth years=10 rate=0.1 grow=0 full=0 doc="A balance that earns a fixed share each year: one bar a year, each the one before times 1 + rate." proves="each bar is the one before times 1 + rate"
  const n = args.years, gap = W / (n + 1), base = H * 0.97, top = H * 0.03;
  const most = Math.pow(1 + args.rate, n);
  path("axis", { points: [0, base, W, base], stroke: "ink", strokeWidth: 6 });
  for (let k = 0; k <= n; k++) {
    const v = Math.pow(1 + args.rate, k), h = (base - top) * v / most;
    const bar = path("y" + k, { x: gap * (k + 0.5), y: base, points: rect(-gap * 0.36, -h, gap * 0.72, h), closed: 1, fill: k === n ? "accent" : "ink" });
    if (k === 0) continue;
    const at = lerp(args.grow, args.full, k / n);
    key(bar, "scaleY", T0, 0); key(bar, "scaleY", at, 0); key(bar, "scaleY", at + 8, 1, "out");
    measure("bar", at + 8, v);
  }
end

@0
math f latex="A = P\,(1 + r)^{t}" role=title
run growth g w=1000 h=1300 grow=@6 full=@28
tag g.y0 "first year" side=right
@28 keep
drop tag.g.y0
tag g.y10 "ten years" side=left
```
