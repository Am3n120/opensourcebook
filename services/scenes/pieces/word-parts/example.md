# Word parts

A long word split into the pieces it was made from, then joined back into the word.

Narration: "Photosynthesis comes from photo, meaning light, and synthesis, meaning putting together. Join them and you have making with light."

```scene
@0
text t "Where the word comes from" role=title
run word-parts w parts="photo|synthesis" meanings="light|putting together" whole="making things with light" when="@3,@8,@14" w=1000 h=1300
```
