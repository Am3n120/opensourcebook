# Balance

Two reasons on one side, one heavier reason on the other, and the beam tips as each lands.

Narration: "Moving to the city means better jobs and more friends nearby. But the rent is so much higher that it outweighs them both."

```scene
@0
text t "Should we move?" role=title
run balance b left="Better jobs|Friends nearby" right="Higher rent" leftWeights="2,1" rightWeights="4" when="@6,@10,@14" w=1000 h=1300
```
