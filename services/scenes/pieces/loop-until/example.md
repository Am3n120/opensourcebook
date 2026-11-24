# Loop until

Practising a piece of music: round and round until a play-through has no mistakes, each round counted.

Narration: "Play the piece through, then note the mistakes and practise those bars. The first time there are five mistakes, so go round again. The second time, two. The third time, none, and the piece is ready to perform."

```scene
@0
text t "Practise until it is right" role=title
run loop-until l steps="Play it through|Note the mistakes|Practise those bars" check="No mistakes?" rounds=3 notes="five mistakes|two|none" exit="Ready to perform" counter="Try" w=1000 h=1150
```
