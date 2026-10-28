import { randomUUID } from "node:crypto";
import { requireValue } from "./bundle-errors.js";

// Migrations run explicitly, never against the ephemeral Render filesystem.
export const BUNDLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS hh_bundle_meta (id integer PRIMARY KEY, shop text NOT NULL, schema_version integer NOT NULL);
CREATE TABLE IF NOT EXISTS hh_bundle_recipes (
  id uuid PRIMARY KEY, version integer NOT NULL, document jsonb NOT NULL,
  updated_at timestamptz NOT NULL, updated_by text NOT NULL
);
CREATE TABLE IF NOT EXISTS hh_bundle_recipe_history (
  recipe_id uuid NOT NULL, version integer NOT NULL, document jsonb NOT NULL,
  changed_at timestamptz NOT NULL, changed_by text NOT NULL, PRIMARY KEY(recipe_id, version)
);
CREATE TABLE IF NOT EXISTS hh_bundle_previews (
  id uuid PRIMARY KEY, request_key text UNIQUE NOT NULL, request_hash text NOT NULL,
  created_at timestamptz NOT NULL, document jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS hh_bundle_sessions (
  token_hash text PRIMARY KEY, staff_id text NOT NULL, credential_hash text NOT NULL,
  csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS hh_bundle_login_limits (
  key text PRIMARY KEY, attempts integer NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS hh_bundle_previews_created ON hh_bundle_previews(created_at);
`;

export async function migrateBundles(pool, shop) {
  requireValue(
    /^[a-zA-Z0-9-]+\.myshopify\.com$/.test(shop || ""),
    "Set SHOPIFY_SHOP to your myshopify.com domain.",
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(BUNDLE_SCHEMA);
    await client.query(
      "INSERT INTO hh_bundle_meta(id,shop,schema_version) VALUES(1,$1,1) ON CONFLICT(id) DO NOTHING",
      [shop.toLowerCase()],
    );
    const { rows } = await client.query(
      "SELECT shop, schema_version FROM hh_bundle_meta WHERE id=1",
    );
    requireValue(
      rows[0]?.shop === shop.toLowerCase() && rows[0]?.schema_version === 1,
      "Bundle database belongs to a different shop or schema.",
      503,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function createBundleStore(pool, shop) {
  return {
    async ready() {
      const { rows } = await pool.query(
        "SELECT shop, schema_version FROM hh_bundle_meta WHERE id=1",
      );
      requireValue(
        rows[0]?.shop === shop.toLowerCase() && rows[0]?.schema_version === 1,
        "Bundle database is not configured for this shop.",
        503,
      );
    },
    async listRecipes() {
      return (
        await pool.query(
          "SELECT document FROM hh_bundle_recipes ORDER BY updated_at DESC",
        )
      ).rows.map((r) => r.document);
    },
    async recipe(id) {
      requireValue(/^[a-f0-9-]{36}$/.test(id), "Invalid recipe ID.");
      const { rows } = await pool.query(
        "SELECT document FROM hh_bundle_recipes WHERE id=$1",
        [id],
      );
      requireValue(rows.length, "Recipe not found.", 404);
      return rows[0].document;
    },
    async saveRecipe(recipe, actor, id = randomUUID(), expectedVersion = 0) {
      requireValue(
        /^[a-f0-9-]{36}$/.test(id) &&
          Number.isSafeInteger(expectedVersion) &&
          expectedVersion >= 0,
        "Invalid recipe version or ID.",
      );
      const document = {
        ...recipe,
        id,
        version: expectedVersion + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: actor.id,
      };
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let result;
        if (!expectedVersion) {
          result = await client.query(
            "INSERT INTO hh_bundle_recipes(id,version,document,updated_at,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id",
            [id, 1, document, document.updatedAt, actor.id],
          );
        } else {
          result = await client.query(
            "UPDATE hh_bundle_recipes SET version=$2,document=$3,updated_at=$4,updated_by=$5 WHERE id=$1 AND version=$6 RETURNING id",
            [
              id,
              document.version,
              document,
              document.updatedAt,
              actor.id,
              expectedVersion,
            ],
          );
        }
        requireValue(
          result.rows.length,
          "Recipe changed in another session. Reload it before saving.",
          409,
        );
        await client.query(
          "INSERT INTO hh_bundle_recipe_history(recipe_id,version,document,changed_at,changed_by) VALUES($1,$2,$3,$4,$5)",
          [id, document.version, document, document.updatedAt, actor.id],
        );
        await client.query("COMMIT");
        return document;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async recipeHistory(id) {
      await this.recipe(id);
      return (
        await pool.query(
          "SELECT document FROM hh_bundle_recipe_history WHERE recipe_id=$1 ORDER BY version DESC",
          [id],
        )
      ).rows.map((r) => r.document);
    },
    async findPreview(key) {
      const { rows } = await pool.query(
        "SELECT document FROM hh_bundle_previews WHERE request_key=$1",
        [key],
      );
      return rows[0]?.document;
    },
    async savePreview(snapshot) {
      await pool.query(
        "INSERT INTO hh_bundle_previews(id,request_key,request_hash,created_at,document) VALUES($1,$2,$3,$4,$5) ON CONFLICT(request_key) DO NOTHING",
        [
          snapshot.id,
          snapshot.idempotencyKey,
          snapshot.requestHash,
          snapshot.createdAt,
          snapshot,
        ],
      );
      const saved = await this.findPreview(snapshot.idempotencyKey);
      requireValue(
        saved.requestHash === snapshot.requestHash,
        "This preview request ID was already used for different inputs.",
        409,
      );
      return saved;
    },
    async listPreviews({ limit = 100, cursor } = {}) {
      requireValue(
        Number.isSafeInteger(limit) && limit > 0 && limit <= 1000,
        "Invalid history page size.",
      );
      let boundary = {
        time: "9999-12-31T00:00:00.000Z",
        id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      };
      if (cursor) {
        try {
          boundary = JSON.parse(
            Buffer.from(cursor, "base64url").toString("utf8"),
          );
        } catch {
          requireValue(false, "Invalid history cursor.");
        }
        requireValue(
          typeof boundary?.time === "string" &&
            Number.isFinite(Date.parse(boundary.time)) &&
            /^[a-f0-9-]{36}$/.test(boundary.id),
          "Invalid history cursor.",
        );
      }
      return (
        await pool.query(
          "SELECT document FROM hh_bundle_previews WHERE created_at < $1 OR (created_at = $1 AND id < $2) ORDER BY created_at DESC, id DESC LIMIT $3",
          [boundary.time, boundary.id, limit],
        )
      ).rows.map((r) => r.document);
    },
    async session(hash) {
      return (
        await pool.query(
          "SELECT * FROM hh_bundle_sessions WHERE token_hash=$1 AND expires_at > $2",
          [hash, new Date()],
        )
      ).rows[0];
    },
    async saveSession(session) {
      await pool.query("DELETE FROM hh_bundle_sessions WHERE expires_at < $1", [
        new Date(),
      ]);
      await pool.query(
        "INSERT INTO hh_bundle_sessions(token_hash,staff_id,credential_hash,csrf,expires_at) VALUES($1,$2,$3,$4,$5)",
        [
          session.hash,
          session.staffId,
          session.credentialHash,
          session.csrf,
          session.expiresAt,
        ],
      );
    },
    async deleteSession(hash) {
      await pool.query("DELETE FROM hh_bundle_sessions WHERE token_hash=$1", [
        hash,
      ]);
    },
    async loginAttempt(key, max) {
      const now = new Date();
      await pool.query(
        "DELETE FROM hh_bundle_login_limits WHERE expires_at < $1",
        [now],
      );
      const { rows } = await pool.query(
        `INSERT INTO hh_bundle_login_limits(key,attempts,expires_at) VALUES($1,1,$2)
        ON CONFLICT(key) DO UPDATE SET attempts=hh_bundle_login_limits.attempts+1 RETURNING attempts`,
        [key, new Date(now.getTime() + 600000)],
      );
      requireValue(
        rows[0].attempts <= max,
        "Too many sign-in attempts. Try again in 10 minutes.",
        429,
      );
    },
  };
}

export function previewCursor(preview) {
  return preview
    ? Buffer.from(
        JSON.stringify({ time: preview.createdAt, id: preview.id }),
      ).toString("base64url")
    : null;
}
