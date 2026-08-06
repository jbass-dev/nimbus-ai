// electron-builder's extraResources copier silently skips nested
// node_modules directories, so the Next.js standalone server's own
// node_modules never makes it into the packaged app. Copy it in manually
// once packaging finishes but before the installer is built.
const fs = require("fs");
const path = require("path");

module.exports = async function afterPack(context) {
  const src = path.join(context.packager.projectDir, ".next", "standalone", "node_modules");
  const dest = path.join(context.appOutDir, "resources", "standalone", "node_modules");
  fs.cpSync(src, dest, { recursive: true });
};
