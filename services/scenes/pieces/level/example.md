# Level

A reservoir that falls through a dry summer and fills again with the autumn rain.

Narration: "By the end of summer the reservoir was down to a fifth of its capacity. The autumn rains brought it back to nearly full."

```scene
@0
text t "The reservoir" role=title
run level r levels="0.2,0.9" start=0.7 marks="empty|half@0.5|full" showPercent=1 when="@6,@16" w=950 h=1300
```
