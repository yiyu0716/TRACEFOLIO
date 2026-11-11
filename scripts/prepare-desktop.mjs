import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const root = resolve("."),
  backend = join(root, ".desktop/backend");
if (!existsSync(".next/standalone/server.js"))
  throw new Error("Run npm run build before preparing desktop");
await rm(join(root, ".desktop"), { recursive: true, force: true });
await mkdir(backend, { recursive: true });
await cp(".next/standalone", backend, {
  recursive: true,
  filter: (source) => !/(^|[/\\])\.env(?:\.|$)|\.db(?:-|$)|\.pem$/.test(source),
});
for (const [source, destination] of [
  [".next/static", ".next/static"],
  ["public", "public"],
  ["prisma", "prisma"],
  ["scripts/migrate.mjs", "scripts/migrate.mjs"],
  ["desktop/server.mjs", "runtime/desktop-server.mjs"],
  ["desktop/security.cjs", "runtime/security.cjs"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
]) {
  await cp(source, join(backend, destination), {
    recursive: true,
    filter: (p) => !/\.db(?:-|$)/.test(p),
  });
}
// Next tracing does not see the dynamically spawned CLI or worker dependencies.
for (const name of [
  "@prisma",
  ".prisma",
  "prisma",
  "@openai/codex",
  "@openai/codex-sdk",
]) {
  await cp(join("node_modules", name), join(backend, "node_modules", name), {
    recursive: true,
  });
}
// The Prisma CLI is invoked at first launch, outside Next's traced import graph.
// Copy its full installed dependency closure, preserving hoisted/nested locations.
const included = new Set();
async function includePackage(packageJson) {
  const source = dirname(packageJson);
  if (included.has(source)) return;
  included.add(source);
  const location = relative(join(root, "node_modules"), source);
  if (location.startsWith(`..${sep}`) || location === "..")
    throw new Error("Desktop dependency escapes node_modules");
  await cp(source, join(backend, "node_modules", location), {
    recursive: true,
  });
  const manifest = JSON.parse(await readFile(packageJson, "utf8"));
  const require = createRequire(packageJson);
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    let dependency;
    try {
      dependency = require.resolve(`${name}/package.json`);
    } catch {
      let dir = dirname(require.resolve(name));
      while (true) {
        const candidate = join(dir, "package.json");
        if (
          existsSync(candidate) &&
          JSON.parse(await readFile(candidate, "utf8")).name === name
        ) {
          dependency = candidate;
          break;
        }
        const parent = dirname(dir);
        if (parent === dir)
          throw new Error(`Cannot resolve desktop dependency ${name}`);
        dir = parent;
      }
    }
    await includePackage(dependency);
  }
}
await includePackage(join(root, "node_modules/prisma/package.json"));
const target = process.env.TRACEFOLIO_DESKTOP_TARGET ?? process.platform;
const arch = process.env.TRACEFOLIO_DESKTOP_ARCH ?? process.arch;
const native =
  target === "darwin"
    ? `codex-darwin-${arch}`
    : target === "win32"
      ? `codex-win32-${arch}`
      : `codex-linux-${arch}`;
const nativePath = join("node_modules/@openai", native);
if (!existsSync(nativePath))
  throw new Error(
    `Missing target Codex runtime: ${native}. Build on the target OS/architecture.`,
  );
await cp(nativePath, join(backend, "node_modules/@openai", native), {
  recursive: true,
});
await build({
  entryPoints: ["desktop/worker.ts"],
  outfile: join(backend, "runtime/task-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@prisma/client", "@openai/codex", "@openai/codex-sdk"],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
// Traced modules and browser/worker bundles omit package-root license files.
// Include installed dependency notices, including those compiled into bundles.
const licenseRoot = join(backend, "third-party/package-licenses");
const notices = [];
async function includeNotices(modules) {
  if (!existsSync(modules)) return;
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const packageDirs = entry.name.startsWith("@")
      ? (await readdir(join(modules, entry.name), { withFileTypes: true }))
          .filter((item) => item.isDirectory())
          .map((item) => join(modules, entry.name, item.name))
      : [join(modules, entry.name)];
    for (const source of packageDirs) {
      const manifestPath = join(source, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const location = relative(join(root, "node_modules"), source);
      const files = (await readdir(source)).filter((name) =>
        /^(?:licen[cs]es?|notice|copying|copyright)(?:[._-].*)?$/i.test(name),
      );
      for (const file of files) {
        const destination = join(licenseRoot, location, file);
        await mkdir(dirname(destination), { recursive: true });
        await cp(join(source, file), destination, {
          recursive: true,
          dereference: true,
        });
      }
      notices.push({
        name: manifest.name,
        version: manifest.version,
        license: manifest.license ?? null,
        location: location.split(sep).join("/"),
        files,
      });
      await includeNotices(join(source, "node_modules"));
    }
  }
}
await includeNotices(join(root, "node_modules"));
await writeFile(
  join(backend, "third-party/dependencies.json"),
  JSON.stringify(notices, null, 2),
);
const cloudUrl = process.env.TRACEFOLIO_DESKTOP_CLOUD_URL ?? "";
if (cloudUrl) {
  const url = new URL(cloudUrl);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Packaged cloud URL must use HTTPS");
}
const config = {
  requireLicense: process.env.TRACEFOLIO_DESKTOP_REQUIRE_LICENSE === "1",
  cloudUrl,
};
if (config.requireLicense && !cloudUrl)
  throw new Error("Commercial desktop build requires a cloud URL");
await writeFile(
  join(backend, "desktop-config.json"),
  JSON.stringify(config, null, 2),
);
// Build staging must never contain developer secrets, DBs or career materials.
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const appDir = join(root, ".desktop/app");
await mkdir(join(appDir, "desktop"), { recursive: true });
for (const source of [
  "desktop/main.cjs",
  "desktop/security.cjs",
  "LICENSE",
  "NOTICE",
])
  await cp(source, join(appDir, source));
await writeFile(
  join(appDir, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      author: pkg.author,
      license: pkg.license,
      main: "desktop/main.cjs",
    },
    null,
    2,
  ),
);
console.log(
  `Prepared TRACEFOLIO ${pkg.version} desktop backend for ${target}/${arch}.`,
);
