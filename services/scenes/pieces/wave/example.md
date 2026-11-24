# Wave

A note gets higher: the same wave, its crests squeezed closer together.

Narration: "A low note is a long, slow wave. Pluck a shorter string and the crests come closer together, and the pitch goes up."

```scene
@0
text t "Higher pitch, shorter waves" role=title
run wave w wavelength="0.8,0.3" amplitude="0.8,0.8" when="@0,@10" lengthName="one wavelength" heightName="loudness" w=1000 h=900
```
