"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const DEFAULT_DISPLAY_NAME = "GovChat Orchestrator";
const MAX_NAME_LENGTH = 100;
const PUBLIC_FILENAME = "orchestrator-name.json";

function validateName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_NAME_LENGTH ||
      /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}<>]/u.test(value)) {
    throw new Error("Naam moet niet-lege platte tekst zijn, maximaal 100 tekens, zonder controletekens of HTML");
  }
  return value.trim();
}

function validateMetadata(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "display_name,max_length,source,version" ||
      value.version !== 1 || value.max_length !== MAX_NAME_LENGTH || !["admin", "environment", "default"].includes(value.source)) {
    throw new Error("Ongeldige publieke naammetadata");
  }
  return { version: 1, display_name: validateName(value.display_name), source: value.source, max_length: MAX_NAME_LENGTH };
}

function createNameStore({ dataDir, publishDir, env = process.env }) {
  const directory = path.resolve(dataDir, "private");
  const publicDirectory = path.resolve(publishDir);
  if (directory === publicDirectory || directory.startsWith(publicDirectory + path.sep)) throw new Error("Overrideopslag mag niet publiek zijn");
  const filename = path.join(directory, PUBLIC_FILENAME);
  const publicFilename = path.join(publicDirectory, PUBLIC_FILENAME);
  function rejectSymlinks() {
    for (const target of [directory, filename, publicDirectory, publicFilename]) {
      try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error("Naamopslag mag geen symlink zijn"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  function atomicWrite(target, value, mode) {
    const temporary = path.join(path.dirname(target), `.name-${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode, flag: "wx" });
      fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  function fallback() {
    const value = env.N8N_ORCHESTRATOR_DISPLAY_NAME;
    return value === undefined || value === "" ? { display_name: DEFAULT_DISPLAY_NAME, source: "default" } :
      { display_name: validateName(value), source: "environment" };
  }
  function read() {
    rejectSymlinks();
    let value;
    try {
      const stored = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (!stored || Object.keys(stored).sort().join(",") !== "display_name,version" || stored.version !== 1) throw new Error("Ongeldige override");
      value = { display_name: validateName(stored.display_name), source: "admin" };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("Naamoverride ongeldig of onleesbaar; herstel of reset vereist");
      value = fallback();
    }
    const metadata = validateMetadata({ version: 1, ...value, max_length: MAX_NAME_LENGTH });
    fs.mkdirSync(publicDirectory, { recursive: true });
    // Whitelist only public name metadata. Never spread prompt/config/environment objects here.
    const serialized = JSON.stringify(metadata);
    let previous;
    try { previous = fs.readFileSync(publicFilename, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous !== serialized) atomicWrite(publicFilename, metadata, 0o644);
    return metadata;
  }
  function save(value) {
    const display_name = validateName(value);
    rejectSymlinks();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    atomicWrite(filename, { version: 1, display_name }, 0o600);
    return read();
  }
  function reset() {
    fallback();
    rejectSymlinks();
    fs.rmSync(filename, { force: true });
    return read();
  }
  return { read, save, reset, filename, publicFilename };
}

module.exports = { DEFAULT_DISPLAY_NAME, MAX_NAME_LENGTH, PUBLIC_FILENAME, validateName, validateMetadata, createNameStore };
