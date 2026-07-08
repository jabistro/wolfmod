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
  /** Full-screen backdrop behind the home screen. */
  home: ReturnType<typeof require>;
  /** Full-screen backdrop behind the Play menu (Create / Join game). */
  createJoin: ReturnType<typeof require>;
  /** Full-screen backdrop behind the pre-game lobby. */
  lobby: ReturnType<typeof require>;
};

// Per-theme table art (seat avatars + day/night backdrops). All three decks
// are rendered. Add a theme here the same way new decks are added in
// themeArt.ts — drop assets under assets/table/<theme>/ and key them below.
const GHIBLI: TableArt = {
  avatar: require('../../assets/table/ghibli/avatar.jpg'),
  avatarNight: require('../../assets/table/ghibli/avatar_night.jpg'),
  backdropDay: require('../../assets/table/ghibli/day.jpg'),
  backdropNight: require('../../assets/table/ghibli/night.jpg'),
  home: require('../../assets/table/ghibli/home.jpg'),
  createJoin: require('../../assets/table/ghibli/create_join.jpg'),
  lobby: require('../../assets/table/ghibli/lobby.jpg'),
};

const CHIBI: TableArt = {
  avatar: require('../../assets/table/chibi/avatar.jpg'),
  avatarNight: require('../../assets/table/chibi/avatar_night.jpg'),
  backdropDay: require('../../assets/table/chibi/day.jpg'),
  backdropNight: require('../../assets/table/chibi/night.jpg'),
  home: require('../../assets/table/chibi/home.jpg'),
  createJoin: require('../../assets/table/chibi/create_join.jpg'),
  lobby: require('../../assets/table/chibi/lobby.jpg'),
};

const SIXTEEN_BIT: TableArt = {
  avatar: require('../../assets/table/16bit/avatar.jpg'),
  avatarNight: require('../../assets/table/16bit/avatar_night.jpg'),
  backdropDay: require('../../assets/table/16bit/day.jpg'),
  backdropNight: require('../../assets/table/16bit/night.jpg'),
  home: require('../../assets/table/16bit/home.jpg'),
  createJoin: require('../../assets/table/16bit/create_join.jpg'),
  lobby: require('../../assets/table/16bit/lobby.jpg'),
};

const TABLE_ART: Record<Theme, TableArt> = {
  ghibli: GHIBLI,
  chibi: CHIBI,
  '16bit': SIXTEEN_BIT,
};

export function getTableArt(theme: Theme): TableArt {
  return TABLE_ART[theme] ?? GHIBLI;
}
