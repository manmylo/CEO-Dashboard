// Regenerates public/version.json with a fresh timestamp before every
// hosting deploy (see firebase.json's hosting.predeploy) -- page-shell.js
// polls this file and auto-reloads anyone currently on the page once it
// changes, so a deploy doesn't leave people running stale JS until they
// happen to manually refresh.
const fs = require("fs");
const path = require("path");

fs.writeFileSync(
  path.join(__dirname, "..", "public", "version.json"),
  JSON.stringify({ v: new Date().toISOString() })
);
