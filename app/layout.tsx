import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('http://localhost:3000'),
  title: '圆衡 Enkei 1.0.0 Beta｜FX 量化研究与执行工作台',
  description: '圆衡 Enkei 1.0.0 Beta：本地优先的外汇研究、监控、Demo 演练与受控执行工作台。',
  openGraph: {
    title: '円衡 Enkei｜JPY FX Quant Desk',
    description: '面向日本外汇市场的中日双语量化研究与交易控制台。',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: '円衡 Enkei' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '円衡 Enkei｜JPY FX Quant Desk',
    description: '面向日本外汇市场的中日双语量化研究与交易控制台。',
    images: ['/og.png'],
  },
  icons: { icon: '/og.png' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
