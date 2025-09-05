import { buildCorsHeaders, handleOptions } from '../_shared/cors.js';

/*
  Replaces placeholder text (e.g., {{images}}) in a Google Doc with an inline image by URL.
  Also supports Google Sheets: finds cells containing the placeholder and replaces with =IMAGE(url) formula or sets cell with image (basic).
  Auth model: Service Account with Domain-Wide Delegation recommended.

  Required env vars:
    - GOOGLE_SA_EMAIL: service account email
    - GOOGLE_SA_PRIVATE_KEY: service account private key (\n preserved)
    - GOOGLE_DELEGATED_USER: user email to impersonate (if DWD)
*/

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

function nowEpochSecs() { return Math.floor(Date.now() / 1000); }

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function signJwt(header, claimSet, privateKeyPem) {
  const crypto = await import('node:crypto');
  const encHeader = base64url(JSON.stringify(header));
  const encClaim = base64url(JSON.stringify(claimSet));
  const unsigned = `${encHeader}.${encClaim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(privateKeyPem, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${unsigned}.${signature}`;
}

async function getGoogleAccessToken(scopes) {
  const saEmail = process.env.GOOGLE_SA_EMAIL;
  let saKey = process.env.GOOGLE_SA_PRIVATE_KEY;
  const delegatedUser = process.env.GOOGLE_DELEGATED_USER;
  if (!saEmail || !saKey) throw new Error('Missing GOOGLE_SA_EMAIL or GOOGLE_SA_PRIVATE_KEY');
  saKey = saKey.replace(/\\n/g, '\n');

  const iat = nowEpochSecs();
  const exp = iat + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: saEmail,
    sub: delegatedUser || saEmail,
    scope: Array.isArray(scopes) ? scopes.join(' ') : scopes,
    aud: GOOGLE_TOKEN_URL,
    exp,
    iat,
  };
  const jwt = signJwt(header, claim, saKey);
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Google token error ${res.status}: ${t}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function batchUpdateDoc(accessToken, documentId, requests) {
  const url = `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Docs batchUpdate error ${res.status}: ${t}`);
  }
  return res.json();
}

function extractDocumentIdFromUrl(docUrl) {
  const m = /https:\/\/docs\.google\.com\/document\/d\/([^/]+)/.exec(docUrl || '');
  return m ? m[1] : null;
}

