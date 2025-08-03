const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');

/*
 * Simple Shopify variant location updater
 *
 * This Express server exposes two endpoints:
 *   GET /lookup-variant?barcode=UPC_CODE
 *     → Looks up the first product variant matching the provided barcode.
 *   POST /update-location
 *     → Accepts JSON { variantId: "gid://shopify/ProductVariant/123", location: "Shelf A" }
 *       and writes a metafield (stock.location) to that variant.
 *
 * The server uses your Shopify Admin API token and store domain, supplied via
 * environment variables. See README.md for setup instructions.
 */

// Load environment variables from .env if present
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(bodyParser.json());
// Serve the front‑end files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Validate required environment variables
const { SHOPIFY_SHOP, SHOPIFY_ACCESS_TOKEN, SHOPIFY_API_VERSION } = process.env;
if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
  console.error('Missing required SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN environment variables.');
  process.exit(1);
}
const API_VERSION = SHOPIFY_API_VERSION || '2024-04';

// Helper to call Shopify GraphQL API
async function callShopify(query, variables = {}) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`;
  try {
    const response = await axios.post(
      url,
      { query, variables },
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );
    if (response.data.errors) {
      throw new Error(JSON.stringify(response.data.errors));
    }
    return response.data.data;
  } catch (err) {
    console.error('Shopify API error:', err.message);
    throw err;
  }
}

// Endpoint to look up a variant by barcode
app.get('/lookup-variant', async (req, res) => {
  const barcode = req.query.barcode;
  if (!barcode) {
    return res.status(400).json({ error: 'Missing barcode parameter' });
  }
  // GraphQL query to search product variants by barcode
  const query = `
    query ($barcode: String!) {
      productVariants(first: 1, query: $barcode) {
        edges {
          node {
            id
            sku
            title
            product {
              title
            }
            metafield(namespace: "stock", key: "location") {
              id
              value
            }
          }
        }
      }
    }
  `;
  try {
    const data = await callShopify(query, { barcode });
    const variantEdge = data.productVariants.edges[0];
    if (!variantEdge) {
      return res.status(404).json({ error: 'Variant not found for barcode' });
    }
    const variant = variantEdge.node;
    res.json(variant);
  } catch (error) {
    res.status(500).json({ error: 'Failed to lookup variant', details: error.message });
  }
});

// Endpoint to update variant metafield with location
app.post('/update-location', async (req, res) => {
  const { variantId, location } = req.body;
  if (!variantId || !location) {
    return res.status(400).json({ error: 'variantId and location required' });
  }
  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
          namespace
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const metafields = [
    {
      ownerId: variantId,
      namespace: 'stock',
      key: 'location',
      type: 'single_line_text_field',
      value: location,
    },
  ];
  try {
    const data = await callShopify(mutation, { metafields });
    const result = data.metafieldsSet;
    if (result.userErrors && result.userErrors.length > 0) {
      return res.status(400).json({ error: 'Error updating metafield', userErrors: result.userErrors });
    }
    res.json({ success: true, metafields: result.metafields });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update location', details: error.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Shopify location tool listening on port ${PORT}`);
});