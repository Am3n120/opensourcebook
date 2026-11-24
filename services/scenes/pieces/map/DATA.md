# The map's data

`data.json` holds the outlines of the world's countries and 1,251 cities that the map piece draws and finds places in.

- **Source:** [Natural Earth](https://www.naturalearthdata.com/), the 1:50m *Admin 0 – Countries* and *Populated Places (simple)* layers, version 5.2.0-pre, as GeoJSON from [github.com/nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) (`geojson/`), taken November 2026.
- **Licence:** public domain. Natural Earth's terms: "All versions of Natural Earth raster + vector map data found on this website are in the public domain. You may use the maps in any manner, including modifying the content and design, electronic dissemination, and offset printing." No credit is required; Open Sourcebook gives one here anyway: made with Natural Earth.
- **What was changed:** only the outer ring of each piece of land is kept (no lakes), thinned to what a frame can show, and stored as whole hundredths of a degree. Each country keeps its names in English and its three-letter codes, its continent, its part of the world and where its label sits. Each city keeps its name, its place, its rank and its country.
- **Borders are Natural Earth's:** they show the borders as they are de facto today, and some are disputed. A video about a disputed border should say so in its words.

To make it again, `node --experimental-strip-types scripts/map-data.ts COUNTRIES.geojson PLACES.geojson` from `services/scenes/`.
