/**
 * Colys Leash — leash a token to a handler token.
 *
 * How following works (kept deliberately stateless between moves):
 *   - We remember the last known top-left position of every token (_lastPos).
 *   - When a token's x/y changes, the delta is (new position - last known position).
 *   - If that token is the handler of any leashed tokens, each follower is moved by the same delta
 *     from wherever it is *right now*, then clamped to the leash radius around the handler.
 *   - Pulls are queued so a second handler move can never read a follower position that a
 *     previous, still-in-flight pull hasn't finished writing.
 *
 * Set `colysLeashDebug = true` in the browser console to log every pull.
 */

const MODULE_ID = "colys-leash";
const RING_COLOR = 0x4caf50;

/* ---------- Small helpers ---------- */
function dbg(...args) {
  if (globalThis.colysLeashDebug) console.log(`${MODULE_ID} |`, ...args);
}

function getSetting(key, fallback) {
  try { return game.settings.get(MODULE_ID, key); } catch { return fallback; }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(String(str ?? "")));
  return div.innerHTML;
}

/** Scene dimensions work for scenes that are not currently viewed, canvas.dimensions does not. */
function gridSizePx(scene) { return scene?.dimensions?.size ?? canvas?.dimensions?.size ?? 100; }
function gridDistanceUnits(scene) { return scene?.dimensions?.distance ?? canvas?.dimensions?.distance ?? 5; }

function unitsToPixels(units, scene) {
  return (units / gridDistanceUnits(scene)) * gridSizePx(scene);
}

function tokenSizePx(tokenDoc, scene) {
  const size = gridSizePx(scene);
  return { w: (tokenDoc.width ?? 1) * size, h: (tokenDoc.height ?? 1) * size };
}

/** Center of a token, optionally at a hypothetical top-left (x, y). */
function tokenCenter(tokenDoc, scene, x = tokenDoc.x ?? 0, y = tokenDoc.y ?? 0) {
  const { w, h } = tokenSizePx(tokenDoc, scene);
  return { x: x + w / 2, y: y + h / 2 };
}

/** Move `point` onto the circle of `radiusPx` around `anchor` if it lies outside it. */
function clampToRadius(point, anchor, radiusPx) {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= radiusPx + 1e-6 || dist < 1e-6) return point;
  const t = radiusPx / dist;
  return { x: anchor.x + dx * t, y: anchor.y + dy * t };
}

/* ---------- Flag helpers ---------- */
function getLeashFlag(doc) {
  try { return doc?.getFlag(MODULE_ID, "leash"); } catch { return undefined; }
}
async function setLeashFlag(doc, value) {
  try { return await doc.setFlag(MODULE_ID, "leash", value); } catch (e) { console.warn(`${MODULE_ID} | setFlag failed`, e); }
}
async function unsetLeashFlag(doc) {
  try { return await doc.unsetFlag(MODULE_ID, "leash"); } catch (e) { console.warn(`${MODULE_ID} | unsetFlag failed`, e); }
}

/* ---------- Settings ---------- */
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "defaultDistance", {
    name: "Default Leash Distance",
    hint: "Default leash radius in scene units when applying a leash.",
    scope: "world",
    config: true,
    type: Number,
    default: 5
  });

  game.settings.register(MODULE_ID, "exceedBehavior", {
    name: "Leashed Token Movement Beyond Radius",
    hint: "Block movement or clamp to boundary when a token tries to exceed leash.",
    scope: "world",
    config: true,
    type: String,
    choices: { block: "Block", clamp: "Clamp" },
    default: "block"
  });

  game.settings.register(MODULE_ID, "gmOnly", {
    name: "GM Only",
    hint: "If enabled, only GMs may apply or remove leashes.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "ringVisibility", {
    name: "Leash Ring Visibility",
    hint: "When to display the leash ring around the handler.",
    scope: "client",
    config: true,
    type: String,
    choices: { hover: "On hover or control (default)", always: "Always show when a leash exists", never: "Never show" },
    default: "hover"
  });

  game.settings.register(MODULE_ID, "handlerPullMode", {
    name: "Handler Movement Pull Mode",
    hint: "How the leashed token responds when the handler moves.",
    scope: "world",
    config: true,
    type: String,
    choices: { drag: "Drag by the same delta, then clamp", clamp: "Do not drag; only clamp if outside after handler moves" },
    default: "drag"
  });
});

