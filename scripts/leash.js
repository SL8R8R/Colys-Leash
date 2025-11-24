const MODULE_ID = "sl8r-leash";

/* ---------- Utilities ---------- */

/** Convert scene units to pixels */
function unitsToPixels(units) {
  const dims = canvas?.dimensions;
  if (!dims) return 0;
  return (units / dims.distance) * dims.size;
}

/** Get center (in pixels) for a TokenDocument's proposed top-left x,y */
function centerFromTopLeft(tokenDoc, x, y) {
  const sizePx = canvas?.dimensions?.size ?? 100;
  const wPx = (tokenDoc.width ?? 1) * sizePx;
  const hPx = (tokenDoc.height ?? 1) * sizePx;
  return { x: x + wPx / 2, y: y + hPx / 2, wPx, hPx };
}

/** Current center from a TokenDocument as placed */
function documentCenterPx(tokenDoc) {
  return centerFromTopLeft(tokenDoc, tokenDoc.x ?? 0, tokenDoc.y ?? 0);
}

/** Grid-based distance (scene units) between two pixel points */
function gridDistanceUnits(p1, p2) {
  if (!canvas?.grid?.measureDistance) return 0;
  return canvas.grid.measureDistance(p1, p2);
}

/**
 * Clamp target center to be at most maxUnits from handler center, using grid-based measurement.
 * Returns a new {x,y} center that lies on the segment from handler->target, within grid distance.
 * Binary searches along the ray to respect grid diagonal rules.
 */
function clampCenterToGrid(handlerC, targetC, maxUnits) {
  const currentUnits = gridDistanceUnits(handlerC, targetC);
  if (currentUnits <= maxUnits) return { x: targetC.x, y: targetC.y };
  // Parametric search between handler (t=0) and target (t=1)
  const dx = targetC.x - handlerC.x;
  const dy = targetC.y - handlerC.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: handlerC.x, y: handlerC.y }; // same point

  let lo = 0, hi = 1, best = 0;
  for (let i = 0; i < 24; i++) { // ~16M precision
    const mid = (lo + hi) / 2;
    const mx = handlerC.x + dx * mid;
    const my = handlerC.y + dy * mid;
    const d = gridDistanceUnits(handlerC, { x: mx, y: my });
    if (d <= maxUnits) { best = mid; lo = mid; } else { hi = mid; }
  }
  return { x: handlerC.x + dx * best, y: handlerC.y + dy * best };
}

/* ---------- Settings ---------- */
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);

  game.settings.register(MODULE_ID, "defaultDistance", {
    name: "Default Leash Distance",
    hint: "Default leash radius in scene units (e.g., feet in PF2E) when applying a leash.",
    scope: "world",
    config: true,
    type: Number,
    default: 5
  });

  game.settings.register(MODULE_ID, "exceedBehavior", {
    name: "Leashed Token Movement Beyond Radius",
    hint: "Choose whether a leashed token's own movement beyond the leash is blocked or clamped to the boundary.",
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
    choices: {
      hover: "On hover or control (default)",
      always: "Always show when a leash exists",
      never: "Never show"
    },
    default: "hover"
  });

  game.settings.register(MODULE_ID, "handlerPullMode", {
    name: "Handler Movement Pull Mode",
    hint: "How the leashed token responds when the handler moves.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      drag: "Drag by the same delta, then clamp to boundary",
      clamp: "Do not drag; only clamp if outside boundary after handler moves"
    },
    default: "drag"
  });

  // Minimal API for macros (optional)
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = {
    leash: async (targetDoc, handlerDoc, distance) =>
      targetDoc.setFlag(MODULE_ID, "leash", { handlerId: handlerDoc.id, sceneId: targetDoc.parent.id, distance }),
    unleash: async (targetDoc) =>
      targetDoc.unsetFlag(MODULE_ID, "leash")
  };
});

