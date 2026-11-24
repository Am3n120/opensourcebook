# Table

Three materials compared on three features, a row filling as each is named.

Narration: "Glass is clear and recyclable but it breaks. Plastic is light but hard to recycle. Steel is strong and recyclable, though heavy."

```scene
@0
text t "Which bottle?" role=title
run table m rows="Material|Light|Unbreakable|Recyclable;Glass|no|no|yes;Plastic|yes|yes|no;Steel|no|yes|yes" highlight=Steel w=1000 h=900
```
