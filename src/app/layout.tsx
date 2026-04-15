import type { Metadata } from 'next'
import { Heebo, DM_Mono } from 'next/font/google'
import Nav from '@/components/Nav'
import './globals.css'

const heebo = Heebo({
  variable: '--font-display',
  subsets: ['latin'],
  weight: ['300', '400', '500', '700', '800'],
  display: 'swap',
})

const dmMono = DM_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Co.Media — AI Food Video Studio',
  description: 'Transform your food photos into cinematic videos with AI.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${heebo.variable} ${dmMono.variable} h-full`}>
      <body className="min-h-full">
        <Nav />
        {children}
      </body>
    </html>
  )
}
