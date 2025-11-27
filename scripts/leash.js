const MODULE_ID = "colys-leash";

/* ---------- Runtime guards for late loads ---------- */
let __colys_inited = false;
let __colys_ready = false;
let __colys_hooks_registered = false;

/* ---------- Defensive helpers ---------- */
window.foundry = window.foundry ?? {};
foundry.utils = foundry.utils ?? {};
if (typeof foundry.utils.escapeHTML !== "function") {
  foundry.utils.escapeHTML = function(s){
    const d = document.createElement("div");
    d.appendChild(document.createTextNode(String(s ?? "")));
    return d.innerHTML;
  };
}

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

/* ---------- Flag helpers ---------- */
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

/* ---------- Settings registration (only once at init) ---------- */
Hooks.once("init", () => {
  if (__colys_inited) return;
  __colys_inited = true;
  console.log(`${MODULE_ID} | init: registering settings`);

  try {
    game.settings.register(MODULE_ID, "defaultDistance", {
      name: "Default Leash Distance",
      hint: "Default leash radius in scene units when applying a leash.",
      scope: "world",
      config: true,
      type: Number,
      default: 5
    });
  } catch (e) {}

  try {
    game.settings.register(MODULE_ID, "exceedBehavior", {
      name: "Leashed Token Movement Beyond Radius",
      hint: "Block movement or clamp to boundary when a token tries to exceed leash.",
      scope: "world",
      config: true,
      type: String,
      choices: { block: "Block", clamp: "Clamp" },
      default: "block"
    });
  } catch (e) {}

  try {
    game.settings.register(MODULE_ID, "gmOnly", {
      name: "GM Only",
      hint: "If enabled, only GMs may apply or remove leashes.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });
  } catch (e) {}

  try {
    game.settings.register(MODULE_ID, "ringVisibility", {
      name: "Leash Ring Visibility",
      hint: "When to display the leash ring around the handler.",
      scope: "client",
      config: true,
      type: String,
      choices: { hover: "On hover or control (default)", always: "Always show when a leash exists", never: "Never show" },
      default: "hover"
    });
  } catch (e) {}

  try {
    game.settings.register(MODULE_ID, "handlerPullMode", {
      name: "Handler Movement Pull Mode",
      hint: "How the leashed token responds when the handler moves.",
      scope: "world",
      config: true,
      type: String,
      choices: { drag: "Drag by the same delta, then clamp", clamp: "Do not drag; only clamp if outside after handler moves" },
      default: "drag"
    });
  } catch (e) {}
});

/* ---------- Register all game hooks at ready ---------- */
Hooks.once("ready", () => {
  if (__colys_hooks_registered) return;
  __colys_hooks_registered = true;
  console.log(`${MODULE_ID} | ready: registering hooks`);

  // Internal state
  const _internalUpdating = new Set();
  const _lastDelta = new Map();
  const _moveSessions = new Map();
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

  // HUD Hook
  Hooks.on("renderTokenHUD", (hud, html) => {
    try {
      const tokenDoc = hud?.object?.document;
      if (!tokenDoc) return;

      let gmOnly = true;
      try { gmOnly = game.settings.get(MODULE_ID, "gmOnly"); } catch (e) { gmOnly = true; }
      if (gmOnly && !game.user.isGM) return;

      let container = html.find(".left");
      if (!container || container.length === 0) container = html.find(".token-control.left");
      if (!container || container.length === 0) container = html;

      const leashData = getLeashFlag(tokenDoc);

      if (!leashData) {
        const btn = $(`<div class="control-icon" data-action="colys-leash" title="Leash"><i class="fas fa-link"></i></div>`);
        btn.on("click", (ev) => { ev.stopPropagation?.(); openLeashDialog(tokenDoc); });
        container.append(btn);
      } else {
        const btn = $(`<div class="control-icon" data-action="colys-unleash" title="Unleash"><i class="fas fa-unlink"></i></div>`);
        btn.on("click", async (ev) => {
          ev.stopPropagation?.();
          await unsetLeashFlag(tokenDoc);
          removeRingForPair(leashData.handlerId, tokenDoc.id);
          ui.notifications.info(`Unleashed ${tokenDoc.name ?? "Token"}.`);
        });
        container.append(btn);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | renderTokenHUD error`, err);
    }
  });

  // Movement enforcement: preUpdateToken
  Hooks.on("preUpdateToken", (tokenDoc, update, options = {}, userId) => {
    if (_internalUpdating.has(tokenDoc.id)) return;
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

    // Ensure the leashed token is updated based on the handler's current position
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

  // Session tracking: record delta and start session for handlers
  Hooks.on("preUpdateToken", (tokenDoc, update) => {
    if (update.x === undefined && update.y === undefined) return;
    const dx = (update.x ?? tokenDoc.x) - tokenDoc.x;
    const dy = (update.y ?? tokenDoc.y) - tokenDoc.y;
    _lastDelta.set(tokenDoc.id, { dx, dy, t: Date.now() });

    const scene = tokenDoc.parent;
    if (!scene) return;

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

  // Handler auto-pull: apply movement to leashed tokens
  function clearStaleSessions(timeout = 300) {
    const now = Date.now();
    for (const [id, s] of _moveSessions) {
      if ((now - (s.last || 0)) > timeout) _moveSessions.delete(id);
    }
  }

  // Track previous handler positions (MOVED OUTSIDE updateToken hook)
  const _prevHandlerPos = new Map();

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
    
    // Initialize previous position on first move (use delta if available)
    let prevHandlerPos = _prevHandlerPos.get(handlerDoc.id);
    if (!prevHandlerPos && delta) {
      // First move: calculate previous position from the delta
      prevHandlerPos = { x: handlerCenterNow.x - delta.dx, y: handlerCenterNow.y - delta.dy };
    } else if (!prevHandlerPos) {
      // No delta and no previous position: use current
      prevHandlerPos = { x: handlerCenterNow.x, y: handlerCenterNow.y };
    }
    
    // Store current position for next update (ONLY x and y, not wPx/hPx)
    _prevHandlerPos.set(handlerDoc.id, { x: handlerCenterNow.x, y: handlerCenterNow.y });

    const updates = [];

    for (const td of scene.tokens) {
        const leash = getLeashFlag(td);
        if (!leash || leash.handlerId !== handlerDoc.id) continue;

        const maxUnits = leash.distance;
        const sizePx = canvas.dimensions.size;
        const wPx = (td.width ?? 1) * sizePx, hPx = (td.height ?? 1) * sizePx;

        // Get current leashed token center
        const currentCenter = documentCenterPx(td);

        // Decide base center and displacement. If a move *session* exists (handler started a drag),
        // use the original center captured at session start so large/fast handler moves apply the
        // full displacement. Otherwise fall back to incremental delta using _prevHandlerPos.
        const sessionForHandler = _moveSessions.get(handlerDoc.id);

        let baseCenter = currentCenter;
        if (sessionForHandler && sessionForHandler.originalCenters && sessionForHandler.originalCenters.has(td.id)) {
          baseCenter = sessionForHandler.originalCenters.get(td.id);
        }

        let dispX, dispY;
        if (sessionForHandler && sessionForHandler.startHandlerC) {
          dispX = handlerCenterNow.x - sessionForHandler.startHandlerC.x;
          dispY = handlerCenterNow.y - sessionForHandler.startHandlerC.y;
          // If the session-derived displacement is effectively zero but a previous handler
          // position exists (meaning the handler did move), fall back to the incremental delta
          // and apply it to the current token center so we don't apply a stale/origin-based move.
          if (Math.abs(dispX) < 1e-6 && Math.abs(dispY) < 1e-6 && prevHandlerPos && (prevHandlerPos.x !== handlerCenterNow.x || prevHandlerPos.y !== handlerCenterNow.y)) {
            dispX = handlerCenterNow.x - prevHandlerPos.x;
            dispY = handlerCenterNow.y - prevHandlerPos.y;
            baseCenter = currentCenter;
          }
        } else {
          dispX = handlerCenterNow.x - prevHandlerPos.x;
          dispY = handlerCenterNow.y - prevHandlerPos.y;
        }

        const proposedCenter = {
          x: baseCenter.x + dispX,
          y: baseCenter.y + dispY
        };

        // Clamp to radius around handler's NEW position
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

        // Optional debug output (enable by setting `window.colysLeashDebug = true` in the Foundry console)
        try {
          if (typeof window !== "undefined" && window.colysLeashDebug) {
            console.log(`${MODULE_ID} | Handler disp: dx=${dispX}, dy=${dispY}, prevPos: `, prevHandlerPos, " currentPos: ", handlerCenterNow);
            console.log(`${MODULE_ID} | Leashed token ${td.id}: current=${currentCenter.x},${currentCenter.y} -> proposed=${proposedCenter.x},${proposedCenter.y} -> final=${finalCenter.x},${finalCenter.y} radius=${radiusPx}`);
          }
        } catch (e) {}

        updateRingPosition(leash.handlerId, td.id, handlerCenterNow, maxUnits);
    }

    if (updates.length) {
        for (const u of updates) _internalUpdating.add(u._id);
        try {
            await scene.updateEmbeddedDocuments("Token", updates, { render: true });
        } finally {
            for (const u of updates) _internalUpdating.delete(u._id);
        }
    }

    clearStaleSessions(250);
  });

  // Ring visibility: hover
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
      console.warn(`${MODULE_ID} | hoverToken handler error`, err);
    }
  });

  // Ring visibility: control
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
      console.warn(`${MODULE_ID} | controlToken handler error`, err);
    }
  });

  // Cleanup
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

  // Expose API
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      leash: async (targetDoc, handlerDoc, distance) =>
        setLeashFlag(targetDoc, { handlerId: handlerDoc.id, sceneId: targetDoc.parent.id, distance }),
      unleash: async (targetDoc) => unsetLeashFlag(targetDoc)
    };
  }
});

/* ---------- Load-time log ---------- */
console.log(`${MODULE_ID} | leash.js loaded`);