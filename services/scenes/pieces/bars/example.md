# Bars

Three amounts compared, each bar growing as its name is said.

Narration: "Of what a household spends, rent takes the most, food less, and transport least of all."

```scene
@0
text t "Where the money goes" role=title
run bars b labels="Rent|Food|Transport" values="48,30,12" unit="%" highlight=Rent w=950 h=1300
```
