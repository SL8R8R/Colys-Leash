const MODULE_ID = "colys-leash";

// Defensive runtime fallback for older clients: ensure foundry.utils.escapeHTML exists
window.foundry = window.foundry ?? {};
foundry.utils = foundry.utils ?? {};
if (typeof foundry.utils.escapeHTML !== "function") {
  foundry.utils.escapeHTML = function(s){
    const d = document.createElement("div");
    d.appendChild(document.createTextNode(String(s ?? "")));
    return d.innerHTML;
  };
}

// Immediate load log
console.log(`${MODULE_ID} | leash.js loaded`, { user: game?.user?.id ?? null });

/* ---------- Utilities ---------- */

function unitsToPixels(units) {
  const dims = canvas?.dimensions;
  if (!dims) return 0;
  return (units / dims.distance) * dims.size;
}

function centerFromTopLeft(tokenDoc, x, y) {
  const sizePx = canvas?.dimensions?.size ?? 100;
  const wPx = (tokenDoc.width ?? 1) * sizePx;
  const hPx = (tokenDoc.height ?? 1) * sizePx;
  return { x: x + wPx / 2, y: y + hPx / 2, wPx, hPx };
}

function documentCenterPx(tokenDoc) {
  return centerFromTopLeft(tokenDoc, tokenDoc.x ?? 0, tokenDoc.y ?? 0);
}

function gridDistanceUnits(p1, p2) {
  if (!canvas?.grid?.measureDistance) return 0;
  return canvas.grid.measureDistance(p1, p2);
}

function clampCenterToGrid(handlerC, targetC, maxUnits) {
  // Pixel-based clamping for stability on large drags.
  try {
    const radiusPx = unitsToPixels(maxUnits);
    const dx = targetC.x - handlerC.x;
    const dy = targetC.y - handlerC.y;
    const distPx = Math.hypot(dx, dy);
    if (distPx <= radiusPx || distPx < 1e-6) return { x: targetC.x, y: targetC.y };
    const t = radiusPx / distPx;
    return { x: handlerC.x + dx * t, y: handlerC.y + dy * t };
  } catch (err) {
    // Fallback: conservative binary-search using grid units.
    const currentUnits = gridDistanceUnits(handlerC, targetC);
    if (currentUnits <= maxUnits) return { x: targetC.x, y: targetC.y };
    const dx = targetC.x - handlerC.x;
    const dy = targetC.y - handlerC.y;
    if (Math.hypot(dx, dy) < 1e-6) return { x: handlerC.x, y: handlerC.y };

    let lo = 0, hi = 1, best = 0;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const mx = handlerC.x + dx * mid;
      const my = handlerC.y + dy * mid;
      const d = gridDistanceUnits(handlerC, { x: mx, y: my });
      if (d <= maxUnits) { best = mid; lo = mid; } else { hi = mid; }
    }
    return { x: handlerC.x + dx * best, y: handlerC.y + dy * best };
  }
}

/** Safe HTML-escape helper (uses foundry utils / Handlebars if available) */
function escapeHtml(str) {
  try {
    if (typeof foundry?.utils?.escapeHTML === "function") return foundry.utils.escapeHTML(String(str ?? ""));
  } catch {}
  try {
    if (typeof Handlebars?.escapeExpression === "function") return Handlebars.escapeExpression(String(str ?? ""));
  } catch {}
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(String(str ?? "")));
  return div.innerHTML;
}

/* ---------- Safe Flag Helpers & API ---------- */

function getLeashFlag(doc) {
  try { return doc?.getFlag(MODULE_ID, "leash"); } catch (e) { return undefined; }
}
async function setLeashFlag(doc, value) {
  try { return await doc.setFlag(MODULE_ID, "leash", value); } catch (e) { console.warn(`${MODULE_ID} | setFlag failed`, e); }
}
async function unsetLeashFlag(doc) {
  try { return await doc.unsetFlag(MODULE_ID, "leash"); } catch (e) { console.warn(`${MODULE_ID} | unsetFlag failed`, e); }
}
function safeScopeGetFlag(scope, doc, key) {
  try { return doc?.getFlag(scope, key); } catch (e) { return undefined; }
}

