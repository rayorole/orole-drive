import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import "@fontsource-variable/inter";
import "./globals.css";


export const metadata: Metadata = {
  title: { default: "Orole Drive", template: "%s · Orole Drive" },
  description: "A shared place for the Orole family’s files.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
      suppressHydrationWarning
    >
      <body className="min-h-full">
        <div className="root isolate"><Providers>{children}</Providers></div>
      </body>
    </html>
  );
}
