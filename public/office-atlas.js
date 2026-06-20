// office-atlas.js — the CC0 "PixelOffice" sprite sheet (2dPig) + named sub-rects.
// Rects were auto-extracted from the sheet's transparent gutters (alpha gutters
// → bounding boxes), so they're pixel-exact. Sprites are blitted 1:1 into the
// low-res buffer and scaled up crisply by CSS (image-rendering: pixelated).

export const sheet = new Image();
let loaded = false;
sheet.onload = () => { loaded = true; };
sheet.src = '/office-assets.png';
export const sheetReady = () => loaded;

// [sx, sy, sw, sh] in sheet pixels.
export const SPR = {
  sky: [0, 0, 256, 38],
  coffeeMachine: [159, 91, 7, 11], // (was "waterCooler" — v3 catalog)
  treePlant: [170, 65, 14, 19],    // (was "plant" — v3 catalog)
  couchBlue: [120, 83, 33, 16],
  couchGreen: [120, 102, 33, 16],
  couchOrange: [120, 121, 33, 16],
  vendDrink: [159, 123, 24, 34],
  vendSnack: [184, 126, 24, 31],
  wall: [84, 70, 26, 20],          // (was "whiteboard" — v3 catalog; same rect as glassBoard)
  door: [98, 120, 16, 31],         // (was "windowTall" — v3 catalog)
  windowWide: [59, 96, 26, 21],
  // (the old "printer" [233,106,15,19] was the same rect as the real monitorA —
  //  see the desk-monitor block below; the canonical name is monitorA.)
  clock: [159, 108, 19, 6],
  flagIN: [179, 94, 12, 9],
  flagUK: [193, 94, 12, 9],
  flagUS: [207, 94, 12, 9],
  picture: [239, 94, 11, 8],
  calendar: [234, 81, 17, 11],     // (was "bulletin" — v3 catalog)
  // floorBlue: the blue brick FLOOR tile (was mislabeled "deskBlue"/"deskBench"
  // and misused as a desk — it's a 73×24 floor-tile chunk: light-cyan top
  // highlight, blue body, dark seams, staggered brick joints). Tiled across the
  // floor in the Neighborhoods (hybrid) layout via drawBlueFloor() in render.js.
  floorBlue: [3, 68, 73, 24],
  counterGray: [171, 44, 79, 17], // grey-blue COUNTER desk top (real desk surface)
  cat: [65, 129, 16, 13],
  corgi: [59, 146, 24, 11],

  // --- lounge / lobby furniture (verified isolated components in the sheet) ---
  table: [85, 47, 26, 16],     // (was "benchRed" — v3 catalog: a table)
  tableLong: [115, 47, 40, 16], // (was "benchRedLong" — v3 catalog)
  couchGrayWide: [119, 66, 33, 15], // blue-gray two-seat couch
  // (removed the bogus "shredder" [240,128,6,19] — that rect is the real monitorB,
  //  a side-view flatscreen; see the desk-monitor block below.)

  // --- WeWork redesign additions (verified via connected-component bbox pass) --
  // (Two-seat couches in blue/green/orange already exist above as couchBlue/
  //  couchGreen/couchOrange; the lounge zones rotate through those + couchGrayWide.)
  // Side-view accent chairs (11×22) in six colors — pulled up to lounge tables
  // and the collab bench for that scattered, organic café-seating look.
  chairOrange: [6, 41, 11, 22],
  chairYellow: [19, 41, 11, 22],
  chairGreen: [32, 41, 11, 22],
  chairBlue: [45, 41, 11, 22],
  chairWhite: [58, 41, 11, 22],
  chairGray: [71, 41, 11, 22],
  // (Removed the bogus "deskBench" alias — it pointed at the floorBlue tile, not
  // a desk; the collab zone now builds its table from counterGray instead.)
  // v3 catalog: these two 17×19 units are cubicle TABLES (were mislabeled
  // "artPanelA/B"; still used as the feature-wall art panels in drawBackWall —
  // same pixels, just the correct name now).
  cubicleTableL: [188, 63, 17, 19],
  cubicleTableR: [213, 63, 17, 19],
  // Clean two-tone glass marker board, 26×20. (Same rect as wall above.)
  glassBoard: [84, 70, 26, 20],
  // Second floor-to-ceiling window style (a wider double-pane), 26×21.
  windowWideB: [88, 96, 26, 21],

  // --- desk props (small isolated components, sit on the desk surface) --------
  // ponytail: the audit's "coffeeMug" [169,95,8,7] is a small green-striped
  // appliance, not a clean mug — omitted; the procedural mug (drawDeskItem
  // kind 1) is used for mugs instead. trayB corrected to 6px wide (the [192,...]
  // component is 6 wide, not 9; [200,107,9,9] is a tiny monitor, not a tray).
  trayA: [183, 107, 6, 8], // paper in-tray with a red folder tab
  trayB: [192, 107, 6, 9], // paper in-tray

  // BOOKS — colored book stacks (red/blue/green cover + white page edge + base).
  // (Were repeatedly mislabeled "folderRed/Blue/Green" and then "monitorRed/…";
  // user pixel-audit confirmed they are BOOKS, not monitors. Kept as desk decor.)
  booksRed: [211, 119, 11, 8],
  booksBlue: [211, 129, 11, 8],
  booksGreen: [211, 140, 11, 8],

  // --- desk MONITORS + keyboard (bottom-RIGHT of the sheet; user pixel-audit) ---
  // The REAL monitors are SIDE-VIEW units (a 3/4-side perspective the pack mixes
  // with its front-facing characters — accept it, don't "fix" it):
  //   monitorA = a complete monitor+keyboard COMBO: tilted white screen, blue-gray
  //     body, 3-button base, checkered keyboard at lower-left. (Atlas had this
  //     mislabeled "copier"/"printer".) Tier color = tint its white screen region.
  //   monitorB = a tall thin side-view flatscreen. (Was mislabeled "shredder".)
  //   keyboardB = the checkered side strip, monitorB's companion keyboard.
  //     (Checkerboards are keyboards, not shredders. monitorA carries its own
  //     keyboard, so it needs no separate one.)
  monitorA: [233, 106, 15, 19],
  monitorB: [240, 128, 6, 19],
  keyboardB: [233, 135, 5, 12],

  // --- standing worker characters (bottom-left of the sheet, by the cat/corgi) -
  // Five front-facing standing people, extracted via the same alpha-gutter
  // connected-component bbox pass as the furniture (8-connected, human-sized
  // blobs). Used as the HYBRID mode's character layer (drawCharacter STATIC kind)
  // until generated animated atlases swap in. Boxes are tight to the visible
  // pixels, so their feet sit at sy+sh-1 — anchor on that for floor placement.
  // worker2's box is wider because that pose raises an arm (a little wave).
  worker1: [2, 105, 15, 23],  // dark hair, grey top, blue jeans
  worker2: [19, 104, 19, 24], // auburn hair, white logo tee, arm raised (wave)
  worker3: [40, 107, 13, 21], // grey hair + glasses, white "C" tee (senior look)
  worker4: [3, 132, 17, 23],  // red hair, blue tee
  worker5: [22, 132, 17, 23], // dark hair, dark-red tee

  // --- decor (v3 catalog names; available as floor/desk decor) -----------------
  trashGreen: [116, 143, 9, 14], // (was "computerTerminalGreen")
  trashRed: [126, 143, 9, 14],   // (was "computerTerminalRed")
  trashBlue: [136, 143, 9, 14],  // (was "computerTerminalBlue")
  waterFountain: [147, 140, 9, 17], // (was "computerTerminalBlueBase"/term-blueBase)
  cubicleWall: [207, 63, 4, 27], // thin tall divider (was "poleLamp")
  cup: [169, 95, 8, 7],          // small cup (was "microwave")
  printer: [200, 107, 9, 9],     // small grey printer (was "applianceGray")

  // --- small props (v3 catalog additions) --------------------------------------
  pinTan: [217, 107, 2, 3],
  pinGreen: [221, 109, 2, 3],
  pinPurple: [217, 112, 2, 3],
  mouse: [233, 148, 4, 3],
  paper: [211, 151, 10, 6],

  // --- individual clouds (sky band [0,0,256,38] still exists as `sky`) ----------
  cloudBigA: [4, 8, 52, 23],
  cloudSmA: [61, 6, 34, 15],
  cloudSmB: [111, 19, 34, 15],
  cloudBigB: [158, 2, 52, 23],
  cloudSmC: [214, 17, 34, 15],
};

