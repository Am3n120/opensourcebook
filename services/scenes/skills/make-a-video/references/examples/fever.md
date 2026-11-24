# A reading that climbs

A gauge drawn as itself whose reading changes on the words, with a tag that says what the number means.

Narration: "A normal body temperature is about thirty seven degrees. With a fever it climbs past thirty eight, and the body is fighting an infection."

`do change thermo value=` moves the reading; the build tells you the gauge's states and their ranges.

```scene
@0
depict thermo "a glass clinical thermometer in degrees Celsius" value=37
tag thermo "normal" side=right
@9 keep
do change thermo value=38.6 frames=45 ease=smooth
drop tag.thermo
tag thermo "fever" side=right
```

```depictions
[
  { "id": "thermo", "desc": "a glass clinical thermometer in degrees Celsius", "spec": { "kind": "gauge", "form": "thermometer", "label": "clinical thermometer", "size": { "w": 2, "h": 14, "unit": "cm" }, "params": { "scale": { "from": 35, "to": 42, "major": 1, "minor": 0.5, "unit": "°C" } }, "colors": { "column": "#d8342c" }, "colorSources": { "column": "known: a red column reads well" }, "state": { "value": 37 }, "why": "A clinical thermometer's short scale makes one degree visible." } }
]
```
