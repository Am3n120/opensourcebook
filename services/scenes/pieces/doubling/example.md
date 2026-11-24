# Doubling

One cell dividing every twenty minutes: six divisions on six words.

Narration: "One bacterium splits in two. Then four, eight, sixteen, thirty two, and after two hours sixty four from that single cell."

```scene
@0
text t "Every twenty minutes" role=title
run doubling d steps=6 factor=2 when="@4,@6,@7,@8,@9,@14" w=1000 h=1200
```
