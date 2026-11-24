# Quadrant

Tasks sorted by how urgent and how important they are, each dropping into its square as it is named.

Narration: "A deadline tomorrow is urgent and important. Exercise matters but can wait. Most emails feel urgent but matter little, and scrolling is neither."

```scene
@0
text t "What to do first" role=title
run quadrant q axes="not urgent|urgent|less important|important" quadrants="Plan it|Do it now|Drop it|Hand it off" labels="Deadline|Exercise|Emails|Scrolling" x="0.85,0.2,0.75,0.15" y="0.85,0.75,0.25,0.12" highlight="Do it now" w=1000 h=1250
```
