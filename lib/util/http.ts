// Motivation vs Logic: returning a structured 405 response makes it clear that the
// agent routes are POST-only streams instead of letting Next's default 404 page show up
// when someone browses to them directly.
export function methodNotAllowedResponse(detail: string, allowed: string[]) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Allow: allowed.join(', '),
  });
  const body = JSON.stringify({ error: detail, allowed });
  return new Response(body, { status: 405, headers });
}
