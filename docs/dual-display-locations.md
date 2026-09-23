# Two independent displays — location tools 1.4.0

All physical location values belong to Shopify **ProductVariant** owners, including the default variant of a product without selectable options. Parent-product fields are never read as a fallback or written by these tools.

| Field | Variant metafield | Lookup JSON | Stock export |
| --- | --- | --- | --- |
| Display 1 | `custom.display_loc` | `currentDisplayLoc` | `DisplayLocation` |
| Display 2 (optional) | `custom.display_loc_2` | `currentDisplayLoc2` | `DisplayLocation2` |
| Quick stock | `stock.location` | `currentLocation` | `ShelfLocation` |
| Bulk / LOC2 | `custom.location` | `currentLoc2` | `LOC2` |

The shared field contract is `public/location-fields.js`. A suffix `(LOD)` belongs only to the display field containing it; the other display is independent. Searching a physical location strips this suffix and matches case-insensitively. Exact bin search does not confuse `MC1 D1` with `MC1 D10`.

## Staff workflow

Search or scan the exact SKU. Multiple search matches require an explicit variant selection before editing. Save Display 1, Display 2, LOCATION or LOC2 separately, or use Save all changes. Blank boxes do not erase existing locations. Clear asks for confirmation and removes only that field on that variant.

Batch Scan has all four target fields. Set the destination before scanning. Each queued scan captures the selected target and destination, rather than reading a later bin change. Multiple or partial SKU matches are skipped rather than saved speculatively.

Location Viewer searches all four fields and displays independent LOD 1 / LOD 2 indicators. Quick edit saves only changed non-blank fields on that variant.

In Label Station, select a location, set copies per product, add every product, review and print. A variant appearing in both displays is not counted twice within one location result. Adding a second location does not duplicate a variant already queued with the same label type. Individual copies remain editable. Choose Staff labels to print all four location values on the existing 40 x 25 mm stock. Product + location labels retain the everyday quick/bulk layout. Product values refresh before printing; saved queues preserve copies and label types. Test physical printer alignment with the calibration label.

## Compatibility and deployment

Existing stock CSV column positions are retained, with `DisplayLocation2` appended as the final column. JSON includes it by name. The hosted Product Locations, Batch Scan, Location Viewer, Label Station and stock export routes use this contract. Separate local applications consuming these exports must map the additional column to display it; they are not automatically rewritten by a hosted deployment.

`npm start` and the legacy `node index.js` command both run `server-main.js`. The old index-v3 page and separate location-app script forward to the maintained editor. Existing sales routes and credentials are unchanged. No new Render environment variables are required. Hard refresh previously open tabs after deploying.

Do not copy the development test-only `node-fetch` stub or a test stylesheet fixture into production. The existing production `public/label-station.css` is retained; only `label-station-display2.css` is added after it.

## Checks

Run `npm install` and `npm test` for backend regressions using simulated Shopify data. These cover independent field writes, sibling isolation, blank/parent-ID guards, exact location membership, unique counts, cache invalidation, stock exports and network error handling. They do not change live products.

The GitHub workflow also runs `tests/deployed-smoke.mjs`, which waits for its own commit in Render health and reads real pages, assets, a known product, location contents and stock exports. It sends no location-save, clear or inventory requests. A passing local test is not the same as a confirmed deployed check.

Offline browser checks were additionally performed in Chromium with simulated network, camera, barcode rendering, print and storage. Physical camera hardware, label adhesion and actual printer output require an in-store check.
