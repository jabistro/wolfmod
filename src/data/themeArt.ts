import { isV1Role } from './v1Roles';
import { ROLES } from './roles';

export type Theme = 'ghibli' | 'chibi' | '16bit';

export const THEMES: { key: Theme; label: string }[] = [
  { key: 'ghibli', label: 'Ghibli' },
  { key: 'chibi', label: 'Chibi' },
  { key: '16bit', label: '16-Bit' },
];

type Art = { image: ReturnType<typeof require>; thumb: ReturnType<typeof require> };

const LOCKED_ART: Record<Theme, Art> = {
  ghibli: {
    image: require('../../roles_ghibli_medium/unlocktoplay.jpg'),
    thumb: require('../../roles_ghibli_thumbs/unlocktoplay.jpg'),
  },
  chibi: {
    image: require('../../roles_chibi_medium/unlocktoplay.jpg'),
    thumb: require('../../roles_chibi_thumbs/unlocktoplay.jpg'),
  },
  '16bit': {
    image: require('../../roles_16bit_medium/unlocktoplay.jpg'),
    thumb: require('../../roles_16bit_thumbs/unlocktoplay.jpg'),
  },
};

// Theme overrides for V1 roles. Ghibli is omitted — falls through to the
// `image`/`thumb` on the Role itself (which already point at the ghibli deck).
const V1_OVERRIDES: Record<string, Partial<Record<Theme, Art>>> = {
  Villager: {
    chibi: { image: require('../../roles_chibi_medium/villager.jpg'), thumb: require('../../roles_chibi_thumbs/villager.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/villager.jpg'), thumb: require('../../roles_16bit_thumbs/villager.jpg') },
  },
  Seer: {
    chibi: { image: require('../../roles_chibi_medium/seer.jpg'), thumb: require('../../roles_chibi_thumbs/seer.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/seer.jpg'), thumb: require('../../roles_16bit_thumbs/seer.jpg') },
  },
  Witch: {
    chibi: { image: require('../../roles_chibi_medium/witch.jpg'), thumb: require('../../roles_chibi_thumbs/witch.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/witch.jpg'), thumb: require('../../roles_16bit_thumbs/witch.jpg') },
  },
  Bodyguard: {
    chibi: { image: require('../../roles_chibi_medium/bodyguard.jpg'), thumb: require('../../roles_chibi_thumbs/bodyguard.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/bodyguard.jpg'), thumb: require('../../roles_16bit_thumbs/bodyguard.jpg') },
  },
  Hunter: {
    chibi: { image: require('../../roles_chibi_medium/hunter.jpg'), thumb: require('../../roles_chibi_thumbs/hunter.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/hunter.jpg'), thumb: require('../../roles_16bit_thumbs/hunter.jpg') },
  },
  Huntress: {
    chibi: { image: require('../../roles_chibi_medium/huntress.jpg'), thumb: require('../../roles_chibi_thumbs/huntress.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/huntress.jpg'), thumb: require('../../roles_16bit_thumbs/huntress.jpg') },
  },
  Mentalist: {
    chibi: { image: require('../../roles_chibi_medium/mentalist.jpg'), thumb: require('../../roles_chibi_thumbs/mentalist.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/mentalist.jpg'), thumb: require('../../roles_16bit_thumbs/mentalist.jpg') },
  },
  'Paranormal Investigator': {
    chibi: { image: require('../../roles_chibi_medium/paranormal_investigator.jpg'), thumb: require('../../roles_chibi_thumbs/paranormal_investigator.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/paranormal_investigator.jpg'), thumb: require('../../roles_16bit_thumbs/paranormal_investigator.jpg') },
  },
  'Tough Guy': {
    chibi: { image: require('../../roles_chibi_medium/tough_guy.jpg'), thumb: require('../../roles_chibi_thumbs/tough_guy.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/tough_guy.jpg'), thumb: require('../../roles_16bit_thumbs/tough_guy.jpg') },
  },
  Diseased: {
    chibi: { image: require('../../roles_chibi_medium/diseased.jpg'), thumb: require('../../roles_chibi_thumbs/diseased.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/diseased.jpg'), thumb: require('../../roles_16bit_thumbs/diseased.jpg') },
  },
  Revealer: {
    chibi: { image: require('../../roles_chibi_medium/revealer.jpg'), thumb: require('../../roles_chibi_thumbs/revealer.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/revealer.jpg'), thumb: require('../../roles_16bit_thumbs/revealer.jpg') },
  },
  'Mad Bomber': {
    chibi: { image: require('../../roles_chibi_medium/mad_bomber.jpg'), thumb: require('../../roles_chibi_thumbs/mad_bomber.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/mad_bomber.jpg'), thumb: require('../../roles_16bit_thumbs/mad_bomber.jpg') },
  },
  Leprechaun: {
    chibi: { image: require('../../roles_chibi_medium/leprechaun.jpg'), thumb: require('../../roles_chibi_thumbs/leprechaun.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/leprechaun.jpg'), thumb: require('../../roles_16bit_thumbs/leprechaun.jpg') },
  },
  Werewolf: {
    chibi: { image: require('../../roles_chibi_medium/werewolf.jpg'), thumb: require('../../roles_chibi_thumbs/werewolf.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/werewolf.jpg'), thumb: require('../../roles_16bit_thumbs/werewolf.jpg') },
  },
  'Wolf Man': {
    chibi: { image: require('../../roles_chibi_medium/wolf_man.jpg'), thumb: require('../../roles_chibi_thumbs/wolf_man.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/wolf_man.jpg'), thumb: require('../../roles_16bit_thumbs/wolf_man.jpg') },
  },
  'Hunter Wolf': {
    chibi: { image: require('../../roles_chibi_medium/hunter_wolf.jpg'), thumb: require('../../roles_chibi_thumbs/hunter_wolf.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/hunter_wolf.jpg'), thumb: require('../../roles_16bit_thumbs/hunter_wolf.jpg') },
  },
  'Wolf Cub': {
    chibi: { image: require('../../roles_chibi_medium/wolf_cub.jpg'), thumb: require('../../roles_chibi_thumbs/wolf_cub.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/wolf_cub.jpg'), thumb: require('../../roles_16bit_thumbs/wolf_cub.jpg') },
  },
  Minion: {
    chibi: { image: require('../../roles_chibi_medium/minion.jpg'), thumb: require('../../roles_chibi_thumbs/minion.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/minion.jpg'), thumb: require('../../roles_16bit_thumbs/minion.jpg') },
  },
  Reviler: {
    chibi: { image: require('../../roles_chibi_medium/reviler.jpg'), thumb: require('../../roles_chibi_thumbs/reviler.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/reviler.jpg'), thumb: require('../../roles_16bit_thumbs/reviler.jpg') },
  },
  Cursed: {
    chibi: { image: require('../../roles_chibi_medium/cursed.jpg'), thumb: require('../../roles_chibi_thumbs/cursed.jpg') },
    '16bit': { image: require('../../roles_16bit_medium/cursed.jpg'), thumb: require('../../roles_16bit_thumbs/cursed.jpg') },
  },
};

export function getDisplayArt(roleName: string, theme: Theme): Art {
  if (!isV1Role(roleName)) {
    return LOCKED_ART[theme];
  }
  const override = V1_OVERRIDES[roleName]?.[theme];
  if (override) return override;
  // Fall through to ghibli (the canonical art on the Role itself).
  const role = ROLES.find(r => r.name === roleName);
  if (role) return { image: role.image, thumb: role.thumb };
  return LOCKED_ART[theme];
}
