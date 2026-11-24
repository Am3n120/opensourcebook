# Dot sample

A town where a quarter of people cycle, and a survey of forty that lands close to the truth.

Narration: "Say a quarter of the town cycles to work. Ask forty people picked at random, and the share who cycle in your sample comes out close to that quarter."

```scene
@0
text t "Asking forty people" role=title
run dot-sample s total=300 share=0.25 sample=40 names="cycle" when="@2,@9" w=1000 h=1250
```
