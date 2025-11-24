
# Leash Tokens (colys-leash)

Leash a token to a handler with adjustable distance; grid-based measurement (PF2E square grid), handler auto-follow (Drag mode by default), and a visual leash ring.

## Install (Manual)
1. Download `colys-leash-v1.2.0.zip`.
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
- Distance uses `canvas.grid.measureDistance` (grid-aware, diagonal rules respected).
- Handler movement in **Drag** mode pulls the leashed token by the same delta, then clamps to boundary if needed.
- Visual rings are PIXI graphics drawn around the handler.

## License
MIT
