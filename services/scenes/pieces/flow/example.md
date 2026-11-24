# Flow

An order passes along a flow chart built as it is said: a payment question with its own outcome, and a check that sends the box back once before it passes.

Narration: "An order is placed, and the payment has to clear; if it does not, the order is cancelled. Once paid, the box is packed and goes to the quality check. This one fails, so it goes back to be packed again. The second time it passes, and it is shipped."

```scene
@0
text t "From order to doorstep" role=title
run flow f steps="Order placed|Payment clears?|Packed|Quality check?|Shipped" ways="|no:Order cancelled||fail:>3|" path="yes|fail|pass" thing="Order" w=1000 h=1150
```
