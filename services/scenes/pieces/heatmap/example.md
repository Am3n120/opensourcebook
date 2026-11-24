# Heatmap

How busy a café is through the week, the grid filling day by day until the peak shows.

Narration: "Weekdays are quiet in the morning and busy at lunch. Saturday is busy all day, and Sunday lunch is the busiest hour of the week."

```scene
@0
text t "When the café is full" role=title
run heatmap h values="2,8,5,3;2,9,5,3;3,8,6,4;6,9,8,7;5,10,7,4" rows="Mon|Wed|Fri|Sat|Sun" cols="9am|1pm|4pm|7pm" peakName="Sunday lunch" when="@0,@1,@3,@9,@16" w=1000 h=1200
```
