# Berlin Bike Theft Atlas

Static map using `Fahrraddiebstahl.csv` and Berlin's LOR boundaries. Run locally with `python3 -m http.server 8000`, then open `http://localhost:8000`.

Enrich a CSV from the LOR WFS with `node scripts/enrich-lor.mjs input.csv --output enriched.csv --areas lor-areas.geojson`.
