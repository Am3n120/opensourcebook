# A board that keeps the argument

A whiteboard bigger than the frame: each piece is written where it stays, the camera follows the writing, and the end shows the whole.

Narration: "How does a letter cross the world? First it is collected from the post box in the evening. At the sorting hall a machine reads the address and bags it by city. Days later a carrier delivers it by hand. That is the whole trip, from box to door."

```scene
@0
board b1 w=1 h=3 follow=writing
  text q "How does a letter cross the world?" role=title
@6 keep
stack step1 into=b1 at=50,30
  box post "post box"
  text p1 "collected in the evening"
@17 keep
stack step2 into=b1 at=50,60
  box sort "sorting hall"
  text p2 "read by machine, bagged by city"
arrow post -> sort
@31 keep
text end "delivered by hand" role=answer into=b1 at=50,90
arrow sort -> end
@40 keep
camera b1
```
