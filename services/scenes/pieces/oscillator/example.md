# Oscillator

A pendulum let go on a word, its swing dying away as the trace beside it shrinks.

Narration: "Let the pendulum go and it swings back and forth in the same time every swing, but air slowly takes its energy, and each swing is a little smaller."

```scene
@0
text t "A swing that fades" role=title
run oscillator p kind=pendulum period=1.6 damping=0.6 trace=1 when=@1 w=1000 h=1200
```