/* ---------- Settings ---------- */
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);

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

/* ---------- Ready: API + Legacy Migration ---------- */
Hooks.once("ready", async () => {
  console.log(`${MODULE_ID} | Ready`);

  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      leash: async (targetDoc, handlerDoc, distance) =>
        setLeashFlag(targetDoc, { handlerId: handlerDoc.id, sceneId: targetDoc.parent.id, distance }),
      unleash: async (targetDoc) => unsetLeashFlag(targetDoc)
    };
    console.log(`${MODULE_ID} | API exposed on game.modules.get("${MODULE_ID}").api`);
  } else {
    console.warn(`${MODULE_ID} | Could not find module entry to attach API`);
  }

  // Migrate legacy flags saved under "sl8r-leash" safely
  const legacyScope = "sl8r-leash";
  if (legacyScope !== MODULE_ID) {
    let migrated = 0;
    try {
      for (const scene of game.scenes) {
        for (const tokenDoc of scene.tokens) {
          try {
            const legacy = safeScopeGetFlag(legacyScope, tokenDoc, "leash");
            if (legacy !== undefined) {
              await tokenDoc.setFlag(MODULE_ID, "leash", legacy);
              try { await tokenDoc.unsetFlag(legacyScope, "leash"); } catch {}
              migrated++;
            }
          } catch (e) { /* ignore per-token errors */ }
        }
      }
    } catch (e) { /* ignore */ }
    if (migrated) console.log(`${MODULE_ID} | Migrated ${migrated} legacy leash flags from '${legacyScope}'`);
  }
});

/* ---------- HUD: Leash / Unleash ---------- */
Hooks.on("renderTokenHUD", (hud, html) => {
  console.debug(`${MODULE_ID} | renderTokenHUD start`, {
    userIsGM: game.user?.isGM,
    gmOnly: (() => { try { return game.settings.get(MODULE_ID, "gmOnly"); } catch { return true; } })(),
    hudExists: !!hud,
    htmlExists: !!html
  });

  const tokenDoc = hud?.object?.document;
  if (!tokenDoc) return;

  let gmOnly = true;
  try { gmOnly = game.settings.get(MODULE_ID, "gmOnly"); } catch (e) { gmOnly = true; }
  if (gmOnly && !game.user.isGM) return;

  let container = html.find(".left");
  if (!container || container.length === 0) container = html.find(".token-control.left");
  if (!container || container.length === 0) container = html;

  try { if (container === html) console.warn(`${MODULE_ID} | Using fallback container (HUD root).`); } catch {}

  const leashData = getLeashFlag(tokenDoc);

  if (!leashData) {
    const btn = $(`<div class="control-icon" data-action="colys-leash" title="Leash"><i class="fas fa-link"></i></div>`);
    btn.on("click", (ev) => { ev.stopPropagation?.(); openLeashDialog(tokenDoc); });
    container.append(btn);
    console.debug(`${MODULE_ID} | appended Leash button`, { tokenId: tokenDoc.id });
  } else {
    const btn = $(`<div class="control-icon" data-action="colys-unleash" title="Unleash"><i class="fas fa-unlink"></i></div>`);
    btn.on("click", async (ev) => {
      ev.stopPropagation?.();
      await unsetLeashFlag(tokenDoc);
      removeRingForPair(leashData.handlerId, tokenDoc.id);
      ui.notifications.info(`Unleashed ${tokenDoc.name ?? "Token"}.`);
    });
    container.append(btn);
    console.debug(`${MODULE_ID} | appended Unleash button`, { tokenId: tokenDoc.id });
  }
});