// Ordered list of the standing-worker SPR keys, for deterministic per-agent
// assignment in hybrid mode (worker[hash % WORKER_SPRITES.length]).
export const WORKER_SPRITES = ['worker1', 'worker2', 'worker3', 'worker4', 'worker5'];

export const sprW = (name, s = 1) => SPR[name][2] * s;
export const sprH = (name, s = 1) => SPR[name][3] * s;

// Blit a named sprite with its bottom-left at... no — top-left at (dx, dy),
// integer-scaled. Returns the drawn width so callers can flow items in a row.
export function blit(ctx, name, dx, dy, scale = 1) {
  const r = SPR[name];
  if (!r || !loaded) return 0;
  ctx.drawImage(sheet, r[0], r[1], r[2], r[3], dx | 0, dy | 0, (r[2] * scale) | 0, (r[3] * scale) | 0);
  return r[2] * scale;
}

// Blit with the sprite's FEET on baselineY (i.e. bottom-aligned) — handy for
// standing furniture against the back wall.
export function blitStanding(ctx, name, dx, baselineY, scale = 1) {
  return blit(ctx, name, dx, baselineY - sprH(name, scale), scale);
}

// The white SCREEN region within monitorA, in LOCAL sprite pixels (the bright
// 244-valued screen face; the checkered keyboard + base buttons are left alone).
// Verified by pixel map: the screen is the 5×7 block at (6,1). We tint this whole
// region so the model-tier colour gets the largest possible area on a 1x sprite.
export const MONITOR_SCREEN = { x: 6, y: 1, w: 5, h: 7 };

// Blit the real desk monitor (monitorA = monitor+keyboard combo) with its SCREEN
// recolored to `screenColor` (the model-tier signal). `dx,dy` = top-left,
// integer-scaled. Returns the drawn width (0 until the sheet has loaded).
export function blitMonitor(ctx, dx, dy, scale, screenColor) {
  if (!loaded) return 0;
  blit(ctx, 'monitorA', dx, dy, scale); // monitor body + screen + keyboard + base
  if (screenColor) {
    const s = MONITOR_SCREEN;
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = screenColor;
    ctx.fillRect((dx + s.x * scale) | 0, (dy + s.y * scale) | 0, (s.w * scale) | 0, (s.h * scale) | 0);
    ctx.imageSmoothingEnabled = prev;
  }
  return sprW('monitorA', scale);
}
