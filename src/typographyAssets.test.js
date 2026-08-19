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
});
