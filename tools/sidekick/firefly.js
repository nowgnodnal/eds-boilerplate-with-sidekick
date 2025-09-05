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

function createOverlay() {
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(0,0,0,0.35)';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '2147483647';

  const panel = document.createElement('div');
  panel.style.background = '#fff';
  panel.style.borderRadius = '8px';
  panel.style.boxShadow = '0 8px 24px rgba(0,0,0,0.2)';
  panel.style.padding = '16px';
  panel.style.minWidth = '360px';

  const title = document.createElement('div');
  title.textContent = 'Firefly: 画像生成プロンプト';
  title.style.fontWeight = '600';
  title.style.marginBottom = '8px';

  const input = document.createElement('textarea');
  input.rows = 3;
  input.placeholder = '例: 海辺の夕焼けで走る犬、やわらかい光';
  input.style.width = '100%';
  input.style.boxSizing = 'border-box';
  input.style.margin = '8px 0';

  const buttons = document.createElement('div');
  buttons.style.display = 'flex';
  buttons.style.gap = '8px';
  buttons.style.justifyContent = 'flex-end';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'キャンセル';

  const run = document.createElement('button');
  run.type = 'button';
  run.textContent = '生成する';
  run.style.background = '#1473e6';
  run.style.color = '#fff';
  run.style.border = 'none';
  run.style.padding = '6px 12px';
  run.style.borderRadius = '4px';

  buttons.append(cancel, run);
  panel.append(title, input, buttons);
  overlay.append(panel);

  return { overlay, input, cancel, run };
}

function promptForText() {
  return new Promise((resolve) => {
    const { overlay, input, cancel, run } = createOverlay();
    const close = (value) => {
      document.body.removeChild(overlay);
      resolve(value);
    };
    cancel.addEventListener('click', () => close(null));
    run.addEventListener('click', () => close(input.value.trim() || null));
    overlay.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') close(null);
    });
    document.body.appendChild(overlay);
    input.focus();
  });
}

export default function decorate(config, api) {
  api.add({
    id: 'firefly-generate',
    condition: () => true,
    button: {
      text: 'Firefly 生成',
      action: async () => {
        try {
          const target = await detectSelectedImageContext();
          if (!isGoogleDocs() && !target) {
            api.notify?.('まず置き換えたい画像をクリックしてください。', 3000);
            return;
          }

          const prompt = await promptForText();
          if (!prompt) return;

          // Call serverless function to generate the image via Firefly
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
            // Replace in Google Doc via backend to avoid CORS/auth issues
            const replacePayload = {
              docUrl: window.location.href,
              target: null,
              imageUrl,
            };
            const repResp = await fetch('/api/google/replace-image', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(replacePayload),
            });
            if (!repResp.ok) {
              const t = await repResp.text();
              throw new Error(`replace failed: ${repResp.status} ${t}`);
            }
            api.notify?.('画像を置き換えました。', 2000);
            return;
          }

          // Replace on the current page by swapping IMG src
          if (target && target.tagName === 'IMG') {
            const cacheBusted = `${imageUrl}${imageUrl.includes('?') ? '&' : '?'}v=${Date.now()}`;
            target.src = cacheBusted;
            target.srcset = '';
            api.notify?.('画像を置き換えました。', 2000);
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('Firefly plugin error', e);
          alert(`Firefly エラー: ${e.message}`); // eslint-disable-line no-alert
        }
      },
    },
  });
}
