import { customAlphabet } from "nanoid";

const makeId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 18);

export function newId(prefix: string): string {
  return `${prefix}_${makeId()}`;
}
