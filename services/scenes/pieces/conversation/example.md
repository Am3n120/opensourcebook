# Conversation

Ordering at a café in French, one line at a time.

Narration: "At the café you might hear: bonjour, que désirez-vous? You answer: un café, s'il vous plaît. And the waiter says: tout de suite."

```scene
@0
text t "Ordering a coffee" role=title
run conversation c lines="Waiter: Bonjour, que désirez-vous ?|You: Un café, s'il vous plaît.|Waiter: Tout de suite !" when="@5,@12,@20" w=1000 h=1200
```
