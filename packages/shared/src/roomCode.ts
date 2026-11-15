/** Letters only, without I and O so codes survive being read aloud or typed from a TV. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 5;

export function generateRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length) % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

/** Uppercases and strips anything that is not a letter, so "ab-cde " becomes "ABCDE". */
export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function isRoomCode(input: string): boolean {
  if (input.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of input) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}
