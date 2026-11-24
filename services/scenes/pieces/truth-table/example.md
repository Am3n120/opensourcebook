# Truth table

A rule for when the alarm sounds, checked against every case one row at a time.

Narration: "The alarm sounds when the door opens and the system is armed. Check every case: only one row of the four sets it off, while either one alone is enough to light the panel."

```scene
@0
text t "When does it sound?" role=title
run truth-table tt inputs="door|armed" outputs="door and armed|door or armed" true=yes false=no w=1000 h=1000
```
