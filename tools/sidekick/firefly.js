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

function getDocsBubbleRect() {
  try {
    const el = document.querySelector(
      '.docs-bubble.kix-embedded-entity-bubble',
    );
    if (!el) return null;
    return el.getBoundingClientRect();
  } catch (e) {
    return null;
  }
}

function findNearestImageIndex(point) {
  try {
    const imgs = Array.from(document.querySelectorAll('img'));
    if (imgs.length === 0) return null;
    let bestIdx = null;
    let bestDist = Number.POSITIVE_INFINITY;
    imgs.forEach((img, i) => {
      const r = img.getBoundingClientRect();
      const cx = r.left + (r.width / 2);
      const cy = r.top + (r.height / 2);
      const dx = cx - point.x;
      const dy = cy - point.y;
      const d2 = (dx * dx) + (dy * dy);
      if (d2 < bestDist) {
        bestDist = d2;
        bestIdx = i;
      }
    });
    return bestIdx;
  } catch (e) {
    return null;
  }
}

async function detectSelectedImageContext() {
  // Google Docs のDOMは保護されているため、ここでは常にnullにフォールバック。
  // 可能であればクリックされた IMG を利用（Docs でも DOM に IMG が存在するケースあり）。
  if (isGoogleDocs()) return lastClickedImageEl || null;
  return lastClickedImageEl || document.querySelector('img');
}

export default function decorate(config, api) {
  // このJSは palette 上の firefly.html から利用されるヘルパーとして保持
  api.firefly = {
    isGoogleDocs,
    detectSelectedImageContext,
    async generateAndReplace(prompt) {
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
        let targetIndex = null;
        if (target) {
          try {
            const imgs = Array.from(document.querySelectorAll('img'));
            const idx = imgs.indexOf(target);
            if (idx >= 0) targetIndex = idx;
          } catch (e) {
            // ignore
          }
        }
        if (targetIndex == null) {
          const bubble = getDocsBubbleRect();
          if (bubble) {
            const idx2 = findNearestImageIndex({ x: bubble.left, y: bubble.top });
            if (typeof idx2 === 'number' && idx2 >= 0) targetIndex = idx2;
          }
        }
        const repResp = await fetch('/api/google/replace-image', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ docUrl: window.location.href, targetIndex, imageUrl }),
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
