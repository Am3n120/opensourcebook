# Process

A chain of causes, one step on each phrase, with the word that joins them on each arrow.

Narration: "A late frost kills the blossom. Fewer blossoms mean fewer apples, so prices rise at the market by autumn."

```scene
@0
text t "From frost to prices" role=title
run process p steps="Late frost|Blossom dies|Fewer apples|Prices rise" links="so|so|so" numbered=0 when="@2,@4,@7,@11" w=950 h=1300
```
