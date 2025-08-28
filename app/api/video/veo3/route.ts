export const dynamic = 'force-static';

export function GET() {
  return new Response('Not found', { status: 404 });
}

export async function POST() {
  return new Response('Not found', { status: 404 });
}
