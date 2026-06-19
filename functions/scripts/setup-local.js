const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const examplePath = path.join(root, "local.settings.example.json");
const localPath = path.join(root, "local.settings.json");

function hasCommand(command, args) {
  const result = spawnSync(command, args, {
    stdio: "ignore",
  });
  return result.status === 0;
}

if (!fs.existsSync(localPath)) {
  fs.copyFileSync(examplePath, localPath);
  console.log("Created functions/local.settings.json from the example.");
  console.log("Add your local SPEECH_KEY before requesting real Speech tokens.");
} else {
  console.log("functions/local.settings.json already exists; leaving it untouched.");
}

const packagedFuncPath = path.join(
  root,
  "node_modules",
  "azure-functions-core-tools",
  "bin",
  process.platform === "win32" ? "func.exe" : "func"
);
const localFuncPath = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "func.cmd" : "func"
);
const funcCommand = fs.existsSync(packagedFuncPath)
  ? packagedFuncPath
  : fs.existsSync(localFuncPath)
  ? localFuncPath
  : process.platform === "win32"
    ? "func.cmd"
    : "func";

if (!hasCommand(funcCommand, ["--version"])) {
  console.warn("Azure Functions Core Tools was not found.");
  console.warn("Install it before running npm start in the functions folder.");
}
