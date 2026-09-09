import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Exportador de comentarios de Instagram",
  description: "Pega URLs de reels/videos de Instagram y exporta sus comentarios a CSV.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
