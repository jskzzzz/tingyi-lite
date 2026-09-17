import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("responsive Web layout contracts", () => {
  it("places a mobile caption stage before session metrics and hides the desktop duplicate", async () => {
    const [app, styles] = await Promise.all([
      readFile("src/web/App.tsx", "utf8"),
      readFile("src/web/styles.css", "utf8")
    ]);

    const mobileStage = app.indexOf('className="mobile-caption-stage"');
    const statusGrid = app.indexOf('className="status-grid"');
    expect(mobileStage).toBeGreaterThan(0);
    expect(mobileStage).toBeLessThan(statusGrid);
    expect(app).toContain('className="desktop-caption-stage"');
    expect(styles).toContain(".caption-stage.mobile-caption-stage");
    expect(styles).toContain(".caption-stage.desktop-caption-stage");
  });

  it("bounds mobile overlay content and preserves full caption wrapping", async () => {
    const [app, styles] = await Promise.all([
      readFile("src/web/App.tsx", "utf8"),
      readFile("src/web/styles.css", "utf8")
    ]);

    expect(styles).toContain("height: 100dvh");
    expect(styles).toContain("max-height: calc(100dvh - 10vh)");
    expect(styles).toContain("flex-direction: column-reverse");
    expect(styles).toContain(".overlay-caption-roll");
    expect(styles).toContain("overflow-wrap: anywhere");
    expect(styles).toContain(".history-caption-item > p");
    expect(app).toContain("onTimeUpdate={(event) => setSessionPlaybackMs");
    expect(app).toContain("onEnded={continueSessionPlayback}");
    expect(app).toContain("onClick={() => playSessionCaption(segment)}");
    expect(app).toContain("<h2>历史任务</h2>");
    expect(app).not.toContain("转写质检");
  });

  it("renders the configured translation switch and bilingual live captions in both overlays", async () => {
    const [app, api, overlay, styles] = await Promise.all([
      readFile("src/web/App.tsx", "utf8"),
      readFile("src/web/api.ts", "utf8"),
      readFile("src/web/OverlayView.tsx", "utf8"),
      readFile("src/web/styles.css", "utf8")
    ]);

    expect(app).toContain('aria-label="开启中文翻译"');
    expect(app).toContain("saveTranslationEnabled");
    expect(app).toContain('className="translation-config-form"');
    expect(app).toContain('type="password"');
    expect(app).toContain("saveTranslationModel");
    expect(app).toContain("lines={liveCaptionLines}");
    expect(app).toContain('className="context-translation"');
    expect(api).toContain('"/api/translation-settings"');
    expect(api).toContain('"/api/translation-model"');
    expect(overlay).toContain('className="overlay-caption-roll"');
    expect(overlay).toContain('className="overlay-caption-translation"');
    expect(styles).toContain(".switch-control input:checked + .switch-track");
    expect(styles).toContain(".translation-config-form");
    expect(styles).toContain(".caption-roll-translation");
    expect(styles).toContain(".overlay-caption-translation");
    expect(app).toContain("selectLiveCaptionLines");
    expect(overlay).toContain("selectLiveCaptionLines");
    expect(styles).toMatch(/\.caption-roll \{[^}]*flex-direction: column-reverse;[^}]*overflow: hidden;/s);
    expect(api).toContain('addEventListener("caption.preview"');
  });

  it("keeps operation feedback visible and primary switches touch-friendly", async () => {
    const [app, styles] = await Promise.all([
      readFile("src/web/App.tsx", "utf8"),
      readFile("src/web/styles.css", "utf8")
    ]);

    expect(app).toContain('className="operation-status" role="status" aria-live="polite"');
    expect(styles).toMatch(/\.switch-control \{[^}]*width: 44px;[^}]*height: 44px;/s);
    expect(styles).toMatch(/\.segmented-control \{[^}]*min-height: 48px;/s);
    expect(styles).toMatch(/\.history-session-button,[^}]*\.history-chunk-button \{[^}]*min-height: 40px;/s);
    expect(styles).toContain(".top-band .operation-status");
  });

  it("keeps browser recording independent from the two selectable caption sources", async () => {
    const [app, api, plan] = await Promise.all([
      readFile("src/web/App.tsx", "utf8"),
      readFile("src/web/api.ts", "utf8"),
      readFile("src/capture/plan.ts", "utf8")
    ]);

    expect(app).not.toContain("cloud-asr");
    expect(api).not.toContain("/api/caption-input");
    expect(api).toContain("/api/audio-chunks/");
    expect(plan).toContain('{ kind: "local-asr"');
    expect(plan).toContain('{ kind: "system-captions"');
    expect(plan).not.toContain("cloud-asr");
    expect(app).not.toContain("MoonshinePreviewCapture");
    expect(app).not.toContain("uploadMoonshinePreview");
    expect(api).not.toContain("/api/moonshine-preview");
  });

  it("keeps the three-state theme switch wired to the stored preference", async () => {
    const [app, styles, html] = await Promise.all([
      readFile("src/web/App.tsx", "utf8"),
      readFile("src/web/styles.css", "utf8"),
      readFile("index.html", "utf8")
    ]);

    expect(app).toContain('const THEME_STORAGE_KEY = "tingyi-lite-theme"');
    expect(app).toContain('selectThemeMode("auto")');
    expect(app).toContain('selectThemeMode("light")');
    expect(app).toContain('selectThemeMode("dark")');
    expect(app).toContain('className="theme-switch" role="group" aria-label="主题"');
    expect(app).toContain('media.addEventListener("change", applyTheme)');
    // 主题由 data-theme 决定，不靠 CSS 媒体查询，否则三态切换没法覆盖"跟随系统"。
    expect(styles).toContain(':root[data-theme="dark"]');
    expect(styles).toContain(".theme-switch {");
    expect(styles).not.toContain("@media (prefers-color-scheme: dark)");
    // 首屏脚本必须在 React 挂载前定下主题，避免深色系统上闪一下浅色。
    expect(html).toContain('localStorage.getItem("tingyi-lite-theme")');
    expect(html).toContain("document.documentElement.dataset.theme");
  });

  it("re-declares the narrow-screen console sizing after the console layer", async () => {
    const styles = await readFile("src/web/styles.css", "utf8");

    // V1 层写在文件末尾，会盖掉前面的媒体查询；窄屏尺寸必须在它之后再声明一次。
    const baseGutter = styles.indexOf("grid-template-columns: 54px");
    const narrowGutter = styles.indexOf("grid-template-columns: 44px");
    expect(baseGutter).toBeGreaterThan(0);
    expect(narrowGutter).toBeGreaterThan(baseGutter);
    expect(styles).toMatch(/@media \(max-width: 900px\) \{\s*\.live-layout \{\s*grid-template-columns: 1fr;/);
  });
});
