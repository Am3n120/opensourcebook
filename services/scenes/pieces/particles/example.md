# Particles

A scent held on one side of a room spreads out the moment the door between is opened.

Narration: "The scent molecules start on one side, behind a closed door. Open it, and their random wandering spreads them until both sides hold about the same number."

```scene
@0
text t "Why smells spread" role=title
run particles p count=80 start=left wall=1 speeds="1.4" when="@0,@11" w=1000 h=1200
```
