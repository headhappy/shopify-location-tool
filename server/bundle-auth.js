import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { requireValue } from "./bundle-errors.js";

const derive = promisify(scrypt);
export const hashToken = (value) =>
  createHash("sha256").update(value).digest("hex");
const cookieName = "hh_bundle_session";
const options = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(
  password,
  salt = randomBytes(16).toString("hex"),
) {
  requireValue(
    typeof password === "string" &&
      password.length >= 12 &&
      password.length <= 256,
    "Use a password of 12 to 256 characters.",
  );
  const derived = await derive(password, salt, 64, options);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}
export function parseStaff(value) {
  const staff = JSON.parse(value || "[]");
  requireValue(
    Array.isArray(staff) && staff.length > 0 && staff.length <= 100,
    "Configure BUNDLE_STAFF_USERS with individual staff accounts.",
    503,
  );
  for (const user of staff) {
    requireValue(
      /^[a-zA-Z0-9_-]{1,60}$/.test(user.id) &&
        typeof user.name === "string" &&
        user.name.length <= 100 &&
        ["manager", "staff"].includes(user.role),
      "Invalid staff account configuration.",
      503,
    );
    requireValue(
      /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(user.passwordHash),
      "Staff passwords must use the supplied scrypt hash format.",
      503,
    );
  }
  requireValue(
    new Set(staff.map((u) => u.id)).size === staff.length,
    "Staff IDs must be unique.",
    503,
  );
  return staff;
}
export function createBundleAuth({ store, users, origin, secure }) {
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/api/bundles",
    maxAge: 8 * 3600000,
  };
  const token = (req) => {
    const pair = (req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName}=`));
    const value = pair?.slice(cookieName.length + 1) || "";
    return /^[a-f0-9]{64}$/.test(value) ? value : "";
  };
  function sameOrigin(req) {
    requireValue(
      req.headers.origin === origin,
      "This action must come from the configured app origin.",
      403,
    );
  }
  return {
    sameOrigin,
    async login(req, res) {
      sameOrigin(req);
      const { username, password } = req.body || {};
      requireValue(
        typeof username === "string" &&
          username.length <= 60 &&
          typeof password === "string" &&
          password.length <= 256,
        "Enter your staff ID and password.",
        401,
      );
      await store.loginAttempt("global", 100);
      await store.loginAttempt(hashToken(username), 8);
      const user = users.find((u) => u.id === username);
      const hash =
        user?.passwordHash || `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;
      const [, salt, expected] = hash.split("$");
      const actual = await derive(password, salt, 64, options);
      requireValue(
        timingSafeEqual(actual, Buffer.from(expected, "hex")) && user,
        "Staff ID or password is incorrect.",
        401,
      );
      const value = randomBytes(32).toString("hex"),
        csrf = randomBytes(32).toString("hex");
      if (token(req)) await store.deleteSession(hashToken(token(req)));
      await store.saveSession({
        hash: hashToken(value),
        staffId: user.id,
        credentialHash: hashToken(user.passwordHash),
        csrf,
        expiresAt: new Date(Date.now() + cookieOptions.maxAge),
      });
      res.cookie(cookieName, value, cookieOptions);
      return {
        staff: { id: user.id, name: user.name, role: user.role },
        csrf,
        inventoryWritesEnabled: false,
      };
    },
    async authenticate(req) {
      const value = token(req);
      requireValue(value, "Sign in to Bundle Builder.", 401);
      const session = await store.session(hashToken(value));
      const user = users.find((u) => u.id === session?.staff_id);
      requireValue(
        user && session.credential_hash === hashToken(user.passwordHash),
        "Your session expired. Sign in again.",
        401,
      );
      req.staff = { id: user.id, name: user.name, role: user.role };
      req.csrf = session.csrf;
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        sameOrigin(req);
        requireValue(
          typeof req.headers["x-csrf-token"] === "string" &&
            req.headers["x-csrf-token"] === session.csrf,
          "Refresh the page before submitting this action.",
          403,
        );
      }
    },
    async logout(req, res) {
      await store.deleteSession(hashToken(token(req)));
      res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined });
    },
  };
}
