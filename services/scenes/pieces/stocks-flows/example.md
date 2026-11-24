# Stocks and flows

A town of a thousand where a cold passes from the well to the sick, and from the sick to the recovered.

Narration: "At first almost everyone is well. As the cold spreads, people move from well to sick, and a few days later from sick to recovered."

```scene
@0
text t "A cold moves through town" role=title
run stocks-flows s stocks="Well|Sick|Recovered" amounts="990,10,0" flows="Well>Sick:0.25:catch it|Sick>Recovered:0.35:get better" when=@6 w=1000 h=1300
```
