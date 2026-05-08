// Copyright 2026, Ceeon and Agentfile contributors.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appName = "Agentfile";
const bundleId = "dev.ceeon.agentfile.dev";
const defaultExecutableName = "Electron";
const executableName = appName;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const electronPackageDir = path.join(repoRoot, "node_modules/electron");
const electronDistDir = path.join(electronPackageDir, "dist");
const defaultAppBundleName = "Electron.app";
const appBundleName = `${appName}.app`;
const defaultElectronApp = path.join(electronDistDir, defaultAppBundleName);
const electronApp = path.join(electronDistDir, appBundleName);
const infoPlistPath = path.join(electronApp, "Contents/Info.plist");
const macosDir = path.join(electronApp, "Contents/MacOS");
const defaultExecutablePath = path.join(macosDir, defaultExecutableName);
const executablePath = path.join(macosDir, executableName);
const iconSourcePath = path.join(repoRoot, "build/icon.icns");
const iconTargetPath = path.join(electronApp, "Contents/Resources/icon.icns");
const electronPathFile = path.join(electronPackageDir, "path.txt");

function die(message) {
    console.error(`[prepare-electron-dev-app] ${message}`);
    process.exit(1);
}

function replacePlistValue(plist, key, value) {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
    if (re.test(plist)) {
        return plist.replace(re, `$1${value}$3`);
    }
    const dictEndIdx = plist.lastIndexOf("</dict>");
    if (dictEndIdx === -1) {
        die(`invalid Info.plist; missing closing dict`);
    }
    return `${plist.slice(0, dictEndIdx)}\t<key>${key}</key>\n\t<string>${value}</string>\n${plist.slice(dictEndIdx)}`;
}

function findExistingAppBundle() {
    if (fs.existsSync(defaultElectronApp)) {
        return defaultElectronApp;
    }
    if (!fs.existsSync(electronDistDir)) {
        return null;
    }
    const appBundle = fs
        .readdirSync(electronDistDir)
        .find((entry) => entry.endsWith(".app") && fs.statSync(path.join(electronDistDir, entry)).isDirectory());
    return appBundle ? path.join(electronDistDir, appBundle) : null;
}

if (process.platform !== "darwin") {
    process.exit(0);
}

let changed = false;
if (!fs.existsSync(electronApp)) {
    const existingAppBundle = findExistingAppBundle();
    if (!existingAppBundle) {
        die(`missing Electron app bundle in ${electronDistDir}; run npm install first`);
    }
    fs.renameSync(existingAppBundle, electronApp);
    changed = true;
}

if (!fs.existsSync(iconSourcePath)) {
    die(`missing app icon at ${iconSourcePath}`);
}

let plist = fs.readFileSync(infoPlistPath, "utf8");
const nextPlist = [
    ["CFBundleDisplayName", appName],
    ["CFBundleExecutable", executableName],
    ["CFBundleIconFile", "icon.icns"],
    ["CFBundleIdentifier", bundleId],
    ["CFBundleName", appName],
].reduce((current, [key, value]) => replacePlistValue(current, key, value), plist);

if (nextPlist !== plist) {
    fs.writeFileSync(infoPlistPath, nextPlist);
    changed = true;
}

const sourceIcon = fs.readFileSync(iconSourcePath);
const targetIcon = fs.existsSync(iconTargetPath) ? fs.readFileSync(iconTargetPath) : null;
if (!targetIcon || !sourceIcon.equals(targetIcon)) {
    fs.copyFileSync(iconSourcePath, iconTargetPath);
    changed = true;
}

const sourceExecutable = fs.readFileSync(defaultExecutablePath);
const targetExecutable = fs.existsSync(executablePath) ? fs.readFileSync(executablePath) : null;
if (!targetExecutable || !sourceExecutable.equals(targetExecutable)) {
    fs.copyFileSync(defaultExecutablePath, executablePath);
    fs.chmodSync(executablePath, fs.statSync(defaultExecutablePath).mode);
    changed = true;
}

const electronPath = `${appBundleName}/Contents/MacOS/${executableName}`;
const currentElectronPath = fs.existsSync(electronPathFile) ? fs.readFileSync(electronPathFile, "utf8") : "";
if (currentElectronPath !== electronPath) {
    fs.writeFileSync(electronPathFile, electronPath);
    changed = true;
}

console.log(`[prepare-electron-dev-app] ${changed ? "branded" : "already branded"} ${electronApp}`);
