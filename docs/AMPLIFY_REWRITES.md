# Amplify SPA rewrite must not swallow `.woff2`

Symptom: `GET /fonts/manrope-variable-latin.woff2` on the Amplify app returns `index.html` (200, `text/html`), so the
browser rejects the font ("OTS parsing error") and falls back to a system font. The file itself is valid and is shipped
in `build/fonts/` (see `src/typographyAssets.test.js`).

Cause: Amplify's stock single-page-app rewrite excludes only a fixed list of extensions:

```
</^[^.]+$|\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|ttf|map|json)$)([^.]+$)/>   ->  /index.html   (200 Rewrite)
```

`woff2` is not in the list, so it is rewritten to `index.html`.

## Fix (Amplify console, per app: production AND the spike/test app)

App settings -> Rewrites and redirects -> edit the SPA rule's **Source address** to add `woff2` (and `webp`, `mp4`, `pdf` if used):

```
</^[^.]+$|\.(?!(css|gif|ico|jpg|jpeg|js|png|txt|svg|webp|woff|woff2|ttf|otf|eot|map|json|webmanifest|xml|pdf)$)([^.]+$)/>
```

Target `/index.html`, type `200 (Rewrite)`. Rewrites are not read from the repository, so this is a console change
(or `aws amplify update-app --custom-rules ...`). `customHttp.yml` in the repo root only sets headers for `/fonts/*.woff2`.

## Verify after the next deploy

```bash
curl -sI https://<amplify-domain>/fonts/manrope-variable-latin.woff2   # expect content-type: font/woff2
curl -s  https://<amplify-domain>/fonts/manrope-variable-latin.woff2 | head -c 4   # expect wOF2
```
