const $ = (id) => document.getElementById(id);
const state = {
  recipes: [],
  variants: new Map(),
  csrf: "",
  staff: null,
  draft: null,
  resolved: null,
  generation: 0,
  previewKey: null,
  history: [],
};
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, className = "secondary") {
  const node = el("button", text, className);
  node.type = "button";
  node.addEventListener("click", () => perform(action, node));
  return node;
}
function status(text, error = false) {
  $("status").textContent = text;
  $("status").className = error ? "error" : "";
}
async function perform(action, node) {
  if (node) node.disabled = true;
  try {
    await action();
  } catch (error) {
    status(error.message, true);
  } finally {
    if (node) node.disabled = false;
  }
}
async function api(path, options = {}) {
  const response = await fetch(`/api/bundles${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": state.csrf,
      ...options.headers,
    },
    credentials: "same-origin",
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(data.error || "Request failed. Please retry.");
  }
  return data;
}
const post = (path, data) =>
  api(path, { method: "POST", body: JSON.stringify(data) });
function remember(variants) {
  variants.forEach((v) => state.variants.set(v.id, v));
}
function labelFor(id) {
  const v = state.variants.get(id);
  return v ? `${v.sku || "No SKU"} · ${v.productTitle} / ${v.title}` : id;
}
function fill(select, choices, placeholder) {
  select.replaceChildren();
  if (placeholder) select.append(new Option(placeholder, ""));
  choices.forEach(([value, label]) => select.append(new Option(label, value)));
}
function invalidate() {
  state.generation++;
  state.previewKey = null;
  $("preview-panel").hidden = true;
}
function clearComponents() {
  invalidate();
  state.resolved = null;
  $("components-panel").hidden = true;
  $("components-confirmed").checked = false;
}
function showLogin() {
  $("login-panel").hidden = false;
  $("workspace").hidden = true;
  state.csrf = "";
  state.staff = null;
  clearComponents();
}
function tab(name) {
  for (const panel of ["assembly", "recipes", "history"])
    $(`${panel}-panel`).hidden = panel !== name;
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.tab === name)),
    );
}
async function loadRecipes() {
  const old = $("assembly-recipe").value;
  state.recipes = (await api("/recipes")).recipes;
  const ids = [...new Set(state.recipes.flatMap((r) => r.finishedVariantIds))];
  for (let i = 0; i < ids.length; i += 100)
    remember(
      (await post("/variants/resolve", { ids: ids.slice(i, i + 100) }))
        .variants,
    );
  fill(
    $("assembly-recipe"),
    state.recipes.map((r) => [r.id, r.name]),
    "Choose a recipe",
  );
  if (state.recipes.some((r) => r.id === old)) $("assembly-recipe").value = old;
  changeRecipe();
  renderRecipes();
}
function changeRecipe() {
  clearComponents();
  const recipe = state.recipes.find((r) => r.id === $("assembly-recipe").value);
  fill(
    $("assembly-finished"),
    (recipe?.finishedVariantIds || []).map((id) => [id, labelFor(id)]),
    "Choose a finished variant",
  );
}
async function enter(session) {
  state.csrf = session.csrf;
  state.staff = session.staff;
  $("login-panel").hidden = true;
  $("workspace").hidden = false;
  $("staff-name").textContent = `${state.staff.name} · ${state.staff.role}`;
  $("manager-actions").hidden = state.staff.role !== "manager";
  $("recipe-editor").hidden = true;
  tab("assembly");
  const catalog = await api("/catalog");
  state.currency = catalog.currency;
  fill(
    $("assembly-location"),
    catalog.locations.map((l) => [l.id, l.name]),
    "Choose a location",
  );
  await loadRecipes();
  status(
    state.recipes.length
      ? "Ready. Choose a recipe to plan an assembly."
      : "No recipes yet. A manager can create one in Recipes.",
  );
}
$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    credentials = Object.fromEntries(new FormData(form));
  perform(async () => {
    const session = await post("/login", credentials);
    form.reset();
    await enter(session);
  }, form.querySelector("button"));
});
$("logout").addEventListener("click", () =>
  perform(async () => {
    await post("/logout", {});
    state.variants.clear();
    state.recipes = [];
    showLogin();
    status("Signed out.");
  }),
);
document.querySelectorAll("[data-tab]").forEach((b) =>
  b.addEventListener("click", () => {
    tab(b.dataset.tab);
    if (b.dataset.tab === "history") perform(loadHistory);
  }),
);
$("assembly-recipe").addEventListener("change", changeRecipe);
for (const id of [
  "assembly-finished",
  "assembly-location",
  "assembly-quantity",
])
  $(id).addEventListener("change", clearComponents);
$("assembly-quantity").addEventListener("input", clearComponents);
$("components-confirmed").addEventListener("change", invalidate);
$("resolve").addEventListener("click", () =>
  perform(async () => {
    clearComponents();
    const generation = state.generation;
    const recipe = state.recipes.find(
      (r) => r.id === $("assembly-recipe").value,
    );
    if (
      !recipe ||
      !$("assembly-finished").value ||
      !$("assembly-location").value
    )
      throw new Error(
        "Choose a recipe, finished variant and inventory location.",
      );
    const quantity = Number($("assembly-quantity").value);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000)
      throw new Error("Choose a whole quantity from 1 to 10,000.");
    const resolved = await post(`/recipes/${recipe.id}/resolve`, {
      finishedVariantId: $("assembly-finished").value,
      locationId: $("assembly-location").value,
    });
    if (generation !== state.generation) return;
    state.resolved = resolved;
    state.resolvedRecipe = recipe;
    renderComponents(quantity);
    $("components-panel").hidden = false;
    status("Choose the exact components, then confirm the quantities.");
  }, $("resolve")),
);
function renderComponents(quantity) {
  $("assembly-components").replaceChildren();
  for (const group of state.resolved.components) {
    const card = el("div", undefined, "component"),
      label = el(
        "label",
        `${group.name} · ${group.quantity * quantity} needed (${group.quantity} per kit)`,
      );
    const select = el("select");
    select.dataset.componentId = group.id;
    fill(
      select,
      group.candidates.map((v) => [
        v.id,
        `${v.sku} · ${v.title} · ${v.available ?? "?"} available${v.cost ? ` · ${v.cost.amount} ${v.cost.currencyCode} each` : " · cost missing"}`,
      ]),
      "Choose actual variant",
    );
    if (group.candidates.length === 1) select.value = group.candidates[0].id;
    select.addEventListener("change", () => {
      $("components-confirmed").checked = false;
      invalidate();
    });
    label.append(select);
    const scanLabel = el("label", "Scan barcode or exact SKU"),
      scan = el("input");
    scan.placeholder = "Scan, then press Enter";
    scan.autocomplete = "off";
    scanLabel.append(scan);
    scan.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const matches = group.candidates.filter(
        (v) => v.barcode === scan.value.trim() || v.sku === scan.value.trim(),
      );
      if (matches.length !== 1) {
        status(
          "Scan must match exactly one eligible variant. Choose from the list if the barcode or SKU is duplicated.",
          true,
        );
        return;
      }
      select.value = matches[0].id;
      $("components-confirmed").checked = false;
      invalidate();
      status(`Selected ${matches[0].sku} · ${matches[0].title}`);
      scan.value = "";
    });
    const grid = el("div", undefined, "grid");
    grid.append(label, scanLabel);
    card.append(grid);
    if (group.bindingMode === "by_finished")
      card.append(
        el(
          "p",
          "This component is locked to the matching finished colour.",
          "hint",
        ),
      );
    $("assembly-components").append(card);
  }
}
$("preview").addEventListener("click", () =>
  perform(async () => {
    if (!state.resolved) throw new Error("Load components first.");
    const generation = state.generation;
    state.previewKey ||= crypto.randomUUID();
    const body = {
      recipeVersion: state.resolvedRecipe.version,
      finishedVariantId: state.resolved.finished.id,
      locationId: state.resolved.location.id,
      quantity: Number($("assembly-quantity").value),
      confirmed: $("components-confirmed").checked,
      idempotencyKey: state.previewKey,
      selections: [...document.querySelectorAll("[data-component-id]")].map(
        (s) => ({ componentId: s.dataset.componentId, variantId: s.value }),
      ),
    };
    const { preview } = await post(
      `/recipes/${state.resolvedRecipe.id}/preview`,
      body,
    );
    if (generation !== state.generation) return;
    renderPreview(preview);
    status("Preview saved. No inventory changed.");
    $("preview-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }, $("preview")),
);
function money(value, currency = state.currency) {
  return value === null || value === undefined
    ? "Unavailable"
    : new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(
        Number(value),
      );
}
function renderPreview(p, target = "preview-panel") {
  const panel = $(target);
  panel.replaceChildren();
  panel.hidden = false;
  panel.append(
    el("span", "SAVED · PREVIEW ONLY", "badge"),
    el("h2", `${p.quantity} × ${p.finished.sku}`),
    el(
      "p",
      `${p.recipeName} · ${p.location.name} · ${new Date(p.createdAt).toLocaleString("en-GB")}`,
    ),
  );
  const metrics = el("div", undefined, "metrics");
  for (const [title, value] of [
    ["Component cost", money(p.totalComponentCost, p.currency)],
    ["Cost per finished kit", money(p.unitComponentCost, p.currency)],
    [
      "Indicative price / cost margin",
      p.indicativeMarginPercent === null
        ? "Unavailable"
        : `${p.indicativeMarginPercent}%`,
    ],
  ]) {
    const m = el("div", undefined, "metric");
    m.append(el("span", title), el("strong", value));
    metrics.append(m);
  }
  panel.append(metrics);
  const wrap = el("div", undefined, "table-wrap"),
    table = el("table"),
    head = el("thead"),
    row = el("tr");
  [
    "Component / exact variant",
    "Quantity",
    "Available",
    "Unit cost",
    "Total cost",
    "Proposed stock change",
  ].forEach((t) => row.append(el("th", t)));
  head.append(row);
  table.append(head);
  const body = el("tbody");
  for (const line of p.components) {
    const r = el("tr"),
      name = el("td", `${line.sku} · ${line.title}`);
    name.append(el("small", line.id));
    r.append(
      name,
      ...[
        line.quantity,
        line.available ?? "Unknown",
        money(line.cost?.amount, line.cost?.currencyCode || p.currency),
        money(line.extendedCost, p.currency),
        line.proposedDelta,
      ].map((x) => el("td", String(x))),
    );
    body.append(r);
  }
  table.append(body);
  wrap.append(table);
  panel.append(wrap);
  panel.append(
    el(
      "p",
      `Finished stock: ${p.finished.available ?? "unknown"} available; proposed addition +${p.quantity}. Applied adjustments: 0.`,
      `hint`,
    ),
  );
  const notes = el("div", undefined, "warnings");
  notes.append(
    el(
      "strong",
      p.blockers.length
        ? "Resolve before a future physical assembly"
        : "Current preview checks passed",
    ),
  );
  const list = el("ul");
  [...p.blockers, ...p.warnings].forEach((note) => list.append(el("li", note)));
  notes.append(list);
  panel.append(
    notes,
    el(
      "p",
      `Preview ${p.id} · Recipe version ${p.recipeVersion} · Saved by ${p.staff.name} (${p.staff.id})`,
      "hint",
    ),
  );
}
let pickerAction;
function pick(title, action) {
  pickerAction = action;
  $("picker-title").textContent = title;
  $("picker-results").replaceChildren();
  $("picker-status").textContent = "";
  $("picker-query").value = "";
  $("picker").showModal();
  $("picker-query").focus();
}
$("picker-search").addEventListener("submit", (event) => {
  event.preventDefault();
  perform(async () => {
    $("picker-status").textContent = "Searching Shopify…";
    const { variants } = await api(
      `/variants?q=${encodeURIComponent($("picker-query").value)}`,
    );
    remember(variants);
    $("picker-results").replaceChildren();
    for (const v of variants) {
      const b = button(
        `${v.sku || "No SKU"} · ${v.productTitle} / ${v.title}`,
        async () => {
          await pickerAction(v);
          $("picker").close();
        },
        "picker-result",
      );
      b.append(el("small", `${v.status} · ${v.id}`));
      $("picker-results").append(b);
    }
    $("picker-status").textContent = variants.length
      ? `${variants.length} variants. Choose the exact item.`
      : "No variants found. Try the exact SKU or parent product ID.";
  }, event.currentTarget.querySelector("button"));
});
function renderRecipes() {
  $("recipe-list").replaceChildren();
  if (!state.recipes.length)
    $("recipe-list").append(el("p", "No recipes saved yet."));
  for (const recipe of state.recipes) {
    const row = el("div", undefined, "recipe-row"),
      text = el("div");
    text.append(
      el("strong", recipe.name),
      el(
        "p",
        `${recipe.components.length} component groups · ${recipe.finishedVariantIds.length} finished variants · version ${recipe.version}`,
      ),
    );
    row.append(text);
    row.append(
      button(
        state.staff.role === "manager" ? "Edit recipe" : "Use recipe",
        async () => {
          if (state.staff.role === "manager") await editRecipe(recipe);
          else {
            $("assembly-recipe").value = recipe.id;
            changeRecipe();
            tab("assembly");
          }
        },
      ),
    );
    $("recipe-list").append(row);
  }
}
async function editRecipe(recipe) {
  state.draft = structuredClone(recipe);
  const ids = [
    ...new Set([
      ...recipe.finishedVariantIds,
      ...recipe.components.flatMap((c) => [
        ...Object.values(c.bindings || {}),
        ...(c.rule.variantIds || []),
        ...(c.rule.excludeVariantIds || []),
      ]),
    ]),
  ];
  for (let i = 0; i < ids.length; i += 100)
    remember(
      (await post("/variants/resolve", { ids: ids.slice(i, i + 100) }))
        .variants,
    );
  $("recipe-editor").hidden = false;
  renderEditor();
}
function syncDraft() {
  if (!state.draft) return;
  state.draft.name = $("recipe-name").value;
  state.draft.inventoryOwnership = $("ownership").value;
}
function renderEditor() {
  const draft = state.draft;
  $("editor-title").textContent = draft.id
    ? `Edit recipe · version ${draft.version}`
    : "New recipe";
  $("recipe-name").value = draft.name;
  $("ownership").value = draft.inventoryOwnership;
  $("finished-chips").replaceChildren();
  for (const id of draft.finishedVariantIds) {
    const chip = el("span", labelFor(id), "chip");
    chip.append(
      button(
        "×",
        () => {
          syncDraft();
          draft.finishedVariantIds = draft.finishedVariantIds.filter(
            (v) => v !== id,
          );
          draft.components.forEach((c) => {
            delete c.bindings?.[id];
          });
          renderEditor();
        },
        "",
      ),
    );
    $("finished-chips").append(chip);
  }
  $("recipe-components").replaceChildren();
  draft.components.forEach((component, index) =>
    renderEditorComponent(component, index),
  );
}
function field(title, node) {
  const label = el("label", title);
  label.append(node);
  return label;
}
function textInput(value, onChange) {
  const input = el("input");
  input.value = value || "";
  input.addEventListener("input", () => onChange(input.value));
  return input;
}
function renderEditorComponent(c, index) {
  const box = el("div", undefined, "component");
  box.append(el("h3", `Component ${index + 1}`));
  const grid = el("div", undefined, "grid");
  grid.append(
    field(
      "Component name",
      textInput(c.name, (v) => (c.name = v)),
    ),
  );
  const quantity = textInput(c.quantity, (v) => (c.quantity = Number(v)));
  quantity.type = "number";
  quantity.min = "1";
  quantity.max = "1000";
  grid.append(field("Quantity per kit", quantity));
  box.append(grid);
  const type = el("select");
  fill(type, [
    ["exact_sku", "Exact SKU"],
    ["product", "Any variant of a parent product"],
    ["prefix", "SKU prefix"],
    ["group", "Restricted variant group"],
  ]);
  type.value = c.rule.type;
  type.addEventListener("change", () => {
    syncDraft();
    c.rule = {
      type: type.value,
      value: "",
      variantIds: [],
      excludeVariantIds: [],
    };
    c.bindings = {};
    renderEditor();
  });
  box.append(field("Eligibility rule", type));
  if (c.rule.type === "group") {
    box.append(
      el(
        "p",
        (c.rule.variantIds || []).map(labelFor).join(" • ") ||
          "No variants added.",
        "hint",
      ),
      button("Add eligible variant", () =>
        pick("Add eligible variant", (v) => {
          syncDraft();
          c.rule.variantIds = [
            ...new Set([...(c.rule.variantIds || []), v.id]),
          ];
          renderEditor();
        }),
      ),
      button(
        "Clear group",
        () => {
          syncDraft();
          c.rule.variantIds = [];
          renderEditor();
        },
        "quiet",
      ),
    );
  } else {
    box.append(
      field(
        c.rule.type === "product"
          ? "Parent product ID"
          : c.rule.type === "prefix"
            ? "Literal SKU prefix (for example RB_RC_M*)"
            : "Exact SKU",
        textInput(c.rule.value, (v) => (c.rule.value = v)),
      ),
    );
    if (c.rule.type !== "prefix")
      box.append(
        button(
          "Find product / variant",
          () =>
            pick("Choose component product", (v) => {
              syncDraft();
              c.rule.value = c.rule.type === "product" ? v.productId : v.sku;
              renderEditor();
            }),
          "quiet",
        ),
      );
  }
  box.append(
    el(
      "p",
      `Excluded variants: ${(c.rule.excludeVariantIds || []).map(labelFor).join(" • ") || "None"}`,
      "hint",
    ),
    button(
      "Exclude a variant",
      () =>
        pick("Exclude a variant", (v) => {
          syncDraft();
          c.rule.excludeVariantIds = [
            ...new Set([...(c.rule.excludeVariantIds || []), v.id]),
          ];
          renderEditor();
        }),
      "quiet",
    ),
    button(
      "Clear exclusions",
      () => {
        syncDraft();
        c.rule.excludeVariantIds = [];
        renderEditor();
      },
      "quiet",
    ),
  );
  const mode = el("select");
  fill(mode, [
    ["any", "Any eligible variant (assorted / interchangeable)"],
    ["by_finished", "Require a matching component for each finished variant"],
  ]);
  mode.value = c.bindingMode || "any";
  mode.addEventListener("change", () => {
    syncDraft();
    c.bindingMode = mode.value;
    c.bindings ||= {};
    renderEditor();
  });
  box.append(field("Finished-colour matching", mode));
  if (c.bindingMode === "by_finished")
    for (const finished of state.draft.finishedVariantIds) {
      const binding = el("div", undefined, "binding");
      binding.append(
        el("small", `For ${labelFor(finished)}`),
        el(
          "p",
          c.bindings?.[finished]
            ? labelFor(c.bindings[finished])
            : "Choose the matching component.",
        ),
        button(
          "Choose matching component",
          () =>
            pick("Choose matching component", (v) => {
              syncDraft();
              c.bindings ||= {};
              c.bindings[finished] = v.id;
              renderEditor();
            }),
          "quiet",
        ),
      );
      box.append(binding);
    }
  box.append(
    button(
      "Remove component",
      () => {
        syncDraft();
        state.draft.components.splice(index, 1);
        renderEditor();
      },
      "quiet",
    ),
  );
  $("recipe-components").append(box);
}
$("new-recipe").addEventListener("click", () =>
  perform(() =>
    editRecipe({
      name: "",
      finishedVariantIds: [],
      inventoryOwnership: "unconfirmed",
      components: [],
    }),
  ),
);
$("crown-template").addEventListener("click", () =>
  perform(async () => {
    status("Resolving Crown SKUs and colour bindings against Shopify…");
    const { recipe } = await api("/templates/crown");
    await editRecipe(recipe);
    status("Crown recipe loaded. Review it and save. Stock is unchanged.");
  }, $("crown-template")),
);
$("add-finished").addEventListener("click", () =>
  pick("Choose finished variant", (v) => {
    syncDraft();
    if (!state.draft.finishedVariantIds.includes(v.id))
      state.draft.finishedVariantIds.push(v.id);
    renderEditor();
  }),
);
$("add-component").addEventListener("click", () => {
  syncDraft();
  state.draft.components.push({
    id: crypto.randomUUID(),
    name: "",
    quantity: 1,
    rule: { type: "exact_sku", value: "", excludeVariantIds: [] },
    bindingMode: "any",
    bindings: {},
  });
  renderEditor();
});
$("cancel-edit").addEventListener("click", () => {
  $("recipe-editor").hidden = true;
  state.draft = null;
});
$("recipe-editor").addEventListener("submit", (event) => {
  event.preventDefault();
  perform(async () => {
    syncDraft();
    const draft = state.draft;
    const { recipe } = await api(
      draft.id ? `/recipes/${draft.id}` : "/recipes",
      {
        method: draft.id ? "PUT" : "POST",
        body: JSON.stringify({ recipe: draft, expectedVersion: draft.version }),
      },
    );
    $("recipe-editor").hidden = true;
    await loadRecipes();
    $("assembly-recipe").value = recipe.id;
    changeRecipe();
    status(`Saved ${recipe.name}, version ${recipe.version}.`);
  }, event.currentTarget.querySelector("[type=submit]"));
});
async function loadHistory(older = false) {
  const cursor = older ? state.historyCursor : null;
  const { previews, nextCursor } = await api(
    `/previews${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  state.history = older ? [...state.history, ...previews] : previews;
  state.historyCursor = nextCursor;
  $("history-list").replaceChildren();
  if (!state.history.length)
    $("history-list").append(el("p", "No previews saved yet."));
  for (const p of state.history) {
    const row = el("div", undefined, "history-row"),
      text = el("div");
    text.append(
      el("strong", `${p.quantity} × ${p.finished.sku}`),
      el(
        "p",
        `${new Date(p.createdAt).toLocaleString("en-GB")} · ${p.location.name} · ${p.staff.name}`,
      ),
      el("small", `PREVIEW ONLY · ${p.blockers.length} issues · ${p.id}`),
    );
    row.append(
      text,
      button("View", () => {
        renderPreview(p, "history-detail");
        $("history-detail").scrollIntoView({ behavior: "smooth" });
      }),
    );
    $("history-list").append(row);
  }
  $("older-history").hidden = !nextCursor;
}
$("refresh-history").addEventListener("click", () =>
  perform(() => loadHistory()),
);
$("older-history").addEventListener("click", () =>
  perform(() => loadHistory(true)),
);
perform(async () => {
  try {
    await enter(await api("/session"));
  } catch (error) {
    showLogin();
    if (!error.message.startsWith("Sign in")) status(error.message, true);
  }
});
