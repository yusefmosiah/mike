import type { Metadata, Viewport } from "next";
import { brand } from "@/app/lib/brand";
// Self-hosted Inter and EB Garamond; sets --font-inter and --font-eb-garamond.
import "./fonts/fonts.css";
import "./globals.css";
import { Providers } from "@/app/components/providers";

export const metadata: Metadata = {
    metadataBase: new URL("https://app.mikeoss.com"),
    title: brand.title,
    description: brand.description,
    icons: {
        icon: [
            { url: "/icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico" },
        ],
        apple: "/apple-touch-icon.png",
    },
    openGraph: {
        type: "website",
        url: "https://app.mikeoss.com",
        siteName: brand.name,
        title: brand.title,
        description: brand.description,
        images: [
            {
                url: "/link-image.jpg",
                width: 1200,
                height: 651,
                alt: brand.name,
            },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title: brand.title,
        description: brand.description,
        images: ["/link-image.jpg"],
    },
};

// `cover` lets the iPhone app's page run under the status bar and home
// indicator; layouts pad with env(safe-area-inset-*) where they must clear it.
export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                className="font-sans antialiased"
            >
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
