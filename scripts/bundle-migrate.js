import "dotenv/config";
import pg from "pg";
import { migrateBundles } from "../server/bundle-store.js";
if (!process.env.BUNDLE_DATABASE_URL)
  throw new Error("Set BUNDLE_DATABASE_URL.");
const pool = new pg.Pool({
  connectionString: process.env.BUNDLE_DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
try {
  await migrateBundles(pool, process.env.SHOPIFY_SHOP);
  console.log("Bundle schema v1 is ready. No Shopify data was changed.");
} finally {
  await pool.end();
}
