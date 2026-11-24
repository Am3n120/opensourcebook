# Unit grid

Out of twenty people, how many are in each group, coloured in as each is named.

Narration: "Out of every twenty adults, about five are left-handed in at least one task, and one is fully left-handed."

```scene
@0
text t "Twenty adults" role=title
run unit-grid g total=20 count="1,4" names="fully left-handed|left-handed in some tasks" restName="right-handed" shape=person when="@14,@8" w=950 h=1300
```
