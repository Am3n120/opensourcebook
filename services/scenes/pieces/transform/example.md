# Transform

Grain becomes bread, one stage at a time, the same thing changing as it passes down the line.

Narration: "It starts as wheat in the field. Milling grinds it into flour. Mixed with water and yeast, it becomes dough, and an hour in the oven turns it into bread."

```scene
@0
text t "From field to loaf" role=title
run transform x stages="Harvest|Mill|Mix and rise|Bake" states="Wheat|Flour|Dough|Bread" shapes="rough|drop|round|wide" w=1000 h=1150
```
