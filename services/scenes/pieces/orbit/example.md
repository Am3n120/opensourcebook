# Orbit

The inner planets going round the Sun, each year shorter the closer it is.

Narration: "Mercury races round the Sun in three months. Venus takes seven, Earth a year, and Mars almost two."

```scene
@0
text t "Closer means faster" role=title
run orbit o centre="Sun" bodies="Mercury|Venus|Earth|Mars" periods="0.24,0.62,1,1.88" speed=0.8 w=1000 h=1100
```
