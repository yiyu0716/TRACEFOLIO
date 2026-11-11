// Modified for TRACEFOLIO (2026): product identity and system font fallback.
import type { Metadata } from "next";
import "./globals.css";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";

export const metadata: Metadata = {
  title: "TRACEFOLIO · 有据可循的职业成长",
  description: "面向程序员与 AI 技术人才的职业记忆、能力证据和求职成长工作台",
  icons: {
    icon: "/brand/tracefolio-mark.svg",
    shortcut: "/brand/tracefolio-mark.svg",
    apple: "/brand/tracefolio-mark.svg",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();

  return (
    <html lang={locale} className="font-sans">
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
