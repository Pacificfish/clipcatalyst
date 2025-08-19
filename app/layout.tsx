import './globals.css';

export const metadata = {
  title: 'ClipCatalyst',
  description: 'Turn ideas into viral shorts in minutes.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

