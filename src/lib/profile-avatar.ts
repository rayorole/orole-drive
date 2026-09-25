import { Avatar, Style } from "@dicebear/core";
import definition from "@dicebear/styles/cutouts.json" with { type: "json" };

const cutouts = new Style(definition);

/** Seeded by email (stable across name changes), so one person gets the same avatar everywhere. */
export function profileAvatarUrl(person: { email?: string | null; name?: string | null }) {
  const seed = person.email?.trim().toLowerCase() || person.name?.trim() || "";
  const avatar = new Avatar(cutouts, {
    backgroundColor: ["e6ecef"],
    paperFaceColor: ["9ec9e8"],
    paperBackColor: ["37718e"],
    paperHairColor: ["1d3d52"],
    paperMouthColor: ["37718e"],
    cheeksProbability: 0,
    seed,
  });
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(avatar.toString())}`;
}
