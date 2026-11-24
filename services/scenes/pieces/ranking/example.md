# Ranking

Four ways to travel ranked by cost, then re-ranked by time, the rows sliding into their new places.

Narration: "By cost, the bus is cheapest, then the train, the car and the plane. But rank them by time, and the order flips."

```scene
@0
text t "Cheapest is slowest" role=title
run ranking r labels="Bus|Train|Car|Plane" values="20,45,60,120" then="9,5,6,2" order=up highlight=Bus cue="flips" w=1000 h=1100
```
