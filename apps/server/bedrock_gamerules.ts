import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import type { GameruleValue } from "./gamerules.js";

export interface BedrockGameruleDef {
  name: string;
  type: "boolean" | "integer";
  default: boolean | number;
  min?: number;
  max?: number;
  description: string;
}

export const BEDROCK_GAMERULE_DEFS: readonly BedrockGameruleDef[] = [
  { name: "keepinventory", type: "boolean", default: false, description: "Keep inventory after dying" },
  { name: "showcoordinates", type: "boolean", default: false, description: "Show player coordinates on screen" },
  { name: "dodaylightcycle", type: "boolean", default: true, description: "Advance the day/night cycle" },
  { name: "doweathercycle", type: "boolean", default: true, description: "Advance the weather cycle" },
  { name: "pvp", type: "boolean", default: true, description: "Allow player vs player combat" },
  { name: "mobgriefing", type: "boolean", default: true, description: "Mobs can destroy or change blocks" },
  { name: "naturalregeneration", type: "boolean", default: true, description: "Players regenerate health naturally" },
  { name: "doimmediaterespawn", type: "boolean", default: false, description: "Respawn instantly without death screen" },
  { name: "domobspawning", type: "boolean", default: true, description: "Allow natural mob spawning" },
  { name: "domobloot", type: "boolean", default: true, description: "Mobs drop items on death" },
  { name: "doentitydrops", type: "boolean", default: true, description: "Entities drop items on death" },
  { name: "dotiledrops", type: "boolean", default: true, description: "Blocks drop items when mined" },
  { name: "dofiretick", type: "boolean", default: true, description: "Fire spreads and burns out" },
  { name: "falldamage", type: "boolean", default: true, description: "Players take damage from falling" },
  { name: "firedamage", type: "boolean", default: true, description: "Players take damage from fire" },
  { name: "drowningdamage", type: "boolean", default: true, description: "Players take damage from drowning" },
  { name: "freezedamage", type: "boolean", default: true, description: "Players take damage from powder snow freezing" },
  { name: "doinsomnia", type: "boolean", default: true, description: "Phantoms spawn when players skip sleep" },
  { name: "commandblockoutput", type: "boolean", default: true, description: "Broadcast command block output to chat" },
  { name: "sendcommandfeedback", type: "boolean", default: true, description: "Send feedback messages for commands" },
  { name: "showdeathmessages", type: "boolean", default: true, description: "Broadcast death messages in chat" },
  { name: "showtags", type: "boolean", default: true, description: "Show item tags in UI" },
  { name: "tntexplodes", type: "boolean", default: true, description: "TNT blocks can explode" },
  { name: "respawnblocksexplode", type: "boolean", default: true, description: "Beds and respawn anchors explode in other dimensions" },
  { name: "randomtickspeed", type: "integer", default: 1, min: 0, max: 4096, description: "Random block tick speed (default: 1)" },
  { name: "spawnradius", type: "integer", default: 10, min: 0, max: 100000, description: "Radius of spawn protection area (default: 10)" },
  { name: "maxcommandchainlength", type: "integer", default: 65536, min: 0, max: 2147483647, description: "Max command chain length (default: 65536)" },
  { name: "functioncommandlimit", type: "integer", default: 10000, min: 1, max: 2147483647, description: "Max function executions limit (default: 10000)" },
];

export const BEDROCK_GAMERULE_BY_NAME = new Map<string, BedrockGameruleDef>(
  BEDROCK_GAMERULE_DEFS.map((def) => [def.name.toLowerCase(), def])
);

