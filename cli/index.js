#!/usr/bin/env node
"use strict";

/**
 * Scaffolding tool: writes a new, minimal store project as a SIBLING folder to
 * this framework repo, wired to it via a "file:" dependency. Argument parsing uses
 * commander (named in the proposal's technologies table; chosen over yargs because
 * it has zero sub-dependencies). It never imports the framework's runtime code
 * (src/, dist/), so the CLI itself needs no build step.
 */

const { Command } = require("commander");
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join, resolve, relative, basename } = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");

const frameworkRoot = resolve(__dirname, "..");
const { version } = require(join(frameworkRoot, "package.json"));

function renderTemplate(content, replacements) {
  let out = content;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.split(`__${key}__`).join(value);
  }
  return out;
}

function createProject(projectName) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectName)) {
    throw new Error(
      `Invalid project name "${projectName}": use lowercase letters, digits and dashes (it becomes the npm package name).`
    );
  }

  const distEntry = join(frameworkRoot, "dist", "index.js");
  if (!existsSync(distEntry)) {
    console.log("Framework is not built yet - running `npm run build` first...");
    execFileSync("npm", ["run", "build"], { cwd: frameworkRoot, stdio: "inherit", shell: true });
  }

  // Created as a sibling of the framework repo (e.g. ../my-store), so the
  // "file:" dependency path stays short and predictable no matter where the
  // command is invoked from.
  const targetDir = resolve(frameworkRoot, "..", projectName);
  if (existsSync(targetDir)) {
    throw new Error(`Directory already exists: ${targetDir}`);
  }
  mkdirSync(targetDir, { recursive: true });

  const templatesDir = join(__dirname, "templates");
  const frameworkPath = relative(targetDir, frameworkRoot).split("\\").join("/");
  const replacements = { PROJECT_NAME: projectName, FRAMEWORK_PATH: frameworkPath };

  const files = [
    ["package.json.template", "package.json"],
    ["env.template", ".env.example"],
    ["index.js.template", "index.js"],
    ["migrate.js.template", "migrate.js"],
    ["gitignore.template", ".gitignore"],
  ];
  for (const [template, outName] of files) {
    const content = renderTemplate(readFileSync(join(templatesDir, template), "utf8"), replacements);
    writeFileSync(join(targetDir, outName), content);
  }

  // A ready .env with freshly generated secrets, so the only value left to fill
  // in is the database URL. (.env is in the generated .gitignore.)
  const env = renderTemplate(readFileSync(join(templatesDir, "env.template"), "utf8"), replacements)
    .replace(/^OWNER_API_KEY=.*$/m, `OWNER_API_KEY=${randomBytes(32).toString("hex")}`)
    .replace(/^AUTH_TOKEN_SECRET=.*$/m, `AUTH_TOKEN_SECRET=${randomBytes(32).toString("hex")}`);
  writeFileSync(join(targetDir, ".env"), env);

  console.log(`Created ${basename(targetDir)}/ at ${targetDir}`);
  console.log("A .env with random OWNER_API_KEY and AUTH_TOKEN_SECRET was generated.");
  console.log("Next steps:");
  console.log(`  cd ${relative(process.cwd(), targetDir) || "."}`);
  console.log("  npm install");
  console.log("  # set DATABASE_URL in .env to an existing PostgreSQL database");
  console.log("  npm run migrate");
  console.log("  npm start");
}

const program = new Command();

program
  .name("commerce-cli")
  .description("Scaffolding tool for the commerce framework")
  .version(version);

program
  .command("create")
  .description("create a new store project next to the framework folder")
  .argument("<project-name>", "folder and npm package name for the new project")
  .action((projectName) => {
    try {
      createProject(projectName);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });

program.parse();
