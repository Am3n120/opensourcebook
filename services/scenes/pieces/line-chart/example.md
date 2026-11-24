# Line chart

A count over five decades, the line reaching each decade as it is said.

Narration: "In 1980 the town had two libraries. By 2000 it had five, and by 2020 thirteen, most of them small branches."

```scene
@0
text t "Libraries in town" role=title
run line-chart c values="2,3,5,8,13" labels="1980|1990|2000|2010|2020" w=950 h=1200
@14 keep
light c.last
```
