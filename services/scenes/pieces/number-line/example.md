# Number line

A start below zero, then two hops along the line to where the day ends.

Narration: "The morning starts at minus four degrees. By noon it is eight degrees warmer, and by evening three degrees cooler again."

```scene
@0
text t "A day's temperature" role=title
run number-line n from=-6 to=8 marks="-4" names="morning" hops="8,-3" when="@4,@9,@15" w=1000 h=1100
```
