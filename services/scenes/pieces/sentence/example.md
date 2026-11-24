# Sentence

A sentence taken apart: who acts, what they do, and to what, each bracketed as it is named.

Narration: "In this sentence the girl is the subject, threw is the verb, and the red ball is the object it lands on."

```scene
@0
text t "Who does what" role=title
run sentence s text="The girl threw the red ball over the fence" marks="girl:subject|threw:verb|the red ball:object" when="@4,@8,@13" w=1000 h=1100
```