/* ---------- Hooks ---------- */
Hooks.once("ready", () => {
  // Last known top-left position of every token we have seen, so a move's delta never depends on timers.
  const _lastPos = new Map();
  // Context for updates we issue ourselves (also passed via update options; this is the fallback if options are dropped).
  const _internal = new Map();
  const _rings = new Map();
  let _pullQueue = Promise.resolve();

  function seedPositions(scene = canvas?.scene) {
    if (!scene) return;
    for (const td of scene.tokens) _lastPos.set(td.id, { x: td.x, y: td.y });
  }

  /** Context describing an update that this module issued, or undefined for a normal user/other-module update. */
  function internalContext(tokenDoc, options) {
    return options?.[MODULE_ID]?.internal ? options[MODULE_ID] : _internal.get(tokenDoc.id);
  }

  /* ----- Rings ----- */
  const ringKey = (handlerId, targetId) => `${handlerId}:${targetId}`;

  function drawRing(gfx, center, radius) {
    gfx.clear();
    if (typeof gfx.circle === "function" && typeof gfx.stroke === "function") {
      // PIXI v8 style
      gfx.circle(center.x, center.y, radius)
        .fill({ color: RING_COLOR, alpha: 0.06 })
        .stroke({ width: 3, color: RING_COLOR, alpha: 0.9 });
    } else {
      // PIXI v7 style
      gfx.lineStyle(3, RING_COLOR, 0.9);
      gfx.beginFill(RING_COLOR, 0.06);
      gfx.drawCircle(center.x, center.y, radius);
      gfx.endFill();
    }
  }

  function showRingForPair(handlerDoc, targetDoc, distance) {
    try {
      const key = ringKey(handlerDoc.id, targetDoc.id);
      if (_rings.has(key)) return;
      const scene = handlerDoc.parent;
      const gfx = new PIXI.Graphics();
      gfx.zIndex = 1000;
      gfx.eventMode = "none";
      drawRing(gfx, tokenCenter(handlerDoc, scene), unitsToPixels(distance, scene));
      _rings.set(key, gfx);
      canvas.primary.addChild(gfx);
    } catch (err) { console.error(`${MODULE_ID} | showRingForPair error`, err); }
  }

  function removeRingForPair(handlerId, targetId) {
    const key = ringKey(handlerId, targetId);
    const gfx = _rings.get(key);
    if (!gfx) return;
    try { gfx.destroy(true); } catch {}
    _rings.delete(key);
  }

  function updateRingPosition(scene, handlerId, targetId, handlerCenter, distance) {
    const gfx = _rings.get(ringKey(handlerId, targetId));
    if (!gfx) return;
    try { drawRing(gfx, handlerCenter, unitsToPixels(distance, scene)); }
    catch (err) { console.error(`${MODULE_ID} | updateRingPosition error`, err); }
  }

  /* ----- Apply-leash dialog ----- */
  async function openLeashDialog(targetDoc) {
    const scene = targetDoc.parent;
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return ui.notifications.error("Colys Leash needs Foundry v12 or newer.");

    const defaultDistance = getSetting("defaultDistance", 5);
    const handlerOptions = scene.tokens
      .filter(t => t.id !== targetDoc.id)
      .map(t => ({ id: t.id, name: t.name || t.actor?.name || t.id }));
    if (handlerOptions.length === 0) return ui.notifications.warn("No other tokens on the scene to leash to.");

    const optionsHtml = handlerOptions.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join("");
    const unitsName = scene.grid?.units || "units";
    const content = `
      <div class="form-group">
        <label>Handler Token</label>
        <select name="handlerId">${optionsHtml}</select>
      </div>
      <div class="form-group">
        <label>Leash Distance (${escapeHtml(unitsName)})</label>
        <input type="number" name="distance" min="0" step="1" value="${Number(defaultDistance) || 5}">
      </div>`;

    const result = await DialogV2.prompt({
      window: { title: "Apply Leash" },
      content,
      ok: {
        label: "Apply",
        icon: "fa-solid fa-link",
        callback: (event, button) => ({
          handlerId: button.form.elements.handlerId.value,
          distance: parseFloat(button.form.elements.distance.value)
        })
      },
      rejectClose: false
    });
    if (!result) return;

    const { handlerId, distance } = result;
    if (!handlerId || isNaN(distance) || distance <= 0) return ui.notifications.warn("Choose a handler and a positive distance.");
    const handlerDoc = scene.tokens.get(handlerId);
    if (!handlerDoc) return ui.notifications.error("Handler token not found.");

    await setLeashFlag(targetDoc, { handlerId: handlerDoc.id, sceneId: scene.id, distance });
    ui.notifications.info(`Leashed ${targetDoc.name ?? "Token"} to ${handlerDoc.name ?? "Handler"} at ${distance} ${unitsName}.`);
    if (getSetting("ringVisibility", "hover") === "always") showRingForPair(handlerDoc, targetDoc, distance);
  }

  /* ----- Token HUD button (HTMLElement in v13+, jQuery in v12) ----- */
  Hooks.on("renderTokenHUD", (hud, html) => {
    try {
      const root = html instanceof HTMLElement ? html : html?.[0];
      const tokenDoc = hud?.object?.document;
      if (!root || !tokenDoc) return;
      if (getSetting("gmOnly", true) && !game.user.isGM) return;

      root.querySelectorAll("[data-colys-leash]").forEach(el => el.remove()); // HUD re-renders
      const column = root.querySelector(".col.left") ?? root.querySelector(".left") ?? root;
      const leashData = getLeashFlag(tokenDoc);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "control-icon";
      btn.dataset.colysLeash = leashData ? "unleash" : "leash";
      btn.title = leashData ? "Unleash" : "Leash";
      btn.innerHTML = `<i class="fas ${leashData ? "fa-unlink" : "fa-link"}"></i>`;
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (leashData) {
          await unsetLeashFlag(tokenDoc);
          removeRingForPair(leashData.handlerId, tokenDoc.id);
          ui.notifications.info(`Unleashed ${tokenDoc.name ?? "Token"}.`);
        } else {
          openLeashDialog(tokenDoc);
        }
      });
      column.append(btn);
    } catch (err) {
      console.warn(`${MODULE_ID} | renderTokenHUD error`, err);
    }
  });

  /* ----- Enforce the leash when the *leashed* token is moved ----- */
  Hooks.on("preUpdateToken", (tokenDoc, update, options) => {
    if (update.x === undefined && update.y === undefined) return;
    // Remember where this token was before the move (tokenDoc still holds the old position here).
    if (!_lastPos.has(tokenDoc.id)) _lastPos.set(tokenDoc.id, { x: tokenDoc.x, y: tokenDoc.y });

    if (internalContext(tokenDoc, options)) return; // our own pull is already clamped

    const leashData = getLeashFlag(tokenDoc);
    if (!leashData?.handlerId) return;
    const scene = tokenDoc.parent;
    if (!scene || (leashData.sceneId && leashData.sceneId !== scene.id)) return;
    const handlerDoc = scene.tokens.get(leashData.handlerId);
    if (!handlerDoc) return;

    const { w, h } = tokenSizePx(tokenDoc, scene);
    const targetCenter = tokenCenter(tokenDoc, scene, update.x ?? tokenDoc.x, update.y ?? tokenDoc.y);
    const handlerCenter = tokenCenter(handlerDoc, scene);
    const radiusPx = unitsToPixels(leashData.distance, scene);

    if (Math.hypot(targetCenter.x - handlerCenter.x, targetCenter.y - handlerCenter.y) <= radiusPx + 1e-6) return;
    if (getSetting("exceedBehavior", "block") === "block") return false;

    const clamped = clampToRadius(targetCenter, handlerCenter, radiusPx);
    update.x = clamped.x - w / 2;
    update.y = clamped.y - h / 2;
  });

  /* ----- Pull followers when the *handler* moves ----- */
  async function runPull({ sceneId, handlerId, handlerCenter, dx, dy, visited }) {
    const scene = game.scenes.get(sceneId);
    if (!scene) return;
    const mode = getSetting("handlerPullMode", "drag");
    const updates = [];

    for (const td of scene.tokens) {
      const leash = getLeashFlag(td);
      if (!leash || leash.handlerId !== handlerId) continue;
      if (leash.sceneId && leash.sceneId !== scene.id) continue;
      if (visited.includes(td.id)) continue; // never pull a token already moved in this chain (mutual leashes)

      // Read the follower's position *now*, not from some earlier snapshot.
      const current = tokenCenter(td, scene);
      const wanted = mode === "drag" ? { x: current.x + dx, y: current.y + dy } : current;
      const final = clampToRadius(wanted, handlerCenter, unitsToPixels(leash.distance, scene));

      const { w, h } = tokenSizePx(td, scene);
      const x = final.x - w / 2;
      const y = final.y - h / 2;
      dbg(`pull ${td.id}: (${td.x},${td.y}) -> (${x},${y}) [handler delta ${dx},${dy}, mode ${mode}]`);
      if (Math.abs(x - td.x) < 0.01 && Math.abs(y - td.y) < 0.01) continue;
      updates.push({ _id: td.id, x, y });
    }
    if (!updates.length) return;

    const context = { internal: true, visited: [...visited, ...updates.map(u => u._id)] };
    for (const u of updates) _internal.set(u._id, context);
    try {
      await scene.updateEmbeddedDocuments("Token", updates, { [MODULE_ID]: context });
    } finally {
      for (const u of updates) if (_internal.get(u._id) === context) _internal.delete(u._id);
    }
  }

  Hooks.on("updateToken", (tokenDoc, changes, options, userId) => {
    if (changes.x === undefined && changes.y === undefined) return;
    const scene = tokenDoc.parent;
    if (!scene) return;

    // Bookkeeping runs on every client so everyone agrees on where tokens last were.
    const now = { x: tokenDoc.x, y: tokenDoc.y };
    const prev = _lastPos.get(tokenDoc.id);
    _lastPos.set(tokenDoc.id, now);

    const followers = scene.tokens.filter(td => {
      const leash = getLeashFlag(td);
      return leash?.handlerId === tokenDoc.id && (!leash.sceneId || leash.sceneId === scene.id);
    });
    if (!followers.length) return;

    const handlerCenter = tokenCenter(tokenDoc, scene);

    // Rings are client-side graphics, so every client keeps them in step.
    if (scene.id === canvas?.scene?.id) {
      for (const td of followers) updateRingPosition(scene, tokenDoc.id, td.id, handlerCenter, getLeashFlag(td).distance);
    }

    // Exactly one client performs the pull: the active GM, or the mover if no GM is connected.
    const activeGM = game.users?.activeGM;
    const iAmPuller = activeGM ? activeGM.id === game.user.id : userId === game.user.id;
    if (!iAmPuller) return;

    const dx = prev ? now.x - prev.x : 0;
    const dy = prev ? now.y - prev.y : 0;
    const context = internalContext(tokenDoc, options);
    const visited = [...(context?.visited ?? []), tokenDoc.id];
    dbg(`handler ${tokenDoc.id} moved by (${dx},${dy}); ${followers.length} follower(s)`);

    _pullQueue = _pullQueue
      .then(() => runPull({ sceneId: scene.id, handlerId: tokenDoc.id, handlerCenter, dx, dy, visited }))
      .catch(err => console.error(`${MODULE_ID} | pull failed`, err));
  });

  /* ----- Ring visibility ----- */
  Hooks.on("hoverToken", (token, hovered) => {
    try {
      const vis = getSetting("ringVisibility", "hover");
      if (vis === "never" || vis === "always") return;
      const tokenDoc = token?.document;
      const scene = tokenDoc?.parent;
      if (!scene) return;

      for (const td of scene.tokens) {
        const leash = getLeashFlag(td);
        if (!leash) continue;
        const involved = tokenDoc.id === leash.handlerId || tokenDoc.id === td.id;
        if (!involved) continue;
        if (!hovered) { removeRingForPair(leash.handlerId, td.id); continue; }
        const handlerDoc = scene.tokens.get(leash.handlerId);
        if (handlerDoc) showRingForPair(handlerDoc, td, leash.distance);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | hoverToken handler error`, err);
    }
  });

  Hooks.on("controlToken", (token, controlled) => {
    try {
      const vis = getSetting("ringVisibility", "hover");
      if (vis === "never") return;
      const scene = token?.document?.parent;
      if (!scene) return;
      const tokenId = token.document.id;

      for (const td of scene.tokens) {
        const leash = getLeashFlag(td);
        if (!leash) continue;
        if (!controlled && vis !== "always") { removeRingForPair(leash.handlerId, td.id); continue; }
        const handlerDoc = scene.tokens.get(leash.handlerId);
        if (handlerDoc && (tokenId === leash.handlerId || tokenId === td.id || vis === "always")) showRingForPair(handlerDoc, td, leash.distance);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | controlToken handler error`, err);
    }
  });

  /* ----- Housekeeping ----- */
  Hooks.on("canvasReady", () => {
    for (const [, gfx] of _rings) { try { gfx.destroy(true); } catch {} }
    _rings.clear();
    seedPositions();
  });
  Hooks.on("createToken", (tokenDoc) => _lastPos.set(tokenDoc.id, { x: tokenDoc.x, y: tokenDoc.y }));
  Hooks.on("deleteToken", (tokenDoc) => {
    _lastPos.delete(tokenDoc.id);
    const scene = tokenDoc.parent;
    if (!scene) return;
    for (const td of scene.tokens) {
      const leash = getLeashFlag(td);
      if (!leash) continue;
      if (leash.handlerId === tokenDoc.id || td.id === tokenDoc.id) removeRingForPair(leash.handlerId, td.id);
    }
  });

  // canvasReady may already have fired before "ready" on first load.
  if (canvas?.ready) seedPositions();

  /* ----- Public API ----- */
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      leash: async (targetDoc, handlerDoc, distance) =>
        setLeashFlag(targetDoc, { handlerId: handlerDoc.id, sceneId: targetDoc.parent.id, distance }),
      unleash: async (targetDoc) => unsetLeashFlag(targetDoc)
    };
  }
});

console.log(`${MODULE_ID} | leash.js loaded`);
