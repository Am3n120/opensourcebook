# Venn

Two languages, what each has alone, and what they share in the overlap.

Narration: "Spanish and Italian share most of their grammar and much of their vocabulary. Spanish keeps a sound for j, and Italian doubles its consonants."

```scene
@0
text t "Two close languages" role=title
run venn v sets="Spanish|Italian" onlyA="j sound" onlyB="double consonants" shared="grammar|vocabulary" when="@0,@2,@8" w=1000 h=1200
```
