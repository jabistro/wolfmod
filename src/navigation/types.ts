export type RootStackParamList = {
  Home: undefined;
  Roles: undefined;
  Settings: undefined;
  Themes: undefined;
  TimerDefaults: undefined;
  ClockSetup: undefined;
  Clock: {
    dayDuration: number;
    accusationDuration: number;
    defenseDuration: number;
    nominations: number;
  };
  PlayMenu: undefined;
  CreateGame: undefined;
  JoinGame: undefined;
  Lobby: { gameId: string };
  RoleReveal: { gameId: string };
  Night: { gameId: string };
  Triggers: { gameId: string };
  Morning: { gameId: string };
  // `fromReveal` marks the one-time Day 1 birth out of the role-reveal screen,
  // so the navigator plays the slow night→day cross-fade (mirroring the
  // night→morning dawn dissolve) instead of the default snappy cut.
  Day: { gameId: string; fromReveal?: boolean };
  EndGame: { gameId: string };
};
