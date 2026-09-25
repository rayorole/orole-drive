import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Orole Drive",
    short_name: "Orole Drive",
    description: "A private place for the Orole family's files.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0066cc",
    orientation: "any",
    categories: ["productivity", "utilities"],
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