/* ---------- Dialog ---------- */
function openLeashDialog(targetDoc) {
  let defaultDistance = 5;
  try { defaultDistance = game.settings.get(MODULE_ID, "defaultDistance"); } catch {}
  const handlerOptions = canvas.tokens.placeables
    .filter(t => t.document.id !== targetDoc.id)
    .map(t => ({ id: t.document.id, name: t.document.name || t.document.actor?.name || t.id }));

  if (handlerOptions.length === 0) return ui.notifications.warn("No other tokens on the scene to leash to.");

  const optionsHtml = handlerOptions.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join("");
  const unitsName = canvas.scene.grid.units || "units";
  const content = `
    <form class="${MODULE_ID}-form">
      <div class="form-group">
        <label>Handler Token</label>
        <select name="handlerId">${optionsHtml}</select>
      </div>
      <div class="form-group">
        <label>Leash Distance (${unitsName})</label>
        <input type="number" name="distance" min="0" step="1" value="${defaultDistance}">
      </div>
    </form>
  `;

  new Dialog({
    title: "Apply Leash",
    content,
    buttons: {
      apply: {
        icon: '<i class="fas fa-link"></i>',
        label: "Apply",
        callback: async (html) => {
          const handlerId = html.find('[name="handlerId"]').val();
          const distance = parseFloat(html.find('[name="distance"]').val());
          if (!handlerId || isNaN(distance) || distance <= 0) return ui.notifications.warn("Choose a handler and a positive distance.");
          const scene = targetDoc.parent;
          const handlerDoc = scene.tokens.get(handlerId);
          if (!handlerDoc) return ui.notifications.error("Handler token not found.");

          await setLeashFlag(targetDoc, { handlerId: handlerDoc.id, sceneId: scene.id, distance });
          ui.notifications.info(`Leashed ${targetDoc.name ?? "Token"} to ${handlerDoc.name ?? "Handler"} at ${distance} ${unitsName}.`);
          try { if (game.settings.get(MODULE_ID, "ringVisibility") === "always") showRingForPair(handlerDoc, targetDoc, distance); } catch {}
        }
      },
      cancel: { label: "Cancel" }
    },
    default: "apply"
  }).render(true);
}

/* ---------- Movement Enforcement (Leashed token) ---------- */

// Enforce per-token preUpdate movement (uses pixel clamping, silent).
// Skip enforcement for internal module updates (options.colysLeashInternal).
Hooks.on("preUpdateToken", (tokenDoc, update, options = {}, userId) => {
  if (options?.colysLeashInternal) return;
  if (update.x === undefined && update.y === undefined) return;

  const leashData = getLeashFlag(tokenDoc);
  if (!leashData || !leashData.handlerId) return;

  const scene = tokenDoc.parent;
  if (!scene || leashData.sceneId !== scene.id) return;
  const handlerDoc = scene.tokens.get(leashData.handlerId);
  if (!handlerDoc) return;

  const newX = update.x ?? tokenDoc.x;
  const newY = update.y ?? tokenDoc.y;
  const targetCenter = centerFromTopLeft(tokenDoc, newX, newY);
  const handlerCenter = documentCenterPx(handlerDoc);
  const maxUnits = leashData.distance;

  const radiusPx = unitsToPixels(maxUnits);
  const dx = targetCenter.x - handlerCenter.x;
  const dy = targetCenter.y - handlerCenter.y;
  const distPx = Math.hypot(dx, dy);

  if (distPx <= radiusPx) return;

  let behavior = "block";
  try { behavior = game.settings.get(MODULE_ID, "exceedBehavior"); } catch {}
  if (behavior === "block") {
    return false;
  }

  const t = (radiusPx / distPx) || 0;
  const clampedCenter = { x: handlerCenter.x + dx * t, y: handlerCenter.y + dy * t };
  update.x = clampedCenter.x - targetCenter.wPx / 2;
  update.y = clampedCenter.y - targetCenter.hPx / 2;
});

/* ---------- Handler Auto-Pull (session-aware) ---------- */

// Track small-step deltas for quick moves and sessions for drag operations
const _lastDelta = new Map();
// handlerId -> { startHandlerC: {x,y}, originalCenters: Map(tokenId -> {x,y}), last: timestamp }
const _moveSessions = new Map();

function clearStaleSessions(timeout = 300) {
  const now = Date.now();
  for (const [id, s] of _moveSessions) {
    if ((now - (s.last || 0)) > timeout) _moveSessions.delete(id);
  }
}

