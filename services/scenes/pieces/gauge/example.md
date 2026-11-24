# Gauge

A reading that rises from normal into the high zone, the needle swinging on each number.

Narration: "At rest the heart beats about 70 times a minute. On a steep climb it can pass 150."

```scene
@0
text t "Heart rate" role=title
run gauge g min=40 max=200 values="70,150" zones="low|normal|raised|high" unit=" bpm" label="beats a minute" w=950 h=1100
```
