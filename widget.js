/**
 * Almari Try-On Widget — drop-in embed for a retailer's product pages.
 *
 * Usage: one script tag, then mark any "Try It On" button with data
 * attributes describing the item, and init the widget with your API key.
 *
 *   <script src="https://.../widget.js"></script>
 *   <script>
 *     AlmariTryOn.init({ apiKey: "atk_...", baseUrl: "https://<project>.supabase.co/functions/v1" });
 *   </script>
 *
 *   <button
 *     data-almari-tryon
 *     data-image-url="https://yourstore.com/products/jacket.jpg"
 *     data-category="jacket"
 *     data-description="black leather biker jacket">
 *     Try It On
 *   </button>
 *
 * No backend work required on the retailer's side beyond pasting this
 * snippet — the widget handles the shopper's photo capture (once, reused
 * via localStorage), the create-avatar / tryon calls, and renders the
 * result in a modal it injects itself.
 *
 * NOTE — this demo build calls the API directly from the browser with a
 * plaintext API key embedded in the page, which is fine for a sales demo
 * but not for production: anyone can read the key out of page source and
 * run up usage on the retailer's account. A production version should use
 * either a domain-restricted "publishable" key (server checks the
 * Origin/Referer header against a per-retailer allowlist) or route calls
 * through a thin proxy on the retailer's own backend.
 */