/** Reads a single Bedrock gamerule value from buffer. */
export function findBedrockRuleValue(
  buf: Buffer,
  def: BedrockGameruleDef
): { value: boolean | number; offset: number } | null {
  const target = Buffer.from(def.name, "latin1");
  let idx = 0;
  while ((idx = buf.indexOf(target, idx)) !== -1) {
    if (idx >= 3) {
      const tagType = buf[idx - 3];
      const len = buf.readUInt16LE(idx - 2);
      if (len === def.name.length) {
        const valOffset = idx + def.name.length;
        if (def.type === "boolean" && tagType === 1 && valOffset < buf.length) {
          return { value: buf[valOffset] === 1, offset: valOffset };
        }
        if (def.type === "integer" && tagType === 3 && valOffset + 4 <= buf.length) {
          return { value: buf.readInt32LE(valOffset), offset: valOffset };
        }
      }
    }
    idx += target.length;
  }
  return null;
}

/** Reads all gamerules from Bedrock level.dat, falling back to defaults for missing rules. */
export function readBedrockGamerules(levelDatPath: string): GameruleValue[] {
  let buf: Buffer | null = null;
  try {
    if (existsSync(levelDatPath)) {
      buf = readFileSync(levelDatPath);
    }
  } catch {
    buf = null;
  }

  return BEDROCK_GAMERULE_DEFS.map((def) => {
    if (buf) {
      const found = findBedrockRuleValue(buf, def);
      if (found !== null) {
        return {
          name: def.name,
          type: def.type,
          value: found.value,
          source: "file",
          description: def.description,
        };
      }
    }
    return {
      name: def.name,
      type: def.type,
      value: def.default,
      source: "default",
      description: def.description,
    };
  });
}

/**
 * Patches Bedrock gamerules in level.dat atomically.
 * Updates in-place if tag exists, or appends before final TAG_End if missing.
 */
export function patchBedrockGamerules(
  levelDatPath: string,
  writes: Record<string, boolean | number>
): string[] {
  if (!existsSync(levelDatPath)) {
    throw new Error(`Bedrock level.dat not found at ${levelDatPath}`);
  }

  let buf = readFileSync(levelDatPath);
  const changed: string[] = [];

  for (const [rawName, rawVal] of Object.entries(writes)) {
    const def = BEDROCK_GAMERULE_BY_NAME.get(rawName.toLowerCase());
    if (!def) continue;

    const found = findBedrockRuleValue(buf, def);
    if (found !== null) {
      if (def.type === "boolean") {
        const nextByte = rawVal ? 1 : 0;
        if (buf[found.offset] !== nextByte) {
          buf[found.offset] = nextByte;
          changed.push(def.name);
        }
      } else {
        const nextInt = Number(rawVal);
        if (Number.isFinite(nextInt) && buf.readInt32LE(found.offset) !== nextInt) {
          buf.writeInt32LE(nextInt, found.offset);
          changed.push(def.name);
        }
      }
    } else {
      // Append tag before final TAG_End (0x00)
      const lastEnd = buf.lastIndexOf(0x00);
      if (lastEnd !== -1) {
        const tagBytes: number[] = [];
        if (def.type === "boolean") {
          tagBytes.push(1); // TagId Byte
          tagBytes.push(def.name.length & 0xff, (def.name.length >> 8) & 0xff);
          for (let i = 0; i < def.name.length; i++) tagBytes.push(def.name.charCodeAt(i));
          tagBytes.push(rawVal ? 1 : 0);
        } else {
          tagBytes.push(3); // TagId Int
          tagBytes.push(def.name.length & 0xff, (def.name.length >> 8) & 0xff);
          for (let i = 0; i < def.name.length; i++) tagBytes.push(def.name.charCodeAt(i));
          const num = Number(rawVal);
          tagBytes.push(num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, (num >> 24) & 0xff);
        }
        const insertBuf = Buffer.from(tagBytes);
        buf = Buffer.concat([buf.subarray(0, lastEnd), insertBuf, buf.subarray(lastEnd)]);
        if (buf.length >= 8) {
          const oldLen = buf.readUInt32LE(4);
          buf.writeUInt32LE(oldLen + insertBuf.length, 4);
        }
        changed.push(def.name);
      }
    }
  }

  const tmp = `${levelDatPath}.tmp-${process.pid.toString(36)}`;
  writeFileSync(tmp, buf);
  renameSync(tmp, levelDatPath);
  return changed;
}
