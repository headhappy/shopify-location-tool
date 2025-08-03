/* ----------  server/index.js  ---------- */
/*  Variant Location Updater – Express backend
    1. POST /lookup-variant  – finds variant(s) by barcode
    2. POST /update-location – writes stock.location metafield             */

import express from "express";
import fetch   from "node-fetch";          // node 18+ has global fetch, but this keeps it consistent
import dotenv  from "dotenv";
dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

const SHOP  = process.env.SHOPIFY_SHOP;          // your-store.myshopify.com
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;  // shpat_xxx
const API   = "2024-07";                         // Admin API version

if (!SHOP || !TOKEN) {
  console.error("❌  Set SHOPIFY_SHOP & SHOPIFY_ACCESS_TOKEN in env.");
  process.exit(1);
}

app.use(express.json());
app.use(express.static("public"));               // serves index.html

/* ---------- helper to call Admin GraphQL ---------- */
async function shopifyGraph(query, variables = {}) {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const { data, errors } = await r.json();
  if (errors) throw new Error(JSON.stringify(errors));
  return data;
}

/* ----------  /lookup-variant  ---------- */
app.post("/lookup-variant", async (req, res) => {
  const { barcode } = req.body;
  if (!barcode) return res.status(400).json({ error: "Barcode required" });

  try {
    const query = `
      query ($q: String!) {
        productVariants(first: 20, query: $q) {
          edges {
            node {
              id
              title
              barcode
              product { title }
              metafield(namespace: "stock", key: "location") { value }
            }
          }
        }
      }`;
    const data = await shopifyGraph(query, { q: `barcode:${barcode}` });
    const hits = data.productVariants.edges.map(e => e.node);

    if (hits.length === 0)
      return res.status(404).json({ error: "No variant matches" });

    if (hits.length === 1) {
      const v = hits[0];
      return res.json({
        variant: { id: v.id },
        productTitle: v.product.title,
        currentLocation: v.metafield?.value || "",
      });
    }

    // multiple matches → send array
    res.json({
      variants: hits.map(v => ({
        id: v.id,
        title: `${v.product.title} – ${v.title}`,
        currentLocation: v.metafield?.value || "",
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lookup failed" });
  }
});

/* ----------  /update-location  ---------- */
app.post("/update-location", async (req, res) => {
  const { variantId, locationValue } = req.body;
  if (!variantId || locationValue === undefined)
    return res.status(400).json({ error: "variantId & locationValue required" });

  try {
    const mut = `
      mutation setLoc($id: ID!, $val: String!) {
        metafieldsSet(metafields: [{
          ownerId: $id,
          namespace: "stock",
          key: "location",
          type: "single_line_text_field",
          value: $val
        }]) { userErrors { field message } }
      }`;
    const r = await shopifyGraph(mut, { id: variantId, val: locationValue });
    if (r.metafieldsSet.userErrors.length)
      throw new Error(r.metafieldsSet.userErrors[0].message);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Save failed" });
  }
});

app.listen(PORT, () =>
  console.log(`🚀  Variant Location server listening on http://localhost:${PORT}`)
);