export async function main(request) {
  const origin = request?.headers?.origin || request?.headers?.Origin;
  const cors = buildCorsHeaders(origin);
  if (request?.method === 'OPTIONS') return handleOptions(request);

  try {
    const body = typeof request?.body === 'string' ? JSON.parse(request.body || '{}') : (request?.body || {});
    const { docUrl, imageUrl, placeholder = '{{images}}', widthPt = 200, heightPt = 200 } = body;
    if (!docUrl || !imageUrl) return { statusCode: 400, headers: cors, body: 'Missing docUrl or imageUrl' };

    // Detect Docs or Sheets by URL
    const isDocs = /https:\/\/docs\.google\.com\/document\/d\//.test(docUrl);
    const isSheets = /https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(docUrl);

    if (!isDocs && !isSheets) return { statusCode: 400, headers: cors, body: 'Unsupported Google URL' };

    const documentId = isDocs
      ? (extractDocumentIdFromUrl(docUrl) || body.documentId)
      : (/(?:\/spreadsheets\/d\/)([^/]+)/.exec(docUrl)?.[1] || body.documentId);
    if (!documentId) return { statusCode: 400, headers: cors, body: 'Missing documentId' };

    const accessToken = await getGoogleAccessToken([
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
    ]);

    if (isDocs) {
      // DOCS: find placeholder ranges, delete and insert image at those positions
      const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!docRes.ok) {
        const t = await docRes.text();
        throw new Error(`Docs get error ${docRes.status}: ${t}`);
      }
      const doc = await docRes.json();
      const content = doc?.body?.content || [];
      const occurrences = [];
      for (const block of content) {
        const paragraph = block?.paragraph;
        if (!paragraph) continue;
        for (const el of (paragraph.elements || [])) {
          const tr = el.textRun;
          if (!tr) continue;
          const text = tr.content || '';
          const startIndex = el.startIndex;
          if (typeof startIndex !== 'number') continue;
          let from = 0;
          while (true) {
            const pos = text.indexOf(placeholder, from);
            if (pos === -1) break;
            const absStart = startIndex + pos;
            const absEnd = absStart + placeholder.length;
            occurrences.push([absStart, absEnd]);
            from = pos + placeholder.length;
          }
        }
      }

      if (occurrences.length === 0) {
        // Fallback: replace the first inline image in the document
        let firstImageRange = null;
        for (const block of content) {
          const paragraph = block?.paragraph;
          if (!paragraph) continue;
          for (const el of (paragraph.elements || [])) {
            const inlineObj = el.inlineObjectElement;
            if (inlineObj && typeof el.startIndex === 'number' && typeof el.endIndex === 'number') {
              firstImageRange = [el.startIndex, el.endIndex];
              break;
            }
          }
          if (firstImageRange) break;
        }

        if (!firstImageRange) {
          return { statusCode: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ replaced: 0 }) };
        }

        const [s, e] = firstImageRange;
        const requests = [
          { deleteContentRange: { range: { startIndex: s, endIndex: e } } },
          {
            insertInlineImage: {
              location: { index: s },
              uri: imageUrl,
              objectSize: {
                width: { magnitude: Number(widthPt), unit: 'PT' },
                height: { magnitude: Number(heightPt), unit: 'PT' },
              },
            },
          },
        ];

        await batchUpdateDoc(accessToken, documentId, requests);

        return { statusCode: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ replaced: 1, type: 'docs', mode: 'first-image' }) };
      }

      occurrences.sort((a, b) => b[0] - a[0]);
      const requests = [];
      for (const [absStart, absEnd] of occurrences) {
        requests.push({ deleteContentRange: { range: { startIndex: absStart, endIndex: absEnd } } });
        requests.push({
          insertInlineImage: {
            location: { index: absStart },
            uri: imageUrl,
            objectSize: {
              width: { magnitude: Number(widthPt), unit: 'PT' },
              height: { magnitude: Number(heightPt), unit: 'PT' },
            },
          },
        });
      }

      await batchUpdateDoc(accessToken, documentId, requests);

      return { statusCode: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ replaced: occurrences.length, type: 'docs' }) };
    }

    // SHEETS: find all cells matching placeholder and replace with =IMAGE(url)
    // 1) get values for all sheets
    const metaRes = await fetch(`${SHEETS_API}/${documentId}`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!metaRes.ok) {
      const t = await metaRes.text();
      throw new Error(`Sheets get error ${metaRes.status}: ${t}`);
    }
    const meta = await metaRes.json();
    const sheetTitles = (meta.sheets || []).map((s) => s.properties?.title).filter(Boolean);

    const getRes = await fetch(`${SHEETS_API}/${documentId}/values:batchGet?${new URLSearchParams({ ranges: sheetTitles.map((t) => `${encodeURIComponent(t)}!A:Z`).join('&ranges='), majorDimension: 'ROWS' })}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!getRes.ok) {
      const t = await getRes.text();
      throw new Error(`Sheets values error ${getRes.status}: ${t}`);
    }
    const valuesData = await getRes.json();

    // Build batch update
    const data = [];
    valuesData.valueRanges?.forEach((vr) => {
      const range = vr.range; // e.g., 'Sheet1!A1:Z1000'
      const [sheet] = range.split('!');
      const rows = vr.values || [];
      let changed = false;
      rows.forEach((row, r) => {
        row.forEach((cell, c) => {
          if (typeof cell === 'string' && cell.includes(placeholder)) {
            // Replace the entire cell with =IMAGE("url")
            row[c] = `=IMAGE("${imageUrl}")`;
            changed = true;
          }
        });
      });
      if (changed) {
        data.push({ range: `${sheet}!A1`, majorDimension: 'ROWS', values: rows });
      }
    });

    if (data.length === 0) {
      return { statusCode: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ replaced: 0, type: 'sheets' }) };
    }

    const updateRes = await fetch(`${SHEETS_API}/${documentId}/values:batchUpdate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    });
    if (!updateRes.ok) {
      const t = await updateRes.text();
      throw new Error(`Sheets batchUpdate error ${updateRes.status}: ${t}`);
    }

    return { statusCode: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ replaced: true, type: 'sheets' }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: String(e?.message || e) };
  }
}


