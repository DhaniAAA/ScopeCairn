#!/usr/bin/env node
// Generate CHANGELOG.md from git history between the previous tag and HEAD.
// Usage: node scripts/changelog.js [version]   (default: "Unreleased")
import { execSync } from "node:child_process";
import fs from "node:fs";

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const version = process.argv[2] || "Unreleased";
const prev = run("git describe --tags --abbrev=0 --match 'v*'");
const range = prev ? `${prev}..HEAD` : "HEAD";
const entries = run(`git log ${range} --pretty=format:"- %s (%h)"`);
const date = new Date().toISOString().slice(0, 10);

const header = "# Changelog\n\n";
let body = fs.existsSync("CHANGELOG.md") ? fs.readFileSync("CHANGELOG.md", "utf8") : "";
if (body.startsWith(header)) body = body.slice(header.length);
// Drop a leading "## Unreleased" section so regenerating doesn't stack them.
body = body.replace(/^## Unreleased \([^)]*\)\n(?:\n(?:- .*\n?)*)?/, "");

const section = `## ${version} (${date})\n\n${entries || "- (no commits)"}\n\n`;
fs.writeFileSync("CHANGELOG.md", header + section + body);
console.log(`CHANGELOG.md updated: ${version} (${range})`);
