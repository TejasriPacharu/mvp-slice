// Main page - Server Component that renders the client-side ScreenRecorder
// The actual recording logic is in the client component since it needs browser APIs

import ScreenRecorder from './components/ScreenRecorder';

export default function Home() {
  return (
    <main>
      <ScreenRecorder />
    </main>
  );
}