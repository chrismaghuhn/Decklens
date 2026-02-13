import type { Metadata } from "next";
import { Providers } from "@/components/providers/providers";
import { Toaster } from "sonner";
import { SiteHeader, MobileNav } from "@/components/layout/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "MTG Deckbuilder",
  description: "Advanced Magic: The Gathering Deckbuilder",
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans antialiased flex flex-col">
        <Providers>
          <SiteHeader />
          <div className="flex-1 pb-16 md:pb-0">
            {children}
          </div>
          <MobileNav />
        </Providers>
        <Toaster />
      </body>
    </html>
  );
}
