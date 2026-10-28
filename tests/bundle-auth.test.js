import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { createBundleRouter } from "../server/bundle-routes.js";
import { registerBundleModule } from "../server/bundle-module.js";
import { hashPassword, parseStaff, hashToken } from "../server/bundle-auth.js";
import { setup, savedCrown, previewInput, manager } from "./bundle-fixtures.js";

export async function apiFixture(t) {
  const context = await setup(t),
    password = "Only a test password!";
  const passwordHash = await hashPassword(password);
  const users = parseStaff(
    JSON.stringify([
      { ...manager, passwordHash },
      { id: "sam", name: "Sam", role: "staff", passwordHash },
    ]),
  );
  const app = express(),
    origin = "https://bundles.example";
  app.use(
    "/api/bundles",
    createBundleRouter({ ...context, users, origin, secure: true }),
  );
  // This legacy wildcard must never apply to Bundle Builder.
  app.use((_req, res) =>
    res.set("Access-Control-Allow-Origin", "*").json({ legacy: true }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/bundles`;
  let cookie = "",
    csrf = "";
  async function request(
    path,
    { method = "GET", body, headers = {}, anonymous = false } = {},
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(method !== "GET"
          ? { "Content-Type": "application/json", Origin: origin }
          : {}),
        ...(!anonymous ? { Cookie: cookie, "X-CSRF-Token": csrf } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { response, data };
  }
  async function login(username = "alex") {
    const r = await request("/login", {
      method: "POST",
      body: { username, password },
      anonymous: true,
    });
    cookie = r.response.headers.get("set-cookie")?.split(";")[0] || "";
    csrf = r.data.csrf || "";
    return r;
  }
  return {
    ...context,
    app,
    users,
    password,
    origin,
    request,
    login,
    getCookie: () => cookie,
    getCsrf: () => csrf,
  };
}
test("bundle APIs require a session; cookies are secure and CSRF/origin checks block forged changes", async (t) => {
  const c = await apiFixture(t);
  assert.equal((await c.request("/recipes")).response.status, 401);
  const login = await c.login();
  assert.equal(login.response.status, 200);
  for (const value of [
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/api/bundles",
  ])
    assert.ok(login.response.headers.get("set-cookie").includes(value));
  assert.equal(login.response.headers.get("access-control-allow-origin"), null);
  assert.equal((await c.request("/session")).data.staff.id, "alex");
  assert.equal(
    (
      await c.request("/recipes", {
        method: "POST",
        body: {},
        headers: { Origin: "https://evil.example" },
      })
    ).response.status,
    403,
  );
  assert.equal(
    (
      await c.request("/recipes", {
        method: "POST",
        body: {},
        headers: { "X-CSRF-Token": "wrong" },
      })
    ).response.status,
    403,
  );
  assert.equal(
    (
      await c.request("/login", {
        method: "POST",
        body: { username: "alex", password: c.password },
        headers: { Origin: "https://evil.example" },
        anonymous: true,
      })
    ).response.status,
    403,
  );
});
test("staff can preview but cannot edit recipes; all assembly/reversal entry points stay disabled", async (t) => {
  const c = await apiFixture(t),
    r = await savedCrown(c);
  await c.login("sam");
  assert.equal(
    (await c.request("/recipes", { method: "POST", body: { recipe: r } }))
      .response.status,
    403,
  );
  assert.equal(
    (
      await c.request(`/recipes/${r.id}/preview`, {
        method: "POST",
        body: previewInput(r),
      })
    ).response.status,
    200,
  );
  for (const path of [
    "/assemblies",
    "/assemblies/123/reverse",
    "/reversals",
    "/reconcile",
  ])
    assert.equal(
      (await c.request(path, { method: "POST", body: {} })).response.status,
      403,
    );
  assert.ok(c.calls.every((c) => !c.query.includes("mutation")));
});
test("recipe routes enforce optimistic versions and preview rejects stale recipe selection", async (t) => {
  const c = await apiFixture(t);
  await c.login();
  const created = await c.request("/recipes", {
    method: "POST",
    body: { recipe: await c.service.crownTemplate() },
  });
  assert.equal(created.response.status, 201);
  const r = created.data.recipe;
  assert.equal(
    (
      await c.request(`/recipes/${r.id}`, {
        method: "PUT",
        body: { recipe: r, expectedVersion: 1 },
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await c.request(`/recipes/${r.id}`, {
        method: "PUT",
        body: { recipe: r, expectedVersion: 1 },
      })
    ).response.status,
    409,
  );
  assert.equal(
    (
      await c.request(`/recipes/${r.id}/preview`, {
        method: "POST",
        body: previewInput(r),
      })
    ).response.status,
    409,
  );
  const input = previewInput(r);
  assert.equal(
    (
      await c.request(`/recipes/${r.id}/resolve`, {
        method: "POST",
        body: input,
      })
    ).response.status,
    409,
  );
  const resolved = await c.request(`/recipes/${r.id}/resolve`, {
    method: "POST",
    body: { ...input, recipeVersion: 2 },
  });
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.data.recipeVersion, 2);
});
test("expired, revoked, password-rotated and removed staff sessions fail closed", async (t) => {
  const c = await apiFixture(t);
  await c.login();
  c.users[0].passwordHash = await hashPassword("A replacement password!");
  assert.equal((await c.request("/session")).response.status, 401);
  c.users[0].passwordHash = await hashPassword(c.password);
  await c.login();
  const token = c.getCookie().split("=")[1];
  await c.pool.query(
    "UPDATE hh_bundle_sessions SET expires_at=$1 WHERE token_hash=$2",
    [new Date(0), hashToken(token)],
  );
  assert.equal((await c.request("/session")).response.status, 401);
  await c.login();
  assert.equal(
    (await c.request("/logout", { method: "POST", body: {} })).response.status,
    200,
  );
  assert.equal((await c.request("/session")).response.status, 401);
  await c.login();
  c.users.splice(0, 1);
  assert.equal((await c.request("/session")).response.status, 401);
});
test("login throttling is durable and does not disclose whether a staff ID exists", async (t) => {
  const c = await apiFixture(t);
  for (let i = 0; i < 8; i++) {
    const r = await c.request("/login", {
      method: "POST",
      body: { username: "unknown", password: "wrong" },
      anonymous: true,
    });
    assert.equal(r.response.status, 401);
    assert.equal(r.data.error, "Staff ID or password is incorrect.");
  }
  const r = await c.request("/login", {
    method: "POST",
    body: { username: "unknown", password: "wrong" },
    anonymous: true,
  });
  assert.equal(r.response.status, 429);
  assert.equal(r.response.headers.get("retry-after"), "600");
});
test("authenticated full CSV export is marked preview-only and missing configuration leaves legacy routes available", async (t) => {
  const c = await apiFixture(t),
    r = await savedCrown(c);
  await c.login();
  await c.request(`/recipes/${r.id}/preview`, {
    method: "POST",
    body: previewInput(r),
  });
  const csv = await c.request("/previews.csv");
  assert.equal(csv.response.status, 200);
  assert.match(csv.data, /PREVIEW_ONLY/);
  assert.match(csv.data, /AppliedDelta/);
  const calls = [],
    app = { use: (path, handler) => calls.push({ path, handler }) };
  registerBundleModule(app, {});
  assert.equal(calls[0].path, "/api/bundles");
  let code;
  calls[0].handler(
    {},
    {
      status(n) {
        code = n;
        return this;
      },
      json() {},
    },
  );
  assert.equal(code, 503);
});
