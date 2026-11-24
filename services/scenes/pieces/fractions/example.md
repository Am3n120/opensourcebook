# Fractions

Three ways to write the same amount, the strips lining up as each is shaded.

Narration: "Two thirds of a pizza is the same as four sixths, and the same as eight twelfths: the slices are smaller but there are more of them."

```scene
@0
text t "The same amount" role=title
run fractions f fractions="2/3|4/6|8/12" when="@0,@7,@13" w=1000 h=1000
```
