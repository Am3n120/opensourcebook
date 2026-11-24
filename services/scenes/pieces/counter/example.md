# Counter

A running total that climbs on each figure said, filling toward its goal.

Narration: "The appeal raised twelve thousand in its first week, and by the end of the month it had forty one thousand of its fifty thousand goal."

```scene
@0
text t "The appeal" role=title
run counter c values="12000,41000" prefix="£" label="raised so far" goal=50000 goalName="goal" when="@4,@14" w=950 h=1100
```
