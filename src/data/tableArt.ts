import type { Theme } from './themeArt';

export type TableArt = {
  /** Square cloaked-villager portrait shown inside every seat (day-lit). */
  avatar: ReturnType<typeof require>;
  /** Moonlit variant of the seat portrait, used during the night phase. */
  avatarNight: ReturnType<typeof require>;
  /** Full-screen backdrop behind the table during the day. */
  backdropDay: ReturnType<typeof require>;
  /** Full-screen backdrop behind the table at night. */
  backdropNight: ReturnType<typeof require>;
};

// Per-theme table art (seat avatars + day/night backdrops). Only ghibli is
// rendered today; chibi and 16bit fall back to ghibli until their own sets
// are generated. Add a theme here the same way new decks are added in
// themeArt.ts — drop assets under assets/table/<theme>/ and key them below.
const GHIBLI: TableArt = {
  avatar: require('../../assets/table/ghibli/avatar.jpg'),
  avatarNight: require('../../assets/table/ghibli/avatar_night.jpg'),
  backdropDay: require('../../assets/table/ghibli/day.jpg'),
  backdropNight: require('../../assets/table/ghibli/night.jpg'),
};

const TABLE_ART: Record<Theme, TableArt> = {
  ghibli: GHIBLI,
  chibi: GHIBLI,
  '16bit': GHIBLI,
};

export function getTableArt(theme: Theme): TableArt {
  return TABLE_ART[theme] ?? GHIBLI;
}
