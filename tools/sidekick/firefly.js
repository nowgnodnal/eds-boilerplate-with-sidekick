/*
  Sidekick plugin: Firefly image generation and replacement (MVP)
  - Shows a button in Sidekick on edit/preview/live and Google Docs
  - Textbox UI to enter a prompt, then generates and replaces the selected image
  - Backend endpoints to implement in Cloud Manager/App Builder (I/O Runtime):
      POST /api/firefly/generate -> { imageUrl }
      POST /api/google/replace-image -> { ok: true }
*/

let lastClickedImageEl = null;
document.addEventListener('mousedown', (ev) => {
  const path = ev.composedPath ? ev.composedPath() : [];
  const img = path.find((el) => el && el.tagName === 'IMG');
  if (img) lastClickedImageEl = img;
});

function isGoogleDocs() {
  return /https:\/\/docs\.google\.com\//.test(window.location.href);
}

async function detectSelectedImageContext() {
  // Google Docs のDOMは保護されているため、ここでは常にnullにフォールバック。
  // サーバ側で docUrl から対象画像を特定する実装を推奨。
  if (isGoogleDocs()) return null;
  return lastClickedImageEl || document.querySelector('img');
}

export default function decorate(config, api) {
  // このJSは palette 上の firefly.html から利用されるヘルパーとして保持
  api.firefly = {
    isGoogleDocs,
    detectSelectedImageContext,
    async generateAndReplace(prompt, options = {}) {
      const target = await detectSelectedImageContext();
      const genResp = await fetch('/api/firefly/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (!genResp.ok) {
        const t = await genResp.text();
        throw new Error(`generate failed: ${genResp.status} ${t}`);
      }
      const { imageUrl } = await genResp.json();
      if (!imageUrl) throw new Error('No imageUrl returned');

      if (isGoogleDocs()) {
        const repResp = await fetch('/api/google/replace-image', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ docUrl: window.location.href, target: null, imageUrl, range: options.range || null }),
        });
        if (!repResp.ok) {
          const t = await repResp.text();
          throw new Error(`replace failed: ${repResp.status} ${t}`);
        }
        return { replaced: true, imageUrl };
      }

      if (target && target.tagName === 'IMG') {
        const cacheBusted = `${imageUrl}${imageUrl.includes('?') ? '&' : '?'}v=${Date.now()}`;
        target.src = cacheBusted;
        target.srcset = '';
        return { replaced: true, imageUrl };
      }
      return { replaced: false, imageUrl };
    },
  };
}
