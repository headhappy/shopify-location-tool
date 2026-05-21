# Head Happy Stock Control + Locations

This is Head Happy's Shopify admin bridge for two connected jobs:

1. **Locations** — scan a product barcode, scan/type a shelf location, and write the location to the variant metafield `stock.location`.
2. **Stock control** — pull live Shopify inventory by SKU and export it as CSV/JSON so Restocky can use Shopify as the live stock source instead of relying on manual Stocky exports.

The app is designed to run locally during development and on Render for live use.

---

## Current Features

### Location scanner

* Scan or type a product barcode.
* Look up matching Shopify product variants.
* Scan or type a shelf/location code.
* Write the selected location to the variant metafield `stock.location`.

### Live Shopify stock export

Read-only stock endpoints have been added for Restocky/Rotaty workflows:

```text
GET /health
GET /api/locations
GET /api/shopify-stock.json
GET /api/shopify-stock.csv
```

The stock exports include:

```text
Product
Variant
SKU
Barcode
Vendor
Tags
ProductStatus
Tracked
Available
Location
LocationId
InventoryItemId
VariantId
ProductId
Price
Handle
```

These endpoints are intended to become the replacement for the Stocky low-stock CSV feed.

---

## Example URLs

Download all active live stock as CSV:

```text
/api/shopify-stock.csv
```

Download stock as JSON:

```text
/api/shopify-stock.json
```

Filter by tag, for example small waterpipes:

```text
/api/shopify-stock.csv?tag=WTPG_S_
```

Only show rows with stock above zero:

```text
/api/shopify-stock.csv?inStockOnly=1
```

Filter by SKU text:

```text
/api/shopify-stock.csv?skuContains=WTPG_S
```

Filter by Shopify location once you know the location ID:

```text
/api/shopify-stock.csv?locationId=gid://shopify/Location/123456789
```

List Shopify locations:

```text
/api/locations
```

Health check:

```text
/health
```

---

## Restocky Direction

The planned flow is:

```text
live_product_data.csv  = SKU + RO/ROP + supplier/category/business rules
Shopify API            = live stock + locations + product/variant data
Restocky Merge         = joins both by SKU and builds order/jobs
Order Board            = staff execution
Rotaty                 = shelf/display decisions
```

In the first stage, this app only supplies the Shopify live stock feed. Restocky will still compare against `live_product_data.csv`, where Head Happy currently stores ROP values.

---

## Environment Variables

Create a `.env` file locally or set these in Render:

```text
SHOPIFY_SHOP=headhappyhemp.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_...
SHOPIFY_API_VERSION=2024-07
PORT=3000
```

* **SHOPIFY_SHOP** — your `.myshopify.com` domain, without `https://`.
* **SHOPIFY_ACCESS_TOKEN** — Admin API access token from a Shopify custom app.
* **SHOPIFY_API_VERSION** — optional. Defaults to `2024-07`.
* **PORT** — optional. Defaults to `3000`.

The Shopify token must stay server-side. Do not put it in browser JavaScript.

---

## Shopify App Permissions

For the current app you need Admin API access for:

* Read products
* Read inventory
* Read locations
* Read and write product/variant metafields if using the location scanner

Later, if the app receives stock or changes stock quantities, it will also need inventory write permissions.

---

## Install and Run Locally

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

Test the stock export:

```text
http://localhost:3000/api/shopify-stock.csv
```

---

## Deploy on Render

1. Connect Render to this GitHub repo.
2. Set the build command:

```bash
npm install
```

3. Set the start command:

```bash
npm start
```

4. Add the environment variables in Render.
5. Open:

```text
https://your-render-app.onrender.com/health
```

Then test:

```text
https://your-render-app.onrender.com/api/shopify-stock.csv
```

---

## Important Notes

* The stock endpoints are read-only.
* ROP is not calculated here yet. ROP currently comes from `live_product_data.csv` and is joined later in Restocky.
* Product tags are treated as Shopify tags. For Head Happy category matching, use clean tags like `WTPG_S_` where possible.
* The location scanner still writes `stock.location` to the variant metafield.
* The app is now broader than the original location scanner, but the old scanner workflow still remains.

---

## Future Upgrades

Planned next steps:

* Add a Restocky-ready low-stock endpoint that accepts or reads `live_product_data.csv`.
* Join Shopify live stock against ROP by SKU.
* Output `Product, Variant, SKU, Supplier, Department, Brand, RO, Stock, Location`.
* Add Shopify sales endpoints for 7/30/90/180/365 day ranking.
* Add controlled stock receiving/write-back once read-only exports are proven safe.
