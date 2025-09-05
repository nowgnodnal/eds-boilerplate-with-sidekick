export function buildCorsHeaders(origin) {
  const allowedOrigins = [
    'http://localhost:3000',
    'https://docs.google.com',
    'https://docs.googleusercontent.com',
  ];

  // allow *.aem.page and *.aem.live
  const allowWildcard = (o) => (
    /https:\/\/[^.]+--[^.]+--[^.]+\.aem\.page/.test(o)
    || /https:\/\/[^.]+--[^.]+--[^.]+\.aem\.live/.test(o)
  );

  const isAllowed = origin && (allowedOrigins.includes(origin) || allowWildcard(origin));
  const headers = {
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-api-key',
    'access-control-max-age': '86400',
  };
  if (isAllowed) headers['access-control-allow-origin'] = origin;
  return headers;
}

export function handleOptions(request) {
  const origin = request?.headers?.origin || request?.headers?.Origin;
  const headers = buildCorsHeaders(origin);
  return {
    statusCode: 204,
    headers,
  };
}
