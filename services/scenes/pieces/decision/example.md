# Decision

Can a plant go outside yet? Two questions, and the path for a warm, sheltered spot lights up.

Narration: "First ask: has the last frost passed? If yes, ask whether the spot is sheltered from wind. Yes again means plant it out today."

```scene
@0
text t "Ready to plant out?" role=title
run decision d steps="Last frost passed?>no:Keep it indoors|Last frost passed?>yes:Sheltered spot?|Sheltered spot?>yes:Plant out today|Sheltered spot?>no:Harden it off first" path="yes|yes" w=1000 h=1300
```
