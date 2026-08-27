import fs from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: npm run version:set -- 1.0.1");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(fs.readFileSync("versions.json", "utf8"));
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));

manifest.version = version;
packageJson.version = version;
versions[version] = manifest.minAppVersion;

fs.writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
fs.writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);

console.log(`Version updated to ${version}`);