(function (window, document) {
  "use strict";

  const STYLE = `
    .atw-overlay { position: fixed; inset: 0; background: rgba(10,10,10,0.55); z-index: 999999;
      display: flex; align-items: center; justify-content: center; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .atw-modal { background: #fff; border-radius: 16px; width: 100%; max-width: 420px; max-height: 90vh;
      overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); position: relative; }
    .atw-modal-inner { padding: 24px; }
    .atw-close { position: absolute; top: 14px; right: 14px; width: 32px; height: 32px; border-radius: 50%;
      border: none; background: #F5F5F5; color: #0A0A0A; font-size: 18px; cursor: pointer; line-height: 1; }
    .atw-title { font-size: 18px; font-weight: 700; color: #0A0A0A; margin: 0 0 6px; }
    .atw-subtitle { font-size: 13px; color: #888; margin: 0 0 20px; }
    .atw-dropzone { border: 2px dashed #DDD; border-radius: 12px; padding: 28px 16px; text-align: center;
      cursor: pointer; color: #888; font-size: 14px; }
    .atw-dropzone:hover { border-color: #0A0A0A; color: #0A0A0A; }
    .atw-btn { display: block; width: 100%; height: 48px; border-radius: 12px; border: none; background: #0A0A0A;
      color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 16px; }
    .atw-btn:disabled { opacity: 0.5; cursor: default; }
    .atw-result-img { width: 100%; border-radius: 12px; display: block; }
    .atw-status { text-align: center; padding: 40px 0; color: #888; font-size: 14px; }
    .atw-spinner { width: 32px; height: 32px; margin: 0 auto 14px; border: 3px solid #EEE; border-top-color: #0A0A0A;
      border-radius: 50%; animation: atw-spin 0.8s linear infinite; }
    @keyframes atw-spin { to { transform: rotate(360deg); } }
    .atw-error { color: #B03020; font-size: 13px; margin-top: 10px; }
    .atw-secondary { display: block; width: 100%; text-align: center; margin-top: 10px; background: none; border: none;
      color: #888; font-size: 13px; cursor: pointer; text-decoration: underline; }
  `;

  let config = { apiKey: null, baseUrl: null, gender: "male" };
  let styleInjected = false;

  function injectStyle() {
    if (styleInjected) return;
    const s = document.createElement("style");
    s.textContent = STYLE;
    document.head.appendChild(s);
    styleInjected = true;
  }

  function getExternalUserId() {
    let id = localStorage.getItem("almari_external_user_id");
    if (!id) {
      id = "guest-" + crypto.randomUUID();
      localStorage.setItem("almari_external_user_id", id);
    }
    return id;
  }

  function getStoredAvatar() {
    const id = localStorage.getItem("almari_avatar_id");
    const url = localStorage.getItem("almari_avatar_url");
    return id && url ? { avatar_id: id, avatar_url: url } : null;
  }

  function storeAvatar(avatar_id, avatar_url) {
    localStorage.setItem("almari_avatar_id", avatar_id);
    localStorage.setItem("almari_avatar_url", avatar_url);
  }

  async function apiCall(path, body) {
    const res = await fetch(config.baseUrl + "/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": config.apiKey },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function buildModal() {
    const overlay = document.createElement("div");
    overlay.className = "atw-overlay";
    const modal = document.createElement("div");
    modal.className = "atw-modal";
    modal.innerHTML = `
      <button class="atw-close" aria-label="Close">&times;</button>
      <div class="atw-modal-inner"></div>
    `;
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    modal.querySelector(".atw-close").addEventListener("click", close);
    document.body.appendChild(overlay);

    function close() { overlay.remove(); }
    return { overlay, inner: modal.querySelector(".atw-modal-inner"), close };
  }

  function renderUpload(inner, onPhoto) {
    inner.innerHTML = `
      <p class="atw-title">See it on you</p>
      <p class="atw-subtitle">Upload a clear front-facing photo — we'll build a reusable avatar so you only do this once.</p>
      <label class="atw-dropzone">
        <input type="file" accept="image/*" style="display:none" />
        Tap to choose a photo
      </label>
      <div class="atw-error" style="display:none"></div>
    `;
    const input = inner.querySelector("input");
    const errorEl = inner.querySelector(".atw-error");
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        errorEl.style.display = "none";
        const base64 = await fileToBase64(file);
        onPhoto(base64);
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.style.display = "block";
      }
    });
  }

  function renderLoading(inner, message) {
    inner.innerHTML = `
      <div class="atw-status">
        <div class="atw-spinner"></div>
        ${message}
      </div>
    `;
  }

  function renderError(inner, message, retry) {
    inner.innerHTML = `
      <p class="atw-title">Something went wrong</p>
      <p class="atw-subtitle atw-error" style="display:block">${message}</p>
      <button class="atw-btn">Try Again</button>
    `;
    inner.querySelector(".atw-btn").addEventListener("click", retry);
  }

  function renderResult(inner, imageUrl, onReset) {
    inner.innerHTML = `
      <p class="atw-title">Here's the look</p>
      <img class="atw-result-img" src="${imageUrl}" alt="Try-on result" />
      <button class="atw-secondary">Use a different photo</button>
    `;
    inner.querySelector(".atw-secondary").addEventListener("click", onReset);
  }

  async function runTryOn(inner, item, avatar) {
    renderLoading(inner, "Generating your look — this takes 10–20 seconds…");
    try {
      const result = await apiCall("tryon", {
        avatar_id: avatar.avatar_id,
        items: [{ image_url: item.imageUrl, category: item.category, description: item.description }],
        styling_note: item.stylingNote || undefined,
      });
      renderResult(inner, result.image_url, () => {
        localStorage.removeItem("almari_avatar_id");
        localStorage.removeItem("almari_avatar_url");
        startFlow(inner, item);
      });
    } catch (e) {
      renderError(inner, e.message, () => runTryOn(inner, item, avatar));
    }
  }

  async function createAvatarFromPhoto(inner, item, base64) {
    renderLoading(inner, "Building your avatar…");
    try {
      const uploadRes = await apiCall("upload-image", { image_base64: base64, kind: "user_photo" });
      const avatarRes = await apiCall("create-avatar", {
        external_user_id: getExternalUserId(),
        photo_url: uploadRes.image_url,
        gender: config.gender,
      });
      storeAvatar(avatarRes.avatar_id, avatarRes.avatar_url);
      await runTryOn(inner, item, avatarRes);
    } catch (e) {
      renderError(inner, e.message, () => startFlow(inner, item));
    }
  }

  function startFlow(inner, item) {
    const existing = getStoredAvatar();
    if (existing) {
      runTryOn(inner, item, existing);
    } else {
      renderUpload(inner, (base64) => createAvatarFromPhoto(inner, item, base64));
    }
  }

  function openTryOn(item) {
    injectStyle();
    const { inner } = buildModal();
    startFlow(inner, item);
  }

  function attach(el, item) {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      openTryOn(item);
    });
  }

  function scanAndAttach(root) {
    (root || document).querySelectorAll("[data-almari-tryon]").forEach((el) => {
      if (el.dataset.atwBound) return;
      el.dataset.atwBound = "1";
      attach(el, {
        imageUrl: el.dataset.imageUrl,
        category: el.dataset.category,
        description: el.dataset.description,
        stylingNote: el.dataset.stylingNote,
      });
    });
  }

  window.AlmariTryOn = {
    init(opts) {
      config = Object.assign(config, opts);
      scanAndAttach(document);
    },
    open: openTryOn,
    attach,
  };
})(window, document);
