import { Avatar, Style } from "@dicebear/core";
import definition from "@dicebear/styles/cutouts.json" with { type: "json" };

const cutouts = new Style(definition);

export function profileAvatarUrl(seed: string) {
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