// Record delta and start/update a session for handlers
Hooks.on("preUpdateToken", (tokenDoc, update) => {
  if (update.x === undefined && update.y === undefined) return;

  const dx = (update.x ?? tokenDoc.x) - tokenDoc.x;
  const dy = (update.y ?? tokenDoc.y) - tokenDoc.y;
  _lastDelta.set(tokenDoc.id, { dx, dy, t: Date.now() });

  const scene = tokenDoc.parent;
  if (!scene) return;

  // If token is a handler for any leashed tokens, create or refresh a session
  const hasLeashed = scene.tokens.some(td => {
    const leash = getLeashFlag(td);
    return leash && leash.handlerId === tokenDoc.id;
  });
  if (!hasLeashed) return;

  const existing = _moveSessions.get(tokenDoc.id);
  if (!existing) {
    const startHandlerC = documentCenterPx(tokenDoc);
    const originalCenters = new Map();
    for (const td of scene.tokens) {
      const leash = getLeashFlag(td);
      if (!leash || leash.handlerId !== tokenDoc.id) continue;
      originalCenters.set(td.id, documentCenterPx(td));
    }
    _moveSessions.set(tokenDoc.id, { startHandlerC, originalCenters, last: Date.now() });
  } else {
    existing.last = Date.now();
  }
});

// Apply handler-pull/clamp using session cumulative movement (or single-step delta)
Hooks.on("updateToken", async (tokenDoc, changes) => {
  const delta = _lastDelta.get(tokenDoc.id);
  _lastDelta.delete(tokenDoc.id);

  const session = _moveSessions.get(tokenDoc.id);
  if (session) session.last = Date.now();

  if (!delta && !session) return;

  const scene = tokenDoc.parent;
  if (!scene) return;

  const handlerDoc = tokenDoc;
  const handlerCenterNow = documentCenterPx(handlerDoc);
  const updates = [];

  for (const td of scene.tokens) {
    const leash = getLeashFlag(td);
    if (!leash || leash.handlerId !== handlerDoc.id) continue;

    const maxUnits = leash.distance;
    const sizePx = canvas.dimensions.size;
    const wPx = (td.width ?? 1) * sizePx, hPx = (td.height ?? 1) * sizePx;

    const originalCenter = session?.originalCenters?.get(td.id) ?? documentCenterPx(td);

    let proposedCenter;
    if (session && session.startHandlerC) {
      proposedCenter = {
        x: originalCenter.x + (handlerCenterNow.x - session.startHandlerC.x),
        y: originalCenter.y + (handlerCenterNow.y - session.startHandlerC.y)
      };
    } else {
      proposedCenter = { x: originalCenter.x + (delta?.dx ?? 0), y: originalCenter.y + (delta?.dy ?? 0) };
    }

    const radiusPx = unitsToPixels(maxUnits);
    const ddx = proposedCenter.x - handlerCenterNow.x;
    const ddy = proposedCenter.y - handlerCenterNow.y;
    const distPx = Math.hypot(ddx, ddy);

    let finalCenter = proposedCenter;
    if (distPx > radiusPx && distPx > 1e-6) {
      const t = radiusPx / distPx;
      finalCenter = { x: handlerCenterNow.x + ddx * t, y: handlerCenterNow.y + ddy * t };
    }

    updates.push({ _id: td.id, x: finalCenter.x - wPx / 2, y: finalCenter.y - hPx / 2 });

    updateRingPosition(leash.handlerId, td.id, handlerCenterNow, maxUnits);
  }

  if (updates.length) {
    // Mark these updates as internal so preUpdateToken won't block them
    await scene.updateEmbeddedDocuments("Token", updates, { colysLeashInternal: true });
  }

  clearStaleSessions(250);
});

/* ---------- Visual Leash Rings ---------- */

const _rings = new Map();
function ringKey(handlerId, targetId) { return `${handlerId}:${targetId}`; }

