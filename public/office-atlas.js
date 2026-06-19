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
