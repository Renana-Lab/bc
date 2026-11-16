import fs from "fs";
import path from "path";

const projectRoot = path.resolve(__dirname, "..");
const fontUrl = "/fonts/manrope-variable-latin.woff2";

describe("production typography assets", () => {
  test("ships the application font from the public directory", () => {
    const fontPath = path.join(
      projectRoot,
      "public",
      "fonts",
      "manrope-variable-latin.woff2",
    );

    expect(fs.existsSync(fontPath)).toBe(true);
    expect(fs.statSync(fontPath).size).toBeGreaterThan(10000);
  });

  test("uses and preloads the same deployment-safe font URL", () => {
    const craHtml = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
    const viteHtml = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");

    expect(craHtml).toContain('font-family: "Manrope"');
    expect(viteHtml).toContain('font-family: "Manrope"');
    expect(craHtml).toContain(`%PUBLIC_URL%${fontUrl}`);
    expect(viteHtml).toContain(`url("${fontUrl}")`);
  });

  test("the font file is a real woff2 (wOF2 signature), not an HTML fallback", () => {
    const candidates = [path.join(projectRoot, "public", "fonts", "manrope-variable-latin.woff2")];
    // The built artifact is git-ignored; check it whenever a build exists locally or in CI.
    const built = path.join(projectRoot, "build", "fonts", "manrope-variable-latin.woff2");
    if (fs.existsSync(path.join(projectRoot, "build", "index.html"))) candidates.push(built);

    for (const file of candidates) {
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file).subarray(0, 4).toString("latin1")).toBe("wOF2");
    }
  });

  test("the documented Amplify SPA rewrite lets .woff2 through to the file", () => {
    const doc = fs.readFileSync(path.join(projectRoot, "docs", "AMPLIFY_REWRITES.md"), "utf8");
    // Tolerate CRLF checkouts (Windows autocrlf): the rewrite rule sits on its own line either way.
    const match = doc.match(/\r?\n<\/(\^.+)\/>\r?\n/);
    expect(match).not.toBeNull();
    const rewrite = new RegExp(match[1]);
    expect(rewrite.test("/fonts/manrope-variable-latin.woff2")).toBe(false); // served as a file
    expect(rewrite.test("/auctions")).toBe(true); // SPA routes still rewrite
    expect(rewrite.test("/static/js/main.abc.js")).toBe(false);
  });

  test("customHttp.yml serves .woff2 as a font", () => {
    const headers = fs.readFileSync(path.join(projectRoot, "customHttp.yml"), "utf8");
    expect(headers).toContain("/fonts/*.woff2");
    expect(headers).toContain("font/woff2");
  });
});
