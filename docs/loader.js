/* Reconstitutes the original EaglercraftX offline build without modifying game code. */
(() => {
  "use strict";
  const parts = ["/Xushi-Body-Contorl-Eaglercraft/client.part01", "/Xushi-Body-Contorl-Eaglercraft/client.part02", "/Xushi-Body-Contorl-Eaglercraft/client.part03", "/Xushi-Body-Contorl-Eaglercraft/client.part04"];
  let began = false;
  const message = (txt) => {
    let el = document.getElementById("split-status");
    if (!el) {
      el = document.createElement("p"); el.id = "split-status";
      el.style.cssText = "position:fixed;bottom:0;left:0;right:0;background:#111;color:white;padding:12px;font:14px sans-serif;z-index:99999";
      document.body.appendChild(el);
    }
    el.textContent = txt;
  };
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = url;
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Cannot load " + url));
      document.head.appendChild(el);
    });
  }
  async function launch() {
    if (began) return;
    began = true;
    try {
      if (location.protocol === "file:") {
        throw new Error("Open with a local HTTP server or GitHub Pages, not file://");
      }
      message("Loading game code...");
      // Keep the pieces in source order; the combined Blob is bit-for-bit the original script.
      const buffers = [];
      for (const part of parts) {
        const response = await fetch(part);
        if (!response.ok) throw new Error("HTTP " + response.status + ": " + part);
        buffers.push(await response.blob());
      }
      // A Blob URL keeps the complete JS available for integrated-server worker loading.
      const scriptUrl = URL.createObjectURL(new Blob(buffers, {type:"text/javascript"}));
      await loadScript(scriptUrl);
      message("Loading game resources...");
      await loadScript("/Xushi-Body-Contorl-Eaglercraft/assets.js");
      const banner = document.getElementById("split-status");
      if (banner) banner.remove();
      // Original assets.js installs a window load handler. As external code is fetched
      // after the real load event, notify the now-installed handler once.
      window.dispatchEvent(new Event("load"));
    } catch (e) {
      message("Game failed to load: " + e.message);
      console.error(e);
    }
  }
  if (document.readyState === "complete") launch();
  else window.addEventListener("load", launch, {once:true});
})();
