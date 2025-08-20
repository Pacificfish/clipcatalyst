import { redirect } from 'next/navigation'

export default function Home() {
  // Ensure root URL always resolves to the app entry. This prevents any accidental 404s on Vercel.
  redirect('/lab')
}
