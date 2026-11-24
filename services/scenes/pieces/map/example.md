# Map

A voyage drawn stop by stop across the real map, each port lit as it is named, with the year it was reached along the bottom.

Narration: "Vasco da Gama sailed from Lisbon in 1497. He rounded the Cape of Good Hope and stopped at Mombasa, then crossed the Indian Ocean to reach Calicut in 1498."

```scene
@0
text t "The sea road to India" role=title
run map m places="Lisbon|Cape of Good Hope:-34.36,18.47|Mombasa|Calicut:11.25,75.77" dates="1497|1497|1498|1498" notes="sets sail|||the spice coast" route=1 highlight=Calicut w=1000 h=1350
```
