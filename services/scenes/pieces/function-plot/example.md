# Function plot

A ball's height over time drawn from its rule, with the top of its flight marked.

Narration: "Thrown upward, the ball's height follows a curve: it rises fast, slows, peaks at two seconds, then falls back down."

```scene
@0
text t "Up and down again" role=title
run function-plot p f="20*x - 5*x^2" names="height|the top" xmin=0 xmax=4 ymin=0 ymax=24 points="2 20" when="@4,@14" w=1000 h=1100
```