function showRingForPair(handlerDoc, targetDoc, distance) {
  try {
    const key = ringKey(handlerDoc.id, targetDoc.id);
    if (_rings.has(key)) return;
    const graphics = new PIXI.Graphics();
    graphics.zIndex = 1000;
    graphics.lineStyle(3, 0x4caf50, 0.9);
    graphics.beginFill(0x4caf50, 0.06);
    const radius = unitsToPixels(distance);
    const handlerCenter = documentCenterPx(handlerDoc);
    graphics.drawCircle(handlerCenter.x, handlerCenter.y, radius);
    graphics.endFill();
    _rings.set(key, graphics);
    canvas.primary.addChild(graphics);
  } catch (err) { console.error(`${MODULE_ID} | showRingForPair error`, err); }
}

function removeRingForPair(handlerId, targetId) {
  const key = ringKey(handlerId, targetId);
  const gfx = _rings.get(key);
  if (!gfx) return;
  try { gfx.destroy(true); } catch {}
  _rings.delete(key);
}

function updateRingPosition(handlerId, targetId, handlerCenter, distance) {
  const key = ringKey(handlerId, targetId);
  const gfx = _rings.get(key);
  if (!gfx) return;
  try {
    gfx.clear();
    gfx.lineStyle(3, 0x4caf50, 0.9);
    gfx.beginFill(0x4caf50, 0.06);
    const radius = unitsToPixels(distance);
    gfx.drawCircle(handlerCenter.x, handlerCenter.y, radius);
    gfx.endFill();
  } catch (err) { console.error(`${MODULE_ID} | updateRingPosition error`, err); }
}

/* ---------- Hover / Control Hooks for Rings ---------- */

Hooks.on("hoverToken", (token, hovered) => {
  try {
    let vis = "hover";
    try { vis = game.settings.get(MODULE_ID, "ringVisibility"); } catch {}
    if (vis === "never") return;

    const tokenDoc = token?.document;
    if (!tokenDoc) return;
    if (vis === "always") return;

    const scene = tokenDoc.parent;
    if (!scene) return;

    if (!hovered) {
      for (const td of scene.tokens) {
        const leash = getLeashFlag(td);
        if (!leash) continue;
        if (leash.handlerId === tokenDoc.id) removeRingForPair(leash.handlerId, td.id);
        if (tokenDoc.id === td.id && leash) removeRingForPair(leash.handlerId, td.id);
      }
      return;
    }

    for (const td of scene.tokens) {
      const leash = getLeashFlag(td);
      if (!leash) continue;
      const handlerDoc = scene.tokens.get(leash.handlerId);
      if (!handlerDoc) continue;
      if (tokenDoc.id === leash.handlerId || tokenDoc.id === td.id) showRingForPair(handlerDoc, td, leash.distance);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | hoverToken handler error (caught)`, err);
  }
});

Hooks.on("controlToken", (token, controlled) => {
  try {
    let vis = "hover";
    try { vis = game.settings.get(MODULE_ID, "ringVisibility"); } catch {}
    if (vis === "never") return;

    const tokenDoc = token?.document;
    if (!tokenDoc) return;

    const scene = tokenDoc.parent;
    if (!scene) return;

    if (!controlled && vis !== "always") {
      for (const td of scene.tokens) {
        const leash = getLeashFlag(td);
        if (!leash) continue;
        removeRingForPair(leash.handlerId, td.id);
      }
      return;
    }

    for (const td of scene.tokens) {
      const leash = getLeashFlag(td);
      if (!leash) continue;
      const handlerDoc = scene.tokens.get(leash.handlerId);
      if (!handlerDoc) continue;
      if (tokenDoc.id === leash.handlerId || tokenDoc.id === td.id || vis === "always") showRingForPair(handlerDoc, td, leash.distance);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | controlToken handler error (caught)`, err);
  }
});

/* ---------- Cleanup ---------- */
Hooks.on("canvasReady", () => { for (const [, gfx] of _rings) { try { gfx.destroy(true); } catch {} } _rings.clear(); });
Hooks.on("deleteToken", (tokenDoc) => {
  const scene = tokenDoc.parent;
  if (!scene) return;
  for (const td of scene.tokens) {
    const leash = getLeashFlag(td);
    if (!leash) continue;
    if (leash.handlerId === tokenDoc.id) removeRingForPair(leash.handlerId, td.id);
    if (td.id === tokenDoc.id) removeRingForPair(leash.handlerId, td.id);
  }
});