/* ---------- HUD: Leash / Unleash ---------- */
Hooks.on("renderTokenHUD", (hud, html) => {
  const tokenDoc = hud?.object?.document;
  if (!tokenDoc) return;

  const gmOnly = game.settings.get(MODULE_ID, "gmOnly");
  if (gmOnly && !game.user.isGM) return;

  const left = html.find(".left");
  const leashData = tokenDoc.getFlag(MODULE_ID, "leash");

  if (!leashData) {
    const btn = $(
      `<div class="control-icon" data-action="sl8r-leash" title="Leash"><i class="fas fa-link"></i></div>`
    );
    btn.on("click", () => openLeashDialog(tokenDoc));
    left.append(btn);
  } else {
    const btn = $(
      `<div class="control-icon" data-action="sl8r-unleash" title="Unleash"><i class="fas fa-unlink"></i></div>`
    );
    btn.on("click", async () => {
      await tokenDoc.unsetFlag(MODULE_ID, "leash");
      removeRingForPair(leashData.handlerId, tokenDoc.id);
      ui.notifications.info(`Unleashed ${tokenDoc.name ?? "Token"}.`);
    });
    left.append(btn);
  }
});

/** Dialog to choose handler and distance */
function openLeashDialog(targetDoc) {
  const defaultDistance = game.settings.get(MODULE_ID, "defaultDistance");

  const handlerOptions = canvas.tokens.placeables
    .filter(t => t.document.id !== targetDoc.id)
    .map(t => ({
      id: t.document.id,
      name: t.document.name || t.document.actor?.name || t.id
    }));

  if (handlerOptions.length === 0) {
    return ui.notifications.warn("No other tokens on the scene to leash to.");
  }

  const optionsHtml = handlerOptions
    .map(o => `<option value="${o.id}">${foundry.utils.escapeHTML(o.name)}</option>`)
    .join("");

  const unitsName = canvas.scene.grid.units || "units";
  const content = `
    <form class="${MODULE_ID}-form">
      <div class="form-group">
        <label>Handler Token</label>
        <select name="handlerId">${optionsHtml}</select>
      </div>
      <div class="form-group">
        <label>Leash Distance (${unitsName})</label>
        <input type="number" name="distance" min="0" step="5" value="${defaultDistance}">
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
          if (!handlerId || isNaN(distance) || distance <= 0) {
            return ui.notifications.warn("Choose a handler and a positive distance.");
          }
          const scene = targetDoc.parent;
          const handlerDoc = scene.tokens.get(handlerId);
          if (!handlerDoc) return ui.notifications.error("Handler token not found.");

          await targetDoc.setFlag(MODULE_ID, "leash", {
            handlerId: handlerDoc.id,
            sceneId: scene.id,
            distance
          });

          ui.notifications.info(
            `Leashed ${targetDoc.name ?? "Token"} to ${handlerDoc.name ?? "Handler"} at ${distance} ${unitsName}.`
          );
          // Draw ring if visibility is 'always'
          if (game.settings.get(MODULE_ID, "ringVisibility") === "always") {
            showRingForPair(handlerDoc, targetDoc, distance);
          }
        }
      },
      cancel: { label: "Cancel" }
    },
    default: "apply"
  }).render(true);
}

/* ---------- Movement Enforcement (Leashed token) ---------- */

Hooks.on("preUpdateToken", (tokenDoc, update) => {
  // Only when token is trying to move
  if (update.x === undefined && update.y === undefined) return;

  const leashData = tokenDoc.getFlag(MODULE_ID, "leash");
  if (!leashData || !leashData.handlerId) return;

  const scene = tokenDoc.parent;
  if (!scene || leashData.sceneId !== scene.id) return;
  const handlerDoc = scene.tokens.get(leashData.handlerId);
  if (!handlerDoc) return;

  const newX = update.x ?? tokenDoc.x;
  const newY = update.y ?? tokenDoc.y;

  const targetCenter = centerFromTopLeft(tokenDoc, newX, newY);
  const handlerCenter = documentCenterPx(handlerDoc);
  const distUnits = gridDistanceUnits(handlerCenter, targetCenter);
  const maxUnits = leashData.distance;

  if (distUnits <= maxUnits) return; // allow move

  const behavior = game.settings.get(MODULE_ID, "exceedBehavior");
  const unitsName = canvas.scene.grid.units || "units";
  if (behavior === "block") {
    ui.notifications.warn(
      `${tokenDoc.name ?? "Token"} is leashed: cannot move more than ${maxUnits} ${unitsName} from handler.`
    );
    return false;
  }

  // Clamp: find allowed center using grid-aware clamp
  const clampedCenter = clampCenterToGrid(handlerCenter, targetCenter, maxUnits);
  update.x = clampedCenter.x - targetCenter.wPx / 2;
  update.y = clampedCenter.y - targetCenter.hPx / 2;
  ui.notifications.info(`Movement clamped to ${maxUnits} ${unitsName} leash boundary.`);
});

/* ---------- Handler Auto-Pull ---------- */

// Track deltas during preUpdate to use after the handler completes movement
const _lastDelta = new Map();

Hooks.on("preUpdateToken", (tokenDoc, update) => {
  if (update.x === undefined && update.y === undefined) return;
  const dx = (update.x ?? tokenDoc.x) - tokenDoc.x;
  const dy = (update.y ?? tokenDoc.y) - tokenDoc.y;
  _lastDelta.set(tokenDoc.id, { dx, dy });
});

Hooks.on("updateToken", async (tokenDoc, changes) => {
  const delta = _lastDelta.get(tokenDoc.id);
  _lastDelta.delete(tokenDoc.id);
  if (!delta) return; // not a position change

  // Find any tokens leashed to this handler
  const scene = tokenDoc.parent;
  if (!scene) return;

  const handlerDoc = tokenDoc; // same ref
  const handlerCenter = documentCenterPx(handlerDoc);

  const updates = [];
  for (const td of scene.tokens) {
    const leash = td.getFlag(MODULE_ID, "leash");
    if (!leash || leash.handlerId !== handlerDoc.id) continue;

    const maxUnits = leash.distance;
    const targetCNow = documentCenterPx(td);
    const unitsName = canvas.scene.grid.units || "units";

    let proposedCenter;
    const mode = game.settings.get(MODULE_ID, "handlerPullMode");
    if (mode === "drag") {
      // Move by handler delta
      proposedCenter = { x: targetCNow.x + delta.dx, y: targetCNow.y + delta.dy };
    } else {
      // No drag; just check current position after handler moved
      proposedCenter = targetCNow;
    }

    // Clamp with grid-aware boundary if exceeded
    const dUnits = gridDistanceUnits(handlerCenter, proposedCenter);
    let finalCenter = proposedCenter;
    if (dUnits > maxUnits) {
      finalCenter = clampCenterToGrid(handlerCenter, proposedCenter, maxUnits);
      ui.notifications.info(
        `${td.name ?? "Token"} pulled/clamped to ${maxUnits} ${unitsName} leash boundary.`
      );
    }

    const sizePx = canvas.dimensions.size;
    const wPx = (td.width ?? 1) * sizePx, hPx = (td.height ?? 1) * sizePx;

    updates.push({ _id: td.id, x: finalCenter.x - wPx / 2, y: finalCenter.y - hPx / 2 });
    // Update ring positions if visible
    updateRingPosition(leash.handlerId, td.id, handlerCenter, maxUnits);
  }

  if (updates.length) {
    await scene.updateEmbeddedDocuments("Token", updates);
  }
});

/* ---------- Visual Leash Rings ---------- */

const _rings = new Map(); // key: `${handlerId}:${targetId}` -> PIXI.Graphics

function ringKey(handlerId, targetId) { return `${handlerId}:${targetId}`; }

function showRingForPair(handlerDoc, targetDoc, distance) {
  try {
    const key = ringKey(handlerDoc.id, targetDoc.id);
    if (_rings.has(key)) return; // already shown

    const graphics = new PIXI.Graphics();
    graphics.zIndex = 1000; // above grid, below tokens UI

    // Style
    graphics.lineStyle(3, 0x4caf50, 0.9); // green ring
    graphics.beginFill(0x4caf50, 0.06);  // subtle fill

    const radius = unitsToPixels(distance);
    const handlerCenter = documentCenterPx(handlerDoc);
    graphics.drawCircle(handlerCenter.x, handlerCenter.y, radius);
    graphics.endFill();

    // Stash
    _rings.set(key, graphics);
    canvas.primary.addChild(graphics);
  } catch (err) {
    console.error(`${MODULE_ID} | showRingForPair error`, err);
  }
}

function removeRingForPair(handlerId, targetId) {
  const key = ringKey(handlerId, targetId);
  const gfx = _rings.get(key);
  if (!gfx) return;
  try {
    gfx.destroy(true);
  } catch (e) {}
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
  } catch (err) {
    console.error(`${MODULE_ID} | updateRingPosition error`, err);
  }
}

// Show/hide rings based on hover/control settings
Hooks.on("hoverToken", (token, hovered) => {
  const vis = game.settings.get(MODULE_ID, "ringVisibility");
  if (vis === "never") return;

  const tokenDoc = token?.document;
  if (!tokenDoc) return;

  if (vis === "always") {
    // Always handled by dialog apply and leash/unleash; do nothing here
    return;
  }

  if (!hovered) {
    // Remove any rings for this token (as target) and any where this token is handler
    const scene = tokenDoc.parent;
    for (const td of scene.tokens) {
      const leash = td.getFlag(MODULE_ID, "leash");
      if (leash?.handlerId === tokenDoc.id) removeRingForPair(leash.handlerId, td.id);
      if (tokenDoc.id === td.id && leash) removeRingForPair(leash.handlerId, td.id);
    }
    return;
  }

  // Show rings for relationships involving this token
  const scene = tokenDoc.parent;
  for (const td of scene.tokens) {
    const leash = td.getFlag(MODULE_ID, "leash");
    if (!leash) continue;
    const handlerDoc = scene.tokens.get(leash.handlerId);
    if (!handlerDoc) continue;

    if (tokenDoc.id === leash.handlerId || tokenDoc.id === td.id) {
      showRingForPair(handlerDoc, td, leash.distance);
    }
  }
});

Hooks.on("controlToken", (token, controlled) => {
  const vis = game.settings.get(MODULE_ID, "ringVisibility");
  if (vis === "never") return;

  const tokenDoc = token?.document;
  if (!tokenDoc) return;

  if (!controlled && vis !== "always") {
    // Remove rings related to this token
    const scene = tokenDoc.parent;
    for (const td of scene.tokens) {
      const leash = td.getFlag(MODULE_ID, "leash");
      if (!leash) continue;
      removeRingForPair(leash.handlerId, td.id);
    }
    return;
  }

  // Show rings for this token (as handler or as target)
  const scene = tokenDoc.parent;
  for (const td of scene.tokens) {
    const leash = td.getFlag(MODULE_ID, "leash");
    if (!leash) continue;
    const handlerDoc = scene.tokens.get(leash.handlerId);
    if (!handlerDoc) continue;

    if (tokenDoc.id === leash.handlerId || tokenDoc.id === td.id || vis === "always") {
      showRingForPair(handlerDoc, td, leash.distance);
    }
  }
});

// Clean rings on canvas/scene changes
Hooks.on("canvasReady", () => { for (const [, gfx] of _rings) { try { gfx.destroy(true); } catch {} } _rings.clear(); });
Hooks.on("deleteToken", (tokenDoc) => {
  // Remove any rings involving this token (as handler or target)
  const scene = tokenDoc.parent;
  for (const td of scene.tokens) {
    const leash = td.getFlag(MODULE_ID, "leash");
    if (!leash) continue;
    if (leash.handlerId === tokenDoc.id) removeRingForPair(leash.handlerId, td.id);
    if (td.id === tokenDoc.id) removeRingForPair(leash.handlerId, td.id);
  }
});
