import fetch from "node-fetch";

export function createShopifyGraph({ shop, token, apiVersion }) {
  return async function shopifyGraph(query, variables = {}) {
    const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(payload)}`);
    if (payload.errors) throw new Error(JSON.stringify(payload.errors));
    return payload.data;
  };
}

export async function setTextMetafield(shopifyGraph, ownerId, namespace, key, value) {
  const mutation = `
    mutation SetTextMetafield($id: ID!, $namespace: String!, $key: String!, $value: String!) {
      metafieldsSet(metafields: [{
        ownerId: $id,
        namespace: $namespace,
        key: $key,
        type: "single_line_text_field",
        value: $value
      }]) {
        userErrors { field message }
      }
    }`;
  const data = await shopifyGraph(mutation, { id: ownerId, namespace, key, value: String(value ?? "") });
  const errors = data.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors[0].message);
}

export function normalise(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function sendCsv(res, filename, rows, columns) {
  const header = columns.map(csvEscape).join(",");
  const body = rows.map(row => columns.map(col => csvEscape(row[col])).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("\uFEFF" + (body ? `${header}\n${body}` : header));
}
