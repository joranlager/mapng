# MapNG for Norway

A fork of MapNG (nikkiluzader/mapng) that builds BeamNG.drive levels for areas in Norway from Norwegian public
data. Fork: `joranlager/mapng`, branch `norway-elevation`. Runtime: the desktop app (`desktop/`).

The app builds maps in Norway only: `fetchTerrainData` (`services/terrain.js`) refuses a centre outside Norway, the
start place is Trondheim, and the place search asks Nominatim for Norway only. There are no drop-in files.

## What is built

| Part | Code | Source |
|---|---|---|
| Address search | `services/kartverketAddress.js`; desktop route in `desktop/main.js` | Kartverket `ws.geonorge.no/adresser/v1` |
| Elevation | `services/norway/kartverketDtm.js`; hook in `services/terrain.js` before Mapterhorn | Kartverket Høydedata DTM1 (1 m GeoTIFF tiles, EPSG:25833, read by HTTP range requests) |
| Buildings | `services/norway/matrikkelBuildings.js`, `matrikkelFiles.js`; hook in `fetchOSMData` (`services/osm.js`) | Kartverket Matrikkel (points, per-kommune zips) |
| Roads | `services/norway/nvdbRoads.js`; hook in `fetchOSMData` after the Matrikkel step | NVDB API Les v4 (speed limits, widths, lanes, surface, signs, crossings, signals, bumps, lights, guard rails) |
| Road network | `services/norway/nvdbGeometry.js` (`replaceRoadsWithNvdb`); hook in `fetchOSMData` before the road data step | NVDB road network + objects 60 (Bru), 67 (Tunnelløp), 595 (Motorveg) placed on it |
| Bridge and tunnel heights | `services/norway/nvdbNetwork.js`; hooks in `fetchOSMData`, `solveTunnelAs` (`services/beamngTunnels.js`, `measuredProfile`) and the export's structure pins (search "NVDB's surveyed") | NVDB road network (`vegnett/api/v4/veglenkesekvenser/segmentert`, 3D lines, NN2000) |
| Building heights | `services/norway/buildingHeights.js`; hook in `fetchTerrainData` after the OSM fetch | Kartverket DOM1 minus DTM1 under each outline |
| Sign plates | `services/norway/norwaySigns.js`; hook in `services/exportBeamNGLevel.js` (search "Norwegian signs") | NVDB sign plates + pictures in `public/norway_signs` |

Roads, paths, junctions, bridges and tunnels come from NVDB only: OSM's road ways, road areas, bridge outlines and
junction nodes are taken out of the map data (also when the data came from Overture, the fallback when the
Overpass servers are busy). Buildings, land use, water and railways stay OpenStreetMap's. NVDB roads are not slid
onto the terrain (`snapRoadsToTerrain`) and not rounded (`roundRoadCorners`). Each step falls back to the
app's old behaviour when its source fails. Off switches (localStorage, value `"0"`): `mapng_norwayElevation`,
`mapng_norwayBuildings`, `mapng_norwayRoads`, `mapng_norwaySigns`, `mapng_norwayRoadHeights`, `mapng_norwayRoadGeometry`, `mapng_norwayBuildingHeights`.

Kartverket elevation runs for "Best free" and "Standard" alike (a named source, USGS, GPXZ, KRON86 or an uploaded
file, is kept). Data is fetched in the Generate step; sign plates, bridge pins and tunnel profiles are made in the
Export step.

How the road heights work: NVDB's 3D lines beside every bridge and tunnel road travel with
the map as features of type `nvdb_profile`. A bridge edge measured at 60% of its stations is pinned to NVDB's
heights; a tunnel follows NVDB's profile when 70% is measured and it lies under the ground, and falls back to the
app's own profile when the ground does not cover it.

## Commands

```
npm ci                                   # root; desktop/ needs its own npm ci
npm test                                 # node --test tests/*.test.mjs (951 pass; 5 fail on Windows only: the tests build paths as C:C:...)
npm run build                            # Vite build into dist/
node scripts/norway/check.mjs            # the six Norwegian data paths against the live servers (Trondheim, 1 km)
python scripts/norway/fetch_sign_art.py  # sign pictures from norske_skilt_komplett (in the project) into public/norway_signs
cd desktop && npm run stage && npm start # desktop app (after npm run build at the root)
```

