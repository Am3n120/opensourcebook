/** The shortcut a person clicks: an app in the Mac's Applications folder, an entry in the Linux apps menu. Windows gets its own from the PowerShell installer. */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { layout } from "./paths.mjs";
import { shWord } from "./shims.mjs";

export function macAppFiles(home, execPath = process.execPath) {
  const shim = join(layout(home).bin, "opensourcebook");
  // An app opened from the Finder gets a short PATH, so the Node that installed this and the usual places are added.
  const script = `#!/bin/sh
# Open Sourcebook: starts it if it is not running and opens it in the browser.
PATH=${shWord(dirname(execPath))}:/opt/homebrew/bin:/usr/local/bin:"$PATH"
export PATH
${shWord(shim)} && exit 0
osascript -e 'display dialog "Open Sourcebook could not start. Open the Terminal app, type opensourcebook and press Return to see why." buttons {"OK"} default button 1 with title "Open Sourcebook"' >/dev/null 2>&1
exit 1
`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Open Sourcebook</string>
  <key>CFBundleDisplayName</key><string>Open Sourcebook</string>
  <key>CFBundleIdentifier</key><string>app.opensourcebook.launcher</string>
  <key>CFBundleExecutable</key><string>opensourcebook</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
  return { script, plist };
}

export function desktopEntry(home) {
  const shim = join(layout(home).bin, "opensourcebook");
  const quoted = `"${shim.replace(/(["\\`$])/g, "\\$1")}"`;
  return ["[Desktop Entry]", "Type=Application", "Name=Open Sourcebook", "Comment=Turn your sources into cited answers, quizzes, audio and short videos", `Exec=${quoted}`, "Terminal=false", "Categories=Education;Office;", ""].join("\n");
}

/** Makes the shortcut and returns where it is, or nothing when this computer gets none from here. */
export function makeShortcut({ home, env = process.env, platform = process.platform, userHome = homedir(), execPath = process.execPath }) {
  if (env.OPENSOURCEBOOK_NO_SHORTCUT === "1") return undefined;
  if (platform === "darwin") {
    const bundle = join(userHome, "Applications", "Open Sourcebook.app");
    const { script, plist } = macAppFiles(home, execPath);
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(bundle, "Contents", "Info.plist"), plist);
    writeFileSync(join(bundle, "Contents", "MacOS", "opensourcebook"), script);
    chmodSync(join(bundle, "Contents", "MacOS", "opensourcebook"), 0o755);
    return bundle;
  }
  if (platform === "linux") {
    const file = join(userHome, ".local", "share", "applications", "opensourcebook.desktop");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, desktopEntry(home));
    chmodSync(file, 0o755);
    return file;
  }
  return undefined;
}
