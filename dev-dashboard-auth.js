import fetch from "node-fetch";
import { URLSearchParams } from "node:url";

function shopDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.endsWith(".myshopify.com") ? raw : `${raw}.myshopify.com`;
}

const SHOP = shopDomain(process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP || "");
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || "";

let token = null;
let tokenExpiresAt = 0;

export async function getDevDashboardToken() {
  if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Set SHOPIFY_STORE_DOMAIN (or SHOPIFY_SHOP), SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET.");
  }

  if (token && Date.now() < tokenExpiresAt - 60000) return token;

  const response = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  token = payload.access_token;
  tokenExpiresAt = Date.now() + Number(payload.expires_in || 0) * 1000;
  return token;
}

export async function graphWithDevDashboardAuth(apiVersion, query, variables = {}) {
  const accessToken = await getDevDashboardToken();
  const response = await fetch(`https://${SHOP}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  if (payload.errors) {
    throw new Error(JSON.stringify(payload.errors));
  }
  return payload.data;
}
