
# Colys Leash (colys-leash)

This is somewhat functional, but is still a work in progress. 

Leash a token to a handler with adjustable distance; handler auto-follow (Drag mode by default), and a visual leash ring. Works with Foundry v12 through v14.

## Install (Manual)
1. Download `colys-leash.zip`.
2. Unzip into your Foundry **Data/modules** directory so it becomes `Data/modules/colys-leash/`.
3. In Foundry: **Configuration → Manage Modules → enable “Leash Tokens.”**

## Usage
- Open the **Token HUD** for the token you want leashed.
- Click **Leash** → choose a **handler** token and set the **distance** (scene units, e.g., feet).
- To remove, click **Unleash**.

## Settings
- **Default Leash Distance** — default radius in scene units.
- **Leashed Token Movement Beyond Radius** — Block or Clamp.
- **GM Only** — restrict leash/unleash to GMs.
- **Leash Ring Visibility** — Hover (default), Always, Never.
- **Handler Pull Mode** — Drag (default) or Clamp.

## Notes
- The leash is a circle: the radius is the distance converted to pixels, measured center to center (it is not grid-path measured).
- Handler movement in **Drag** mode pulls the leashed token by the same delta from wherever it currently is, then clamps to the boundary if needed. **Clamp** mode only pulls the token if the handler left it outside the radius.
- Leashes can chain (A leashed to B leashed to C); moving C pulls both.
- Only one client does the pulling: the active GM, or the person who moved the handler if no GM is connected.
- Visual rings are PIXI graphics drawn around the handler.
- Debugging: run `colysLeashDebug = true` in the browser console to log every pull.

## License
MIT
