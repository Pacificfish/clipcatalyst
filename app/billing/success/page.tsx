'use client';

import Link from 'next/link';
import Nav from '@/components/Nav';

export default function BillingSuccessPage() {
  return (
    <>
      <Nav />
      <main className="container py-16 space-y-6">
        <h1 className="text-3xl font-bold">Billing updated</h1>
        <p className="text-white/70">Your subscription changes have been saved. You can return to the app now.</p>
        <div className="flex gap-2">
          <Link className="btn-primary" href="/lab">Go to Lab</Link>
          <Link className="btn" href="/profile">View Profile</Link>
        </div>
      </main>
    </>>
  );
}