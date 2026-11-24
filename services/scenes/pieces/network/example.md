# Network

A web of who depends on whom, each joining as it is named.

Narration: "In a pond, sunlight feeds the algae, snails and tadpoles graze the algae, and both are eaten by the fish, which the heron hunts."

```scene
@0
text t "Who feeds whom" role=title
run network n links="Sunlight>Algae:feeds|Algae>Snails|Algae>Tadpoles|Snails>Fish|Tadpoles>Fish|Fish>Heron" highlight=Fish w=1000 h=1350
```
