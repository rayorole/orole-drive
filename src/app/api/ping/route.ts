// Reachability check for the offline banner: an empty, uncached reply that only proves the server answered.
export async function HEAD(request: Request) {
  void request;
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
