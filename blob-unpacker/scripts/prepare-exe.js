"use strict";

const fs = require("fs");
const path = require("path");

const entry = path.join(__dirname, "..", "dist", "index.js");
let content = fs.readFileSync(entry, "utf8");

if (!content.startsWith("#!")) {
  content = "#!/usr/bin/env node\n" + content;
  fs.writeFileSync(entry, content);
}
