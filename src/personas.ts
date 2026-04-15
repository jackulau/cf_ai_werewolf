import type { Persona } from "./types";
import { seededShuffle } from "./rules";

export const PERSONAS: readonly Persona[] = [
  {
    id: "wren",
    name: "Wren the Baker",
    bio: "A flour-dusted village baker who notices everything that comes through her shop door.",
  },
  {
    id: "morgan",
    name: "Morgan the Fisher",
    bio: "A weathered fisher who reads people the way she reads the tides — slowly and surely.",
  },
  {
    id: "tobias",
    name: "Tobias the Smith",
    bio: "A blunt blacksmith with calloused hands and a low tolerance for nonsense.",
  },
  {
    id: "elspeth",
    name: "Elspeth the Innkeeper",
    bio: "An innkeeper who hears everything by pretending to hear nothing.",
  },
  {
    id: "rorik",
    name: "Rorik the Hunter",
    bio: "A quiet hunter who tracks tracks. Patient. Suspicious of newcomers.",
  },
  {
    id: "isolde",
    name: "Isolde the Herbalist",
    bio: "A young herbalist who reads omens in tea leaves and trusts her gut.",
  },
  {
    id: "callum",
    name: "Callum the Miller",
    bio: "A mill-owner who measures everything twice — words included.",
  },
  {
    id: "branwen",
    name: "Branwen the Weaver",
    bio: "A loom-tender who sees patterns where others see noise.",
  },
] as const;

export function pickPersonas(seed: string, count: number): Persona[] {
  if (count > PERSONAS.length) {
    throw new Error(
      `pickPersonas: requested ${count} but only ${PERSONAS.length} personas exist`,
    );
  }
  const shuffled = seededShuffle([...PERSONAS], seed);
  return shuffled.slice(0, count);
}
