# EaglercraftX split web build

This is a byte-preserving split of the supplied offline `index.html.html` into separate files smaller than 25 MB each.

## Run

Keep all files in **the same directory**. Host the folder on GitHub Pages (or any HTTP/HTTPS static server) and open `index.html`. The browser fetches the `client.partXX` files in order, assembles the **unaltered** game code into a Blob script, and then loads `assets.js`.

For a local test (Python installed):

```bash
python -m http.server 8000
```

Open http://localhost:8000/

**Do not open `index.html` as a `file://` URL.** Browser security policies block local `fetch()` for the file chunks.

## Notes

- All split pieces must be uploaded together, with their original names.
- This changes the loading mechanism; the original game code and embedded asset data are left unmodified.
- The game may require a modern browser and some environments may restrict Blob-based Workers.
- Respect the original project's licenses and any applicable rights before public distribution.


注意：本版本采用网站根路径（/loader.js、/assets.js、/client.partXX），仅适合部署在域名根目录。若使用 GitHub Pages 项目站点 /仓库名/，需要改用相对路径或添加仓库名前缀。

## GitHub Pages project path

This build uses the absolute base path `/Xushi-Body-Contorl-Eaglercraft/`. Upload all files to the repository root named **Xushi-Body-Contorl-Eaglercraft**. The GitHub Pages URL is `https://<username>.github.io/Xushi-Body-Contorl-Eaglercraft/`. Do not rename the repository without updating the paths in index.html and loader.js.
