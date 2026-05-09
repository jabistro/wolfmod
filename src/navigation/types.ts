export type RootStackParamList = {
  Home: undefined;
  Roles: undefined;
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
  Morning: { gameId: string };
  Day: { gameId: string };
  EndGame: { gameId: string };
};