Tests for this work: `tests/kartverket*.test.mjs`, `tests/matrikkel*.test.mjs`, `tests/nvdbRoads.test.mjs`, `tests/nvdbNetwork.test.mjs`, `tests/nvdbGeometry.test.mjs`, `tests/norwayBuildingHeights.test.mjs`,
`tests/norwaySigns*.test.mjs`.

## Verified against the live servers (2026-11-11)

`node scripts/norway/check.mjs`: address search, DTM1 (range requests work; tiles are 512 px tiled LZW with a
user-defined CRS code 32767, named UTM 33N), Matrikkel (municipalities now come from `ws.geonorge.no/kommuneinfo`;
the Matrikkel WFS answers 500), NVDB road data, NVDB road heights. Building heights were measured live on 474 of
475 outlines in central Trondheim.

## Not verified yet (start here)

Nothing here has been run in BeamNG.

1. Generate and export a 1 km map in Trondheim in the desktop app. Check the progress lines ("Fetching Kartverket
   elevation", "Kartverket Matrikkel: ...", "NVDB: ...", "Kartverket: measured heights on ...") and the export log
   lines "Norwegian signs:", "Bridges on NVDB's surveyed heights:" and "Tunnels on NVDB's surveyed profile:".
2. Export a map with a real tunnel and bridges (Strindheimtunnelen, east of Trondheim centre) and drive it: through
   the tunnel, and under each bridge that has a road under it.
3. Look at the sign plates in BeamNG. They are a new kind of object (generated DAE, a `diffuseMap` material with
   `alphaTest`): the texture may be upside down, the cut-out may not work, plates may face the wrong way.
4. Sign wording: a speed limit's number is in its sign number ("362.40"); zone signs (366, 368) carry it in the
   text. Direction signs (7xx) and plates under a sign (8xx) are drawn from NVDB's text, whose system is "@@" for a
   new line, "@32@" for an arrow (30 to 37), "@807.6@" for a small sign, "@723.12@E6" or "$E6$" for a road number
   (`parseSignText` in `services/norway/norwaySigns.js`). What arrows 35, 36 and 37 point at is a guess (30/32 left,
   31/33 right and 34 ahead are seen in the data). The letters are Arial, not the road sign alphabet.

## Known limits

- One NVDB value per OSM road: a speed limit that changes along an OSM way is not split.
- A map crossing into Sweden, Finland or Russia gets Kartverket heights on the Norwegian side only.
- Matrikkel has points only: added buildings are boxes sized by building type.
- `public/norway_signs` and `norske_skilt_komplett` are in the repository; the pictures come from Skiltforskriften (small GIFs, imported from
  `norske_skilt_komplett` in the project: 305 pictures). A script may not fetch them: Lovdata's robots.txt disallows everything for scripts,
  vegvesen.no's disallows `/globalassets/` where its pictures are, and the NVDB catalogue has sign numbers and names
  but no pictures.
- A road NVDB does not hold (many private drives and parking aisles) is not in the map. A pavement or cycle track
  on a bridge is tagged as a bridge only when NVDB places the bridge on its own line.
- Road tilt is not built: NVDB publishes no crossfall, and the app's roads have
  a flat cross-section.
- Air photos are Esri World Imagery. Norge i bilder's open tile addresses no longer answer.
- Building outlines are OSM's (and Overture's). FKB-Bygning, Kartverket's own outlines, is not open data.
- Building heights download both 1 m models for the whole area (about 17 MB each per square km).

## Working with the owner

- When a script or file is needed, save it and give the command to run. Do not ask the owner to create files.
- Commit and push only when asked. Work on `norway-elevation` unless told otherwise.
- Scripts that fetch from the web identify themselves honestly and follow robots.txt.
- Folder `C:\NorwayOnBeamNG` holds earlier probe scripts and their outputs (`nvdb_output.txt`, `dtm3_output.txt`
  and others): real samples of the Norwegian APIs' answers.
