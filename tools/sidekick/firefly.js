/*
  Sidekick plugin: Firefly image generation and replacement (MVP)
  - Shows a button in Sidekick on edit/preview/live and Google Docs
  - Prompts user for a prompt, calls backend APIs to generate image and replace in Google Doc
  - Backend endpoints to implement in Cloud Manager/App Builder (I/O Runtime):
      POST /api/firefly/generate -> { imageUrl }
      POST /api/google/replace-image -> { ok: true }
*/

export default function decorate(config, api) {
  api.add({
    id: 'firefly-generate',
    condition: () => true,
    button: {
      text: 'Firefly 生成',
      action: async () => {
        try {
          const prompt = window.prompt('生成したい画像のプロンプトを入力してください:');
          if (!prompt) return;

          // Call serverless function to generate the image via Firefly
          const genResp = await fetch('/api/firefly/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt })
          });
          if (!genResp.ok) {
            const t = await genResp.text();
            throw new Error(`generate failed: ${genResp.status} ${t}`);
          }
          const { imageUrl } = await genResp.json();
          if (!imageUrl) throw new Error('No imageUrl returned');

          // Replace in Google Doc (or page) via backend to avoid CORS/auth issues
          const replacePayload = {
            docUrl: window.location.href,
            target: await detectSelectedImageContext(),
            imageUrl,
          };
          const repResp = await fetch('/api/google/replace-image', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(replacePayload)
          });
          if (!repResp.ok) {
            const t = await repResp.text();
            throw new Error(`replace failed: ${repResp.status} ${t}`);
          }

          api.notify?.('画像を置き換えました。', 2000);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('Firefly plugin error', e);
          alert(`Firefly エラー: ${e.message}`);
        }
      },
    },
  });
}

async function detectSelectedImageContext() {
  // Google Docs のDOMは保護されているため、ここでは常にnullにフォールバック。
  // サーバ側で docUrl から対象画像を特定する実装を推奨。
  return null;
}


