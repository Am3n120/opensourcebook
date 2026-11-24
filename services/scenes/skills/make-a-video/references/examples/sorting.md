# A computed demonstration, step by step on the words

A kit that runs the real process: the sort really compares and swaps, and `do steps` ties its steps to the words. The first pass plays a step a word; the rest runs faster under one phrase.

Narration: "Bubble sort walks the list comparing neighbours. Five and two are out of order, so they swap. Five and eight are fine, so they stay. Eight and one swap. Then the same pass repeats until nothing moves, and the list is in order."

```scene
@0
text t "Bubble sort" role=title
sort s data=[5,2,8,1,9] algo=bubble show=boxes
@6 keep
do steps s from=1 to=3 at=@9,@19,@25
@25 keep
do steps s from=4 until=@40
@41 keep
tag s "in order" side=bottom
```
