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
  waterCooler: [159, 91, 7, 11],
  plant: [170, 65, 14, 19],
  couchBlue: [120, 83, 33, 16],
  couchGreen: [120, 102, 33, 16],
  couchOrange: [120, 121, 33, 16],
  vendDrink: [159, 123, 24, 34],
  vendSnack: [184, 126, 24, 31],
  whiteboard: [84, 70, 26, 20],
  windowTall: [98, 120, 16, 31],
  windowWide: [59, 96, 26, 21],
  printer: [233, 106, 15, 19],
  clock: [159, 108, 19, 6],
  flagIN: [179, 94, 12, 9],
  flagUK: [193, 94, 12, 9],
  flagUS: [207, 94, 12, 9],
  picture: [239, 94, 11, 8],
  bulletin: [234, 81, 17, 11],
  deskBlue: [3, 68, 73, 24],
  counterGray: [171, 44, 79, 17],
  cat: [65, 129, 16, 13],
  corgi: [59, 146, 24, 11],

  // --- lounge / lobby furniture (verified isolated components in the sheet) ---
  benchRed: [85, 47, 26, 16], // short red two-seat bench
  benchRedLong: [115, 47, 40, 16], // long red bench
  couchGrayWide: [119, 66, 33, 15], // blue-gray two-seat couch
  // ponytail: the audit's "shredder" [188,63,17,19] is actually a chunk of the
  // yellow whiteboard, not a shredder. The real standing white shredder/paper
  // bin is the tall component at [240,128,6,19]; using that instead.
  shredder: [240, 128, 6, 19],

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
  // Long blue table-top (3 stacked bars, top-down) — the shared "hot-desk" bench
  // a collab zone is built around. (Same rect as deskBlue; named for its new use.)
  deskBench: [3, 68, 73, 24],
  // Framed cream/tan art panels for the concrete feature wall (the WeWork art
  // wall). 17×19 each — two so the wall isn't a single repeat.
  artPanelA: [188, 63, 17, 19],
  artPanelB: [213, 63, 17, 19],
  // Clean two-tone glass marker board, 26×20. (Same rect as whiteboard above.)
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
  folderRed: [211, 119, 11, 8], // upright file folder, red
  folderBlue: [211, 129, 11, 8], // upright file folder, blue
  folderGreen: [211, 140, 11, 8], // upright file folder, green
};

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
