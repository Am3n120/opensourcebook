# Along a route

`do follow` moves a thing along any line on screen at an even speed; `orient=1` turns it to face the way it goes.

Narration: "The school bus leaves the depot, stops at the corner, and takes the long road around the park to reach the school."

```scene
@0
text t "The morning route" role=title
free map w=1000 h=1300
  box depot "depot" w=240 h=140 at=18,15
  box corner "corner" w=240 h=140 at=80,40
  box school "school" w=260 h=150 at=25,88
  circle park "park" w=360 h=360 at=45,58
  dot bus at=18,15
arrow depot -> corner id=leg1
arrow corner -> school bend=0.5 id=leg2
@4 keep
do follow bus path=leg1 frames=60 orient=1
@7 keep
light corner
@12 keep
do follow bus path=leg2 frames=90 orient=1
@20 keep
light school
```
