import { buildCorsHeaders, handleOptions } from '../_shared/cors.js';

const TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const GENERATE_URL = 'https://firefly-api.adobe.io/v3/images/generate';

async function getAccessToken() {
  const clientId = process.env.FIREFLY_CLIENT_ID;
  const clientSecret = process.env.FIREFLY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing FIREFLY_CLIENT_ID or FIREFLY_CLIENT_SECRET');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`IMS token error ${res.status}: ${t}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function generateImage(prompt, size) {
  const accessToken = await getAccessToken();
  const clientId = process.env.FIREFLY_CLIENT_ID;
  const reqBody = {
    prompt,
    size: size || { width: 1024, height: 1024 },
  };

  const res = await fetch(GENERATE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      'x-api-key': clientId,
      accept: 'application/json',
    },
    body: JSON.stringify(reqBody),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Firefly error ${res.status}: ${t}`);
  }
  const data = await res.json();

  // Try to extract an URL if provided by API
  let imageUrl = null;
  try {
    if (data?.outputs?.[0]?.image?.url) imageUrl = data.outputs[0].image.url;
  } catch (e) {
    // ignore
  }

  return { data, imageUrl };
}

export default async function main(request) {
  const origin = request?.headers?.origin || request?.headers?.Origin;
  const cors = buildCorsHeaders(origin);

  if (request?.method === 'OPTIONS') return handleOptions(request);

  try {
    const body = typeof request?.body === 'string' ? JSON.parse(request.body || '{}') : (request?.body || {});
    const prompt = body?.prompt;
    const size = body?.size;
    if (!prompt) {
      return { statusCode: 400, headers: cors, body: 'Missing prompt' };
    }

    const { data, imageUrl } = await generateImage(prompt, size);

    return {
      statusCode: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify({ imageUrl, raw: data }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: cors,
      body: String(e?.message || e),
    };
  }
}
