"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const DEFAULT_PROMPT = require("./orchestrator-prompt-default.json");
const MAX_PROMPT_LENGTH = 32000;

function validatePrompt(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Masterprompt moet een niet-lege tekst zijn");
  }
  if (value.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Masterprompt mag maximaal ${MAX_PROMPT_LENGTH} tekens bevatten`);
  }
  return value; // Preserve whitespace and multiline text exactly; never evaluate it.
}

function createPromptStore({ dataDir, publishDir, env = process.env }) {
  const directory = path.resolve(dataDir, "private");
  const publicDirectory = path.resolve(publishDir);
  if (directory === publicDirectory || directory.startsWith(publicDirectory + path.sep)) {
    throw new Error("Private promptopslag mag niet in de publicatiemap staan");
  }
  const filename = path.join(directory, "orchestrator-prompt.json");

  function rejectSymlinks() {
    for (const target of [directory, filename]) {
      try {
        if (fs.lstatSync(target).isSymbolicLink()) throw new Error("Private promptopslag mag geen symlink zijn");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  function fallback() {
    const value = env.N8N_ORCHESTRATOR_MASTER_PROMPT;
    // Compose supplies an empty value when no environment override is configured.
    if (value === undefined || value === "") return { prompt: DEFAULT_PROMPT, source: "default" };
    return { prompt: validatePrompt(value), source: "environment" };
  }

  function read() {
    rejectSymlinks();
    let raw;
    try { raw = fs.readFileSync(filename, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") return { ...fallback(), max_length: MAX_PROMPT_LENGTH };
      throw new Error("Private masterpromptconfiguratie is niet leesbaar");
    }
    try {
      const stored = JSON.parse(raw);
      if (!stored || stored.version !== 1 || Object.keys(stored).sort().join(",") !== "prompt,version") throw new Error();
      return { prompt: validatePrompt(stored.prompt), source: "admin", max_length: MAX_PROMPT_LENGTH };
    } catch {
      throw new Error("Private masterpromptconfiguratie is ongeldig; herstel of reset deze expliciet");
    }
  }

  function save(value) {
    const prompt = validatePrompt(value);
    rejectSymlinks();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporary = path.join(directory, `.prompt-${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, prompt }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, filename);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return read();
  }

  function reset() {
    fallback(); // Do not remove an override if the environment fallback is invalid.
    rejectSymlinks();
    fs.rmSync(filename, { force: true });
    return read();
  }

  return { read, save, reset, filename };
}

module.exports = { DEFAULT_PROMPT, MAX_PROMPT_LENGTH, validatePrompt, createPromptStore };
