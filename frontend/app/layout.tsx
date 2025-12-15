import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Screen Recorder',
  description: 'Record your screen and replay in the browser',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ 
        margin: 0, 
        fontFamily: 'system-ui, -apple-system, sans-serif',
        backgroundColor: '#fafafa',
      }}>
        {children}
      </body>
    </html>
  );
}