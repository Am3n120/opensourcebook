# Journey

A parcel goes through its stops in order, one reached as each is named, with a way it did not take and a way back.

Narration: "The parcel leaves the warehouse at night and is sorted at the hub by morning, where a damaged box would be sent back. It rides the van through town and reaches your door by noon. If nobody is home, it goes back on the van for tomorrow."

```scene
@0
text t "A parcel's day" role=title
run journey j stops="Warehouse|Sorting hub|Delivery van|Your door" notes="night|morning||noon" branch="|damaged: sent back||" returns="4>3:nobody home, tried again tomorrow" thing="Parcel" w=1000 h=1150
```
