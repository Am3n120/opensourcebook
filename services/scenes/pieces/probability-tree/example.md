# Probability tree

Rain or no rain, then the bus late or on time, and the chance of each whole morning.

Narration: "There is a thirty percent chance of rain. When it rains the bus is late six times in ten, and when it is dry only one in ten. So rain and a late bus together happen eighteen percent of the time."

```scene
@0
text t "Will the bus be late?" role=title
run probability-tree pt first="Rain:0.3|Dry:0.7" second="Late:0.6|On time:0.4;Late:0.1|On time:0.9" highlight="Rain>Late" w=1000 h=1200
```